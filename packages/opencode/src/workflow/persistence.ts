import { Effect } from "effect"
import path from "path"
import { createHash } from "node:crypto"
import { appendFileSync, mkdirSync } from "node:fs"
import { eq, desc } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { WorkflowRunTable } from "@opencode-ai/core/workflow/sql"
import { Global } from "@opencode-ai/core/global"
import type { SessionID } from "@/session/schema"

function canonical(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(canonical)
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
  )
}

export function journalKeyBase(
  prompt: string,
  opts: {
    agentType?: string
    model?: unknown
    schema?: unknown
    phase?: string
    [k: string]: unknown
  },
): string {
  const material = canonical({
    prompt,
    agentType: opts.agentType ?? null,
    model: opts.model ?? null,
    schema: opts.schema ?? null,
    phase: opts.phase ?? null,
  })
  return createHash("sha256").update(JSON.stringify(material)).digest("hex")
}

export function journalKey(
  prompt: string,
  opts: {
    agentType?: string
    model?: unknown
    schema?: unknown
    phase?: string
    [k: string]: unknown
  },
  occ: number,
): string {
  return journalKeyBase(prompt, opts) + ":" + occ
}

export type JournalEvent =
  | { t: "agent"; key: string; result: unknown; pass: number }
  | { t: "log"; msg: string; pass: number }
  | { t: "phase"; title: string; pass: number }

export type JournalLoad = { results: Map<string, unknown>; pass: number }

export type RunSummary = {
  runID: string
  sessionID: SessionID
  name: string
  status: "running" | "completed" | "failed" | "cancelled"
  running: number
  succeeded: number
  failed: number
  currentPhase?: string
  parentActorID?: string
  args?: unknown
  scriptSha?: string
  agentTimeoutMs?: number
  error?: string
  createdAt: number
  updatedAt: number
}

const scriptDir = () => path.join(Global.Path.data, "workflow")

const RUN_ID = /^wf_[0-9A-Za-z]+$/
const safeRunID = (runID: string) => {
  if (!RUN_ID.test(runID)) throw new Error(`invalid workflow runID: ${JSON.stringify(runID)}`)
  return runID
}
const scriptPath = (runID: string) => path.join(scriptDir(), `${safeRunID(runID)}.js`)
const journalPath = (runID: string) => path.join(scriptDir(), `${safeRunID(runID)}.jsonl`)

function toSummary(row: typeof WorkflowRunTable.$inferSelect): RunSummary {
  return {
    runID: row.id,
    sessionID: row.session_id,
    name: row.name,
    status: row.status,
    running: row.running,
    succeeded: row.succeeded,
    failed: row.failed,
    ...(row.current_phase ? { currentPhase: row.current_phase } : {}),
    ...(row.parent_actor_id ? { parentActorID: row.parent_actor_id } : {}),
    ...(row.args !== null && row.args !== undefined ? { args: row.args } : {}),
    ...(row.script_sha ? { scriptSha: row.script_sha } : {}),
    ...(row.agent_timeout_ms !== null && row.agent_timeout_ms !== undefined ? { agentTimeoutMs: row.agent_timeout_ms } : {}),
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.time_created,
    updatedAt: row.time_updated,
  }
}

const recordStart = (input: {
  runID: string
  sessionID: SessionID
  name: string
  parentActorID?: string
  args?: unknown
  scriptSha?: string
  agentTimeoutMs?: number
}) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(WorkflowRunTable)
      .values({
        id: input.runID,
        session_id: input.sessionID,
        name: input.name,
        status: "running",
        running: 0,
        succeeded: 0,
        failed: 0,
        parent_actor_id: input.parentActorID ?? null,
        args: input.args ?? null,
        script_sha: input.scriptSha ?? null,
        agent_timeout_ms: input.agentTimeoutMs ?? null,
      })
      .onConflictDoUpdate({
        target: WorkflowRunTable.id,
        set: {
          status: "running",
          running: 0,
          succeeded: 0,
          failed: 0,
          script_sha: input.scriptSha ?? null,
          ...(input.agentTimeoutMs !== undefined ? { agent_timeout_ms: input.agentTimeoutMs } : {}),
        },
      })
      .run()
      .pipe(Effect.orDie)
  })

const recordPhase = (input: { runID: string; phase: string }) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.update(WorkflowRunTable).set({ current_phase: input.phase }).where(eq(WorkflowRunTable.id, input.runID)).run().pipe(Effect.orDie)
  })

const flushCounters = (input: { runID: string; running: number; succeeded: number; failed: number }) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .update(WorkflowRunTable)
      .set({ running: input.running, succeeded: input.succeeded, failed: input.failed })
      .where(eq(WorkflowRunTable.id, input.runID))
      .run()
      .pipe(Effect.orDie)
  })

const recordTerminal = (input: { runID: string; status: "completed" | "failed" | "cancelled"; error?: string }) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .update(WorkflowRunTable)
      .set({ status: input.status, ...(input.error ? { error: input.error } : {}) })
      .where(eq(WorkflowRunTable.id, input.runID))
      .run()
      .pipe(Effect.orDie)
  })

const list = (input?: { sessionID?: SessionID }) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const query = input?.sessionID
      ? db.select().from(WorkflowRunTable).where(eq(WorkflowRunTable.session_id, input.sessionID)).orderBy(desc(WorkflowRunTable.time_created)).all()
      : db.select().from(WorkflowRunTable).orderBy(desc(WorkflowRunTable.time_created)).all()
    const rows = yield* query.pipe(Effect.orDie)
    return rows.map(toSummary)
  })

const load = (runID: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const row = yield* db.select().from(WorkflowRunTable).where(eq(WorkflowRunTable.id, runID)).get().pipe(Effect.orDie)
    return row ? toSummary(row) : undefined
  })

const writeScript = (runID: string, body: string) =>
  Effect.promise(async () => {
    const fs = await import("fs/promises")
    await fs.mkdir(scriptDir(), { recursive: true })
    await Bun.write(scriptPath(runID), body)
  })

const readScript = (runID: string) => Effect.promise(() => Bun.file(scriptPath(runID)).text())

const appendJournal = (runID: string, event: JournalEvent) =>
  Effect.promise(async () => {
    const fs = await import("fs/promises")
    await fs.mkdir(scriptDir(), { recursive: true })
    await fs.appendFile(journalPath(runID), JSON.stringify(event) + "\n")
  })

const appendJournalSync = (runID: string, events: JournalEvent[]) =>
  Effect.sync(() => {
    if (events.length === 0) return
    mkdirSync(scriptDir(), { recursive: true })
    appendFileSync(journalPath(runID), events.map((e) => JSON.stringify(e) + "\n").join(""))
  })

const loadJournal = (runID: string): Effect.Effect<JournalLoad> =>
  Effect.promise(async () => {
    const file = Bun.file(journalPath(runID))
    if (!(await file.exists())) return { results: new Map(), pass: 1 }
    const text = await file.text()
    const results = new Map<string, unknown>()
    let maxPass = 0
    for (const line of text.split("\n")) {
      if (!line) continue
      let ev: JournalEvent
      try {
        ev = JSON.parse(line) as JournalEvent
      } catch {
        continue
      }
      if (typeof ev.pass === "number" && ev.pass > maxPass) maxPass = ev.pass
      if (ev.t === "agent") results.set(ev.key, ev.result)
    }
    return { results, pass: maxPass + 1 }
  })

const clearJournal = (runID: string) =>
  Effect.promise(async () => {
    const fs = await import("fs/promises")
    await fs.mkdir(scriptDir(), { recursive: true })
    await Bun.write(journalPath(runID), "")
  })

export const WorkflowPersistence = {
  recordStart,
  recordPhase,
  flushCounters,
  recordTerminal,
  list,
  load,
  writeScript,
  readScript,
  appendJournal,
  appendJournalSync,
  loadJournal,
  clearJournal,
}
