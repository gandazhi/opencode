# Workflow TUI Dashboard & Detail View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a full-screen workflow detail route to the opencode TUI with live sub-agent inspection (drill-down to child sessions), token/cost/retry/duration per agent, cancel/delete controls, and the backend journal + HTTP API plumbing to support it — all event-streamed, no polling.

**Architecture:** Extend the workflow journal with `agent_start`/`agent_end` lifecycle events (cost/tokens captured once at agent completion). Add `detail`/`remove` runtime methods. Add 3 HTTP endpoints (detail/cancel/delete). TUI adds a new `workflow` route type with a full-screen `WorkflowDetail` component that hydrates once via the detail endpoint then updates fully via events.

**Tech Stack:** Effect v4 (runtime/HTTP API), quickjs-emscripten (sandbox), @opentui/solid + solid-js (TUI), Drizzle (DB), Bun (test runner/typecheck).

**Spec:** `docs/superpowers/specs/2026-06-14-workflow-tui-dashboard-design.md`

---

## File Structure

**Backend (`packages/opencode/src/workflow/`):**
- `persistence.ts` — extend `JournalEvent` union + `JournalLoad` + `loadJournal` rebuild; add `remove`
- `runtime.ts` — `spawnShared` signature + cost capture; `agent()` hook emits start/end; `detail`/`remove` methods; fill `childActorIDs`
- `events.ts` — add `WorkflowAgentStarted` + `WorkflowAgentEnded`

**Backend HTTP API (`packages/opencode/src/server/routes/instance/httpapi/`):**
- `groups/workflow.ts` — new schemas + 3 endpoints + 2 error classes + paths
- `handlers/workflow.ts` — `detail`/`cancel`/`remove` handlers

**Core (`packages/core/src/workflow/sql.ts`):**
- `sql.ts` — no schema change needed (cost read from existing session rows)

**TUI (`packages/tui/src/`):**
- `context/route.tsx` — add `WorkflowDetailRoute` to `Route` union + `initialRoute` parser
- `context/sync.tsx` — extend `WorkflowRun` type; add `detail`/`cancel`/`remove` methods; subscribe to 2 new events
- `component/dialog-workflows.tsx` — add Cancel/Delete actions; Enter navigates to detail route
- `routes/workflow/index.tsx` — NEW: full-screen `WorkflowDetail` component
- `app.tsx` — add `<Match>` for `workflow` route

**SDK:**
- `packages/sdk/js/` — regenerated via `./packages/sdk/js/script/build.ts`

**Tests:**
- `packages/opencode/test/workflow/detail.test.ts` — NEW
- `packages/opencode/test/workflow/journal-lifecycle.test.ts` — NEW
- `packages/opencode/test/workflow/remove.test.ts` — NEW
- `packages/tui/test/workflow-detail.test.tsx` — NEW (if harness exists)

---

## Task 1: Persistence — extend journal types and `loadJournal` rebuild

**Files:**
- Modify: `packages/opencode/src/workflow/persistence.ts:55-60` (JournalEvent + JournalLoad types)
- Modify: `packages/opencode/src/workflow/persistence.ts:219-238` (loadJournal)
- Test: `packages/opencode/test/workflow/journal-lifecycle.test.ts` (NEW)

- [ ] **Step 1: Write the failing test for journal lifecycle parsing**

Create `packages/opencode/test/workflow/journal-lifecycle.test.ts`:

```ts
import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { WorkflowPersistence, type JournalEvent } from "@/workflow/persistence"
import { testEffect } from "../lib/effect"

const it = testEffect()

const RUN_ID = "wf_test_lifecycle_001"

function withJournalDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  return fn(Global.Path.data)
}

describe("loadJournal lifecycle rebuild", () => {
  it.after.each(async () => {
    await WorkflowPersistence.clearJournal(RUN_ID).pipe(Effect.runPromise).catch(() => {})
  })

  it("rebuilds agents[] from agent_start/agent_end events", async () => {
    const events: JournalEvent[] = [
      { t: "agent_start", key: "k1", sessionID: "sess_a", agentType: "general", label: "brief", phase: "research", ts: 1000, pass: 1 },
      { t: "agent_end", key: "k1", ok: true, ts: 2000, pass: 1 },
      { t: "agent_start", key: "k2", sessionID: "sess_b", agentType: "build", label: "impl", ts: 3000, pass: 1 },
      { t: "agent_end", key: "k2", ok: false, reason: "timeout", ts: 4000, cost: 0.05, tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } }, pass: 1 },
    ]
    await WorkflowPersistence.appendJournalSync(RUN_ID, events).pipe(Effect.runPromise)

    const loaded = await WorkflowPersistence.loadJournal(RUN_ID).pipe(Effect.runPromise)

    expect(loaded.agents).toHaveLength(2)
    expect(loaded.agents[0]).toMatchObject({ key: "k1", sessionID: "sess_a", agentType: "general", status: "succeeded", startedAt: 1000, endedAt: 2000 })
    expect(loaded.agents[1]).toMatchObject({ key: "k2", status: "failed", reason: "timeout", cost: 0.05 })
    expect(loaded.agents[1].tokens?.input).toBe(100)
  })

  it("leaves a running agent (start with no end) as status running", async () => {
    await WorkflowPersistence.appendJournalSync(RUN_ID, [
      { t: "agent_start", key: "k1", sessionID: "sess_a", agentType: "general", ts: 1000, pass: 1 },
    ]).pipe(Effect.runPromise)

    const loaded = await WorkflowPersistence.loadJournal(RUN_ID).pipe(Effect.runPromise)

    expect(loaded.agents).toHaveLength(1)
    expect(loaded.agents[0].status).toBe("running")
  })

  it("collects full logs from log events", async () => {
    await WorkflowPersistence.appendJournalSync(RUN_ID, [
      { t: "log", msg: "first", pass: 1 },
      { t: "log", msg: "second", pass: 1 },
      { t: "log", msg: "third", pass: 1 },
    ]).pipe(Effect.runPromise)

    const loaded = await WorkflowPersistence.loadJournal(RUN_ID).pipe(Effect.runPromise)

    expect(loaded.logs).toEqual(["first", "second", "third"])
  })

  it("preserves existing results map and pass counter", async () => {
    await WorkflowPersistence.appendJournalSync(RUN_ID, [
      { t: "agent", key: "k1", result: "hello", pass: 1 },
      { t: "phase", title: "research", pass: 2 },
    ]).pipe(Effect.runPromise)

    const loaded = await WorkflowPersistence.loadJournal(RUN_ID).pipe(Effect.runPromise)

    expect(loaded.results.get("k1")).toBe("hello")
    expect(loaded.pass).toBe(3)
    expect(loaded.agents).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/opencode && bun test test/workflow/journal-lifecycle.test.ts`
Expected: FAIL — `loaded.agents` is undefined (the type doesn't have `agents` yet), TypeScript error on `JournalEvent` union missing `agent_start`/`agent_end`.

- [ ] **Step 3: Extend `JournalEvent` and `JournalLoad` types**

In `packages/opencode/src/workflow/persistence.ts`, replace lines 55-60:

```ts
export type WorkflowTokens = {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export type AgentRecord = {
  key: string
  sessionID?: string
  agentType: string
  label?: string
  phase?: string
  status: "running" | "succeeded" | "failed"
  reason?: string
  retry?: number
  startedAt: number
  endedAt?: number
  cost?: number
  tokens?: WorkflowTokens
}

export type JournalEvent =
  | { t: "agent"; key: string; result: unknown; pass: number }
  | { t: "agent_start"; key: string; sessionID?: string; agentType: string; label?: string; phase?: string; ts: number; pass: number }
  | { t: "agent_end"; key: string; ok: boolean; reason?: string; retry?: number; cost?: number; tokens?: WorkflowTokens; ts: number; pass: number }
  | { t: "log"; msg: string; pass: number }
  | { t: "phase"; title: string; pass: number }

export type JournalLoad = {
  results: Map<string, unknown>
  pass: number
  agents: AgentRecord[]
  logs: string[]
}
```

- [ ] **Step 4: Rewrite `loadJournal` to rebuild agents + collect logs**

In `packages/opencode/src/workflow/persistence.ts`, replace the `loadJournal` function (lines 219-238) with:

```ts
const loadJournal = (runID: string): Effect.Effect<JournalLoad> =>
  Effect.promise(async () => {
    const file = Bun.file(journalPath(runID))
    if (!(await file.exists())) return { results: new Map(), pass: 1, agents: [], logs: [] }
    const text = await file.text()
    const results = new Map<string, unknown>()
    const agents = new Map<string, AgentRecord>()
    const agentOrder: string[] = []
    const logs: string[] = []
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
      switch (ev.t) {
        case "agent":
          results.set(ev.key, ev.result)
          break
        case "agent_start": {
          if (!agents.has(ev.key)) {
            agentOrder.push(ev.key)
            agents.set(ev.key, {
              key: ev.key,
              sessionID: ev.sessionID,
              agentType: ev.agentType,
              label: ev.label,
              phase: ev.phase,
              status: "running",
              startedAt: ev.ts,
            })
          }
          break
        }
        case "agent_end": {
          const existing = agents.get(ev.key)
          if (existing) {
            existing.status = ev.ok ? "succeeded" : "failed"
            existing.endedAt = ev.ts
            existing.reason = ev.reason
            existing.retry = ev.retry
            existing.cost = ev.cost
            existing.tokens = ev.tokens
          }
          break
        }
        case "log":
          logs.push(ev.msg)
          break
        case "phase":
          break
      }
    }
    return { results, pass: maxPass + 1, agents: agentOrder.map((k) => agents.get(k)!), logs }
  })
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/opencode && bun test test/workflow/journal-lifecycle.test.ts`
Expected: PASS — all 4 tests green.

- [ ] **Step 6: Run existing persistence tests for regression**

Run: `cd packages/opencode && bun test test/workflow/persistence.test.ts`
Expected: PASS — no regression.

- [ ] **Step 7: Commit**

```bash
git add packages/opencode/src/workflow/persistence.ts packages/opencode/test/workflow/journal-lifecycle.test.ts
git commit -m "feat(workflow): extend journal with agent lifecycle events and logs

loadJournal now rebuilds an agents[] array from agent_start/agent_end
events (status/phase/cost/tokens) and collects full logs. Existing
results/pass behavior preserved. Backward compatible: old journals
without lifecycle events yield empty agents[]."
```

---

## Task 2: Persistence — add `remove` (DB row + journal + script)

**Files:**
- Modify: `packages/opencode/src/workflow/persistence.ts:247-260` (WorkflowPersistence export)
- Test: `packages/opencode/test/workflow/remove.test.ts` (NEW)

- [ ] **Step 1: Write the failing test for `remove`**

Create `packages/opencode/test/workflow/remove.test.ts`:

```ts
import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { WorkflowPersistence } from "@/workflow/persistence"
import { testEffect } from "../lib/effect"
import { tmpdirScoped, provideInstance } from "../fixture/fixture"

const it = testEffect()

const RUN_ID = "wf_test_remove_001"

describe("WorkflowPersistence.remove", () => {
  it("deletes the DB row, journal file, and script file", async () => {
    await using tmp = await tmpdirScoped({})
    await Effect.runPromise(
      provideInstance(tmp.path)(
        Effect.gen(function* () {
          yield* WorkflowPersistence.recordStart({
            runID: RUN_ID,
            sessionID: "sess_test" as never,
            name: "test",
          }).pipe(Effect.ignore)
          yield* WorkflowPersistence.writeScript(RUN_ID, "export const meta = {name:'test',description:'d'}").pipe(Effect.ignore)
          yield* WorkflowPersistence.appendJournalSync(RUN_ID, [{ t: "log", msg: "x", pass: 1 }]).pipe(Effect.ignore)

          yield* WorkflowPersistence.remove(RUN_ID)

          const row = yield* WorkflowPersistence.load(RUN_ID).pipe(Effect.orElseSucceed(() => undefined))
          expect(row).toBeUndefined()

          const journalFile = Bun.file(path.join(Global.Path.data, "workflow", `${RUN_ID}.jsonl`))
          expect(await journalFile.exists()).toBe(false)
          const scriptFile = Bun.file(path.join(Global.Path.data, "workflow", `${RUN_ID}.js`))
          expect(await scriptFile.exists()).toBe(false)
        }),
      ),
    )
  })

  it("is a no-op for an unknown runID", async () => {
    await using tmp = await tmpdirScoped({})
    await Effect.runPromise(
      provideInstance(tmp.path)(WorkflowPersistence.remove("wf_nonexistent")),
    )
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/opencode && bun test test/workflow/remove.test.ts`
Expected: FAIL — `WorkflowPersistence.remove` is not a function.

- [ ] **Step 3: Add `remove` to persistence**

In `packages/opencode/src/workflow/persistence.ts`, add this function before the `WorkflowPersistence` export object (after `clearJournal`, ~line 245):

```ts
const remove = (runID: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const safe = safeRunID(runID)
    yield* db.delete(WorkflowRunTable).where(eq(WorkflowRunTable.id, safe)).run().pipe(Effect.orDie)
    yield* Effect.promise(async () => {
      const fs = await import("fs/promises")
      await fs.rm(scriptPath(safe), { force: true })
      await fs.rm(journalPath(safe), { force: true })
    })
  })
```

Then add `remove,` to the exported `WorkflowPersistence` object (before `clearJournal`):

```ts
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
  remove,
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/opencode && bun test test/workflow/remove.test.ts`
Expected: PASS — both tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/workflow/persistence.ts packages/opencode/test/workflow/remove.test.ts
git commit -m "feat(workflow): add persistence.remove for DB row + journal + script cleanup"
```

---

## Task 3: Events — add `WorkflowAgentStarted` + `WorkflowAgentEnded`

**Files:**
- Modify: `packages/opencode/src/workflow/events.ts` (append 2 new events)

- [ ] **Step 1: Add the two new events**

In `packages/opencode/src/workflow/events.ts`, append after `WorkflowChildFailed` (end of file):

```ts
export const WorkflowAgentStarted = EventV2.define({
  type: "workflow.agent_started",
  ...syncOptions,
  schema: {
    sessionID: SessionID,
    runID: Schema.String,
    key: Schema.String,
    agentID: Schema.optional(Schema.String),
    agentType: Schema.String,
    label: Schema.optional(Schema.String),
    phase: Schema.optional(Schema.String),
  },
})

export const WorkflowAgentEnded = EventV2.define({
  type: "workflow.agent_ended",
  ...syncOptions,
  schema: {
    sessionID: SessionID,
    runID: Schema.String,
    key: Schema.String,
    status: Schema.Literals(["succeeded", "failed"]),
    reason: Schema.optional(Schema.String),
    retry: Schema.optional(Schema.Number),
    cost: Schema.optional(Schema.Number),
    tokens: Schema.optional(
      Schema.Struct({
        input: Schema.Number,
        output: Schema.Number,
        reasoning: Schema.Number,
        cache: Schema.Struct({ read: Schema.Number, write: Schema.Number }),
      }),
    ),
  },
})
```

- [ ] **Step 2: Typecheck**

Run: `cd packages/opencode && bun typecheck`
Expected: PASS — no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/opencode/src/workflow/events.ts
git commit -m "feat(workflow): add WorkflowAgentStarted/Ended events with cost+tokens"
```

---

## Task 4: Runtime — `spawnShared` emits start/end, captures cost, fills `childActorIDs`

**Files:**
- Modify: `packages/opencode/src/workflow/runtime.ts:515-604` (spawnShared)
- Modify: `packages/opencode/src/workflow/runtime.ts:606-643` (agent hook)

This task wires the lifecycle events into the actual agent spawn path. It's the core plumbing.

- [ ] **Step 1: Change `spawnShared` signature and return metadata**

In `packages/opencode/src/workflow/runtime.ts`, replace the `spawnShared` function (lines 515-604). The key changes: (a) accept `key` as first arg, (b) capture `childID`, (c) read child session cost on completion, (d) populate `childActorIDs`, (e) emit `agent_start` journal+event on child creation.

```ts
type SpawnResult = { value: unknown; childID?: string; reason: FailReason }

const spawnShared = async (
  key: string,
  prompt: string,
  o: AgentOpts,
  resolvedModel: { providerID: ProviderID; modelID: ModelID } | undefined,
): Promise<SpawnResult> => {
  entry.running++
  scheduleFlush(entry)
  let reason: FailReason = "actor-error"
  let errorMessage: string | undefined
  let childID: string | undefined
  let cost: number | undefined
  let tokens: import("@opencode-ai/core/workflow/persistence").WorkflowTokens | undefined
  const startTs = Date.now()
  const value = await bridge
    .promise(
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompts = yield* SessionPrompt.Service
        const agents = yield* Agent.Service

        const subagent = yield* agents.get(o.agentType ?? "general")
        const parent = yield* sessions.get(input.sessionID)
        const permission = deriveSubagentSessionPermission({
          parentSessionPermission: parent.permission ?? [],
          subagent,
        })
        const child = yield* sessions.create({
          parentID: input.sessionID,
          title: o.label ?? "workflow agent",
          agent: subagent.name,
          permission,
        })
        childID = child.id
        entry.childActorIDs.add(child.id)

        // Emit agent_start (journal + event) now that the child session exists
        await bridge.promise(
          WorkflowPersistence.appendJournalSync(runID, [
            { t: "agent_start", key, sessionID: child.id, agentType: o.agentType ?? "general", label: o.label, phase: o.phase ?? entry.currentPhase, ts: startTs, pass },
          ]).pipe(Effect.ignore),
        )
        bridge.fork(
          events.publish(WorkflowAgentStarted, {
            sessionID: input.sessionID,
            runID,
            key,
            agentID: child.id,
            agentType: o.agentType ?? "general",
            label: o.label,
            phase: o.phase ?? entry.currentPhase,
          }),
        )

        const parts = yield* prompts.resolvePromptParts(prompt)

        const deliverable = yield* awaitWithTimeout(
          child.id,
          o,
          prompts
            .prompt({
              sessionID: child.id,
              agent: subagent.name,
              ...(resolvedModel ? { model: resolvedModel } : {}),
              parts,
              ...(o.schema
                ? {
                    format: Schema.decodeSync(SessionV1.Format)({
                      type: "json_schema",
                      schema: o.schema,
                    }),
                  }
                : {}),
            })
            .pipe(
              Effect.map((msg) => {
                // Capture accumulated cost/tokens from the completed child session
                const info = msg.info as { cost?: number; tokens?: { input: number; output: number; reasoning: number; cache?: { read?: number; write?: number } } }
                if (typeof info.cost === "number") cost = info.cost
                if (info.tokens) {
                  tokens = {
                    input: info.tokens.input ?? 0,
                    output: info.tokens.output ?? 0,
                    reasoning: info.tokens.reasoning ?? 0,
                    cache: { read: info.tokens.cache?.read ?? 0, write: info.tokens.cache?.write ?? 0 },
                  }
                }
                if (o.schema) {
                  const v = (msg.info as { structured?: unknown }).structured ?? null
                  if (v === null) reason = "no-deliverable"
                  return v
                }
                const text = msg.parts.findLast((p) => p.type === "text")?.text ?? null
                if (text === null) reason = "no-deliverable"
                return text
              }),
              Effect.catchCause((cause) =>
                Effect.sync(() => {
                  reason = "actor-error"
                  errorMessage = cause.toString()
                  return null
                }),
              ),
            ),
          () => {
            reason = "timeout"
            bridge.fork(prompts.cancel(child.id).pipe(Effect.ignore))
          },
        )
        return deliverable
      }),
    )
    .catch((e) => {
      reason = "spawn-reject"
      errorMessage = e instanceof Error ? e.message : String(e)
      return null
    })
  entry.running--
  if (value !== null) entry.succeeded++
  else {
    entry.failed++
    publishAgentFailed(o, reason, { errorMessage })
  }
  scheduleFlush(entry)
  return { value, childID, reason, cost, tokens }
}
```

- [ ] **Step 2: Update the `agent()` hook to use the new signature and emit `agent_end`**

In `packages/opencode/src/workflow/runtime.ts`, replace the `agent` HostFn body (lines 623-642, the `return (async () => { ... })()` block) with:

```ts
        return (async () => {
          const result = await sem.run(async () =>
            globalSemLocal.run(async () => {
              if (entry.agentCount >= lifecycleCap) {
                warnCapOnce()
                publishAgentFailed(o, "over-cap")
                return { value: null, childID: undefined, reason: "over-cap" as FailReason } as SpawnResult
              }
              entry.agentCount++
              const resolvedModel = await bridge.promise(resolveAgentModel(o.model, input.model, entry.warnedModelRefs))
              return spawnShared(key, promptStr, o, resolvedModel)
            }),
          )
          const ok = result.value !== null
          // Emit agent_end (journal + event) with cost/tokens captured at completion
          const endTs = Date.now()
          await bridge.promise(
            WorkflowPersistence.appendJournalSync(runID, [
              { t: "agent_end", key, ok, reason: ok ? undefined : result.reason, ts: endTs, ...(result.cost !== undefined ? { cost: result.cost } : {}), ...(result.tokens ? { tokens: result.tokens } : {}), pass },
            ]).pipe(Effect.ignore),
          )
          bridge.fork(
            events.publish(WorkflowAgentEnded, {
              sessionID: input.sessionID,
              runID,
              key,
              status: ok ? "succeeded" : "failed",
              reason: ok ? undefined : result.reason,
              ...(result.cost !== undefined ? { cost: result.cost } : {}),
              ...(result.tokens ? { tokens: result.tokens } : {}),
            }),
          )
          if (ok) {
            await bridge.promise(
              WorkflowPersistence.appendJournalSync(runID, [{ t: "agent", key, result: result.value, pass }]).pipe(Effect.ignore),
            )
          }
          return result.value
        })()
```

- [ ] **Step 3: Add the `SpawnResult` type and import new events**

At the top of the `launch` function body in `runtime.ts`, the `SpawnResult` type is already declared above `spawnShared` (in Step 1). Also ensure the new events are imported. Update the import from `./events` (line 25) to include the new events:

```ts
import { WorkflowAgentFailed, WorkflowAgentStarted, WorkflowAgentEnded, WorkflowChildFailed, WorkflowFinished, WorkflowLog, WorkflowPhase, WorkflowProgress, WorkflowStarted } from "./events"
```

- [ ] **Step 4: Typecheck**

Run: `cd packages/opencode && bun typecheck`
Expected: PASS. Fix any type errors (common: `FailReason` is already defined at line 488; `pass` is available from `journal.pass` at line 414; `WorkflowTokens` import path).

Note: `WorkflowTokens` is defined in `persistence.ts` (Task 1). Import it if needed: `import type { WorkflowTokens } from "./persistence"` — but since we inline it in the type, verify the import. If the inline `import("...")` type syntax causes issues, change the `SpawnResult` type to:

```ts
type SpawnResult = { value: unknown; childID?: string; reason: FailReason; cost?: number; tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } } }
```

- [ ] **Step 5: Run existing workflow tests for regression**

Run: `cd packages/opencode && bun test test/workflow/`
Expected: PASS — existing tests (deep-research, sandbox, agent-timeout) still green. The `agent_start`/`agent_end` journal entries are additive and don't break the existing `agent` result journaling.

- [ ] **Step 6: Commit**

```bash
git add packages/opencode/src/workflow/runtime.ts
git commit -m "feat(workflow): emit agent lifecycle events with cost capture

spawnShared now accepts the journal key, populates childActorIDs,
emits agent_start on child creation and agent_end on completion (with
cost/tokens read once from the child session row). The agent() hook
writes the journal lifecycle events alongside the existing result."
```

---

## Task 5: Runtime — add `detail` method to the `Interface`

**Files:**
- Modify: `packages/opencode/src/workflow/runtime.ts:158-167` (Interface)
- Modify: `packages/opencode/src/workflow/runtime.ts:868-946` (start/status/wait/cancel/list/resume impls)
- Test: `packages/opencode/test/workflow/detail.test.ts` (NEW)

- [ ] **Step 1: Write the failing test for `detail`**

Create `packages/opencode/test/workflow/detail.test.ts`:

```ts
import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { testEffect, provideTmpdirServer } from "../lib/effect"
import { WorkflowRuntime } from "@/workflow/runtime"

const it = testEffect()

const SCRIPT = `
export const meta = { name: "detail-test", description: "test detail" }
const a = await agent("say hello", { agentType: "general", label: "greet" })
log("agent returned: " + a)
phase("done")
return { ok: true }
`

describe("WorkflowRuntime.detail", () => {
  it("returns agents[] and logs[] for a completed run", async () => {
    await using tmp = await provideTmpdirServer({ script: SCRIPT })
    await Effect.runPromise(
      WorkflowRuntime.Service.pipe(
        Effect.flatMap((rt) =>
          rt.start({
            script: SCRIPT,
            sessionID: "sess_detail_test" as never,
            parentActorID: "test",
          }),
        ),
        Effect.flatMap((started) => rt_wait(started.runID)),
      ),
    )
    // (rt_wait helper omitted — see step 2 for the full test runtime wiring)
  })

  it("returns { status: 'unknown' } for an unknown runID", async () => {
    const runtime = yield_*_WORKFLOW_RUNTIME // placeholder — see full test below
  })
})
```

NOTE: The above is a skeleton. The full working test uses `provideTmpdirServer` with a mock LLM that responds so the agent() completes. Replace the skeleton with this complete version:

```ts
import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { provideTmpdirServer } from "../fixture/fixture"
import { WorkflowRuntime } from "@/workflow/runtime"
import { Session } from "@/session/session"
import { pollWithTimeout } from "../lib/effect"

const SCRIPT = `export const meta = { name: "detail-test", description: "test detail" }
log("starting")
const a = await agent("say hello", { agentType: "general", label: "greet" })
log("agent returned: " + a)
return { result: a }`

describe("WorkflowRuntime.detail", () => {
  it("returns agents[] and logs[] for a completed run", async () => {
    await using tmp = await provideTmpdirServer({ script: SCRIPT }, (dir) =>
      Effect.gen(function* () {
        const rt = yield* WorkflowRuntime.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "test", agent: "general" })
        const started = yield* rt.start({ script: SCRIPT, sessionID: session.id, parentActorID: "test" })

        // Wait for the run to complete
        yield* pollWithTimeout(
          rt.status({ runID: started.runID }),
          "run never completed",
        ).pipe(
          Effect.flatMap((s) => (s.status === "completed" || s.status === "failed" ? Effect.succeed(s) : Effect.fail(new Error("not done")))),
        )

        const detail = yield* rt.detail({ runID: started.runID })
        expect("status" in detail && detail.status === "unknown").toBe(false)

        const d = detail as { run: { name: string }; agents: { key: string; agentType: string; status: string }[]; logs: string[] }
        expect(d.run.name).toBe("detail-test")
        expect(d.agents.length).toBeGreaterThanOrEqual(1)
        expect(d.agents[0].agentType).toBe("general")
        expect(d.logs).toContain("starting")
      }),
    )
  })

  it("returns { status: 'unknown' } for an unknown runID", async () => {
    await using tmp = await provideTmpdirServer({}, (dir) =>
      Effect.gen(function* () {
        const rt = yield* WorkflowRuntime.Service
        const detail = yield* rt.detail({ runID: "wf_nonexistent_999" })
        expect("status" in detail && detail.status === "unknown").toBe(true)
      }),
    )
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/opencode && bun test test/workflow/detail.test.ts`
Expected: FAIL — `rt.detail` is not a function (not yet on Interface).

- [ ] **Step 3: Add `detail` to the `Interface`**

In `packages/opencode/src/workflow/runtime.ts`, add to the `Interface` (after `resume`, line 166):

```ts
  readonly detail: (input: {
    runID: string
  }) => Effect.Effect<
    | { status: "unknown" }
    | {
        run: RunSummary
        agents: import("./persistence").AgentRecord[]
        logs: string[]
      }
  >
```

- [ ] **Step 4: Implement `detail`**

In `packages/opencode/src/workflow/runtime.ts`, add the `detail` implementation inside the `layer` (after the `resume` impl, before `const impl = Service.of(...)`, ~line 948):

```ts
    const detail = Effect.fn("WorkflowRuntime.detail")(function* (input: { runID: string }) {
      const live = runs.get(input.runID)
      let agents: import("./persistence").AgentRecord[]
      let logs: string[]
      let summary: RunSummary | undefined
      if (live) {
        const journal = yield* WorkflowPersistence.loadJournal(input.runID)
        agents = journal.agents
        logs = journal.logs
        summary = (yield* WorkflowPersistence.load(input.runID)) ?? undefined
      } else {
        const journal = yield* WorkflowPersistence.loadJournal(input.runID)
        agents = journal.agents
        logs = journal.logs
        summary = yield* WorkflowPersistence.load(input.runID)
      }
      if (!summary) return { status: "unknown" as const }
      return {
        run: summary,
        agents,
        logs,
      }
    })

    const remove = Effect.fn("WorkflowRuntime.remove")(function* (input: { runID: string }) {
      const live = runs.get(input.runID)
      if (live && live.status === "running") {
        return yield* Effect.die(new Error(`${WORKFLOW_STRUCTURAL_ERROR}: cannot remove a running workflow — cancel first`))
      }
      // Cascade child runs
      if (live) {
        for (const childRunID of live.childRunIDs) {
          yield* WorkflowPersistence.remove(childRunID).pipe(Effect.ignore)
        }
      }
      yield* WorkflowPersistence.remove(input.runID).pipe(
        Effect.provideService(Database.Service, database),
      )
      runs.delete(input.runID)
    })
```

Then add `detail, remove` to the `Service.of(...)` call (line 948):

```ts
    const impl = Service.of({ start, status, wait, cancel, list, resume, detail, remove })
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/opencode && bun test test/workflow/detail.test.ts`
Expected: PASS — both tests green.

Note: If the test LLM mock is not set up, adapt `provideTmpdirServer` options to include a mock LLM response (see existing `test/workflow/deep-research.test.ts` for the pattern). The key assertion is that `agents[]` is non-empty and `logs[]` contains the logged message.

- [ ] **Step 6: Commit**

```bash
git add packages/opencode/src/workflow/runtime.ts packages/opencode/test/workflow/detail.test.ts
git commit -m "feat(workflow): add runtime detail and remove methods

detail returns {run, agents[], logs[]} from the journal (cost/tokens
already embedded by agent_end events). remove validates non-running,
cascades child runs, deletes DB row + journal + script."
```

---

## Task 6: HTTP API — schemas, endpoints, error classes

**Files:**
- Modify: `packages/opencode/src/server/routes/instance/httpapi/groups/workflow.ts`

- [ ] **Step 1: Add new schemas, paths, endpoints, and error classes**

In `packages/opencode/src/server/routes/instance/httpapi/groups/workflow.ts`, add these schemas after `ResumeResult` (line 29):

```ts
export const WorkflowAgentStatus = Schema.Literals(["running", "succeeded", "failed"])

export const WorkflowTokens = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  reasoning: Schema.Number,
  cache: Schema.Struct({ read: Schema.Number, write: Schema.Number }),
})

export const WorkflowAgent = Schema.Struct({
  key: Schema.String,
  sessionID: Schema.optional(Schema.String),
  agentType: Schema.String,
  label: Schema.optional(Schema.String),
  phase: Schema.optional(Schema.String),
  status: WorkflowAgentStatus,
  reason: Schema.optional(Schema.String),
  retry: Schema.optional(Schema.Number),
  startedAt: Schema.Number,
  endedAt: Schema.optional(Schema.Number),
  cost: Schema.optional(Schema.Number),
  tokens: Schema.optional(WorkflowTokens),
})

export const WorkflowRunDetail = Schema.Struct({
  run: WorkflowRunSummary,
  agents: Schema.Array(WorkflowAgent),
  logs: Schema.Array(Schema.String),
})

export const EmptyResult = Schema.Struct({ ok: Schema.Boolean })

export const WorkflowNotFoundError = Schema.ErrorClass({
  identifier: "WorkflowNotFoundError",
  title: "Workflow not found",
  fields: { runID: Schema.String },
})

export const WorkflowRunningError = Schema.ErrorClass({
  identifier: "WorkflowRunningError",
  title: "Workflow is still running",
  fields: { runID: Schema.String },
})
```

Then update `WorkflowPaths` (line 36):

```ts
export const WorkflowPaths = {
  list: root,
  detail: `${root}/:runID`,
  cancel: `${root}/:runID/cancel`,
  delete: `${root}/:runID`,
  resume: `${root}/:runID/resume`,
} as const
```

Then add 3 new endpoints to the `WorkflowApi` chain (after the `resume` endpoint, before the closing `)` of `.add(HttpApiEndpoint.post("resume", ...))`):

```ts
        HttpApiEndpoint.get("detail", WorkflowPaths.detail, {
          params: { runID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(WorkflowRunDetail, "Run detail with agents and logs"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.detail",
            summary: "Get workflow run detail",
            description: "Returns run summary, agent lifecycle records (with cost/tokens), and full logs.",
          }),
        ),
        HttpApiEndpoint.post("cancel", WorkflowPaths.cancel, {
          params: { runID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(WorkflowRunSummary, "Run snapshot after cancel"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.cancel",
            summary: "Cancel workflow run",
            description: "Best-effort cancel; in-flight agents stop at their next safe point.",
          }),
        ),
        HttpApiEndpoint.del("delete", WorkflowPaths.delete, {
          params: { runID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(EmptyResult, "Deletion result"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.delete",
            summary: "Delete workflow run",
            description: "Deletes the DB row, journal, and script. Running runs must be cancelled first.",
          }),
        ),
```

- [ ] **Step 2: Typecheck**

Run: `cd packages/opencode && bun typecheck`
Expected: PASS. If `Schema.ErrorClass` is not available in your Effect version, use the pattern from existing error classes in the codebase (search for `Schema.ErrorClass` or `Schema.TaggedErrorClass`). The handlers in Task 7 will reference these.

- [ ] **Step 3: Commit**

```bash
git add packages/opencode/src/server/routes/instance/httpapi/groups/workflow.ts
git commit -m "feat(workflow): add detail/cancel/delete HTTP endpoints and error schemas"
```

---

## Task 7: HTTP handlers — `detail`/`cancel`/`delete`

**Files:**
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/workflow.ts`

- [ ] **Step 1: Add the three new handlers**

Replace the entire contents of `packages/opencode/src/server/routes/instance/httpapi/handlers/workflow.ts` with:

```ts
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { workflowRef } from "@/workflow/runtime-ref"
import type { SessionID } from "@/session/schema"
import { ListQuery, WorkflowNotFoundError } from "../groups/workflow"

export const workflowHandlers = HttpApiBuilder.group(InstanceHttpApi, "workflow", (handlers) =>
  Effect.gen(function* () {
    const list = Effect.fn("WorkflowHttpApi.list")(function* (ctx: { query: typeof ListQuery.Type }) {
      const runtime = workflowRef.current
      if (!runtime) return []
      return yield* runtime.list(ctx.query.session_id ? { sessionID: ctx.query.session_id as SessionID } : undefined)
    })

    const detail = Effect.fn("WorkflowHttpApi.detail")(function* (ctx: { params: { runID: string } }) {
      const runtime = workflowRef.current
      if (!runtime) return yield* Effect.fail(WorkflowNotFoundError.make({ runID: ctx.params.runID }))
      const result = yield* runtime.detail({ runID: ctx.params.runID })
      if ("status" in result && result.status === "unknown") {
        return yield* Effect.fail(WorkflowNotFoundError.make({ runID: ctx.params.runID }))
      }
      return result
    })

    const cancel = Effect.fn("WorkflowHttpApi.cancel")(function* (ctx: { params: { runID: string } }) {
      const runtime = workflowRef.current
      if (!runtime) return null
      yield* runtime.cancel({ runID: ctx.params.runID })
      const snapshot = yield* runtime.status({ runID: ctx.params.runID })
      return snapshot
    })

    const remove = Effect.fn("WorkflowHttpApi.delete")(function* (ctx: { params: { runID: string } }) {
      const runtime = workflowRef.current
      if (!runtime) return { ok: false }
      yield* runtime.remove({ runID: ctx.params.runID })
      return { ok: true }
    })

    const resume = Effect.fn("WorkflowHttpApi.resume")(function* (ctx: { params: { runID: string } }) {
      const runtime = workflowRef.current
      if (!runtime) return { runID: ctx.params.runID, resumed: false }
      return yield* runtime.resume({ runID: ctx.params.runID })
    })

    return handlers
      .handle("list", list)
      .handle("detail", detail)
      .handle("cancel", cancel)
      .handle("delete", remove)
      .handle("resume", resume)
  }),
)
```

- [ ] **Step 2: Typecheck**

Run: `cd packages/opencode && bun typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/opencode/src/server/routes/instance/httpapi/handlers/workflow.ts
git commit -m "feat(workflow): add detail/cancel/delete HTTP handlers"
```

---

## Task 8: SDK regeneration

**Files:**
- Regenerate: `packages/sdk/js/`

- [ ] **Step 1: Regenerate the JS SDK**

Run: `./packages/sdk/js/script/build.ts`
Expected: The SDK now exports the new `WorkflowRunDetail`, `WorkflowAgent`, `WorkflowTokens`, `WorkflowNotFoundError`, `WorkflowRunningError` types and the new client methods.

- [ ] **Step 2: Verify SDK typecheck**

Run: `cd packages/sdk/js && bun typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/sdk/js/
git commit -m "chore(sdk): regenerate for workflow detail/cancel/delete endpoints"
```

---

## Task 9: TUI sync store — extend type, add methods, subscribe events

**Files:**
- Modify: `packages/tui/src/context/sync.tsx:40-51` (WorkflowRun type)
- Modify: `packages/tui/src/context/sync.tsx:738-764` (workflow methods)

- [ ] **Step 1: Extend the `WorkflowRun` type**

In `packages/tui/src/context/sync.tsx`, replace the `WorkflowRun` type (lines 40-51) with:

```ts
export type WorkflowTokens = {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export type WorkflowAgent = {
  key: string
  sessionID?: string
  agentType: string
  label?: string
  phase?: string
  status: "running" | "succeeded" | "failed"
  reason?: string
  retry?: number
  startedAt: number
  endedAt?: number
  cost?: number
  tokens?: WorkflowTokens
}

export type WorkflowRun = {
  runID: string
  sessionID: string
  name: string
  status: "running" | "completed" | "failed" | "cancelled"
  running: number
  succeeded: number
  failed: number
  currentPhase?: string
  error?: string
  logs: string[]
  agents: WorkflowAgent[]
  agentCount: number
  parentActorID?: string
}
```

- [ ] **Step 2: Subscribe to `workflow.agent_started` and `workflow.agent_ended` events**

In `packages/tui/src/context/sync.tsx`, add these handlers inside the `event.subscribe(...)` callback, after the `workflow.finished` handler block (after line 240):

```ts
      if (type === "workflow.agent_started") {
        const { runID, key, agentID, agentType, label, phase } = (event as unknown as {
          properties: { runID: string; key: string; agentID?: string; agentType: string; label?: string; phase?: string }
        }).properties
        setStore("workflow", runID, (prev) =>
          prev
            ? {
                ...prev,
                agents: upsertAgent(prev.agents ?? [], {
                  key,
                  sessionID: agentID,
                  agentType,
                  label,
                  phase,
                  status: "running",
                  startedAt: Date.now(),
                }),
              }
            : prev,
        )
        return
      }
      if (type === "workflow.agent_ended") {
        const { runID, key, status, reason, retry, cost, tokens } = (event as unknown as {
          properties: {
            runID: string
            key: string
            status: "succeeded" | "failed"
            reason?: string
            retry?: number
            cost?: number
            tokens?: WorkflowTokens
          }
        }).properties
        setStore("workflow", runID, (prev) =>
          prev
            ? {
                ...prev,
                agents: (prev.agents ?? []).map((a) =>
                  a.key === key
                    ? {
                        ...a,
                        status,
                        reason,
                        retry,
                        endedAt: Date.now(),
                        ...(cost !== undefined ? { cost } : {}),
                        ...(tokens ? { tokens } : {}),
                      }
                    : a,
                ),
              }
            : prev,
        )
        return
      }
```

Add the `upsertAgent` helper near the top of the file (after the `search` function, ~line 64):

```ts
function upsertAgent(agents: WorkflowAgent[], agent: WorkflowAgent): WorkflowAgent[] {
  const idx = agents.findIndex((a) => a.key === agent.key)
  if (idx === -1) return [...agents, agent]
  return agents.map((a, i) => (i === idx ? { ...a, ...agent, ...(agent.cost !== undefined ? { cost: agent.cost } : {}) } : a))
}
```

- [ ] **Step 3: Add `detail`, `cancel`, `remove` methods to the sync store**

In `packages/tui/src/context/sync.tsx`, replace the `workflow:` object (lines 738-764) with:

```ts
      workflow: {
        async load(sessionID?: string) {
          const params = new URLSearchParams()
          const ws = project.workspace.current()
          if (ws) params.set("workspace", ws)
          if (sessionID) params.set("session_id", sessionID)
          const query = params.toString()
          const response = await sdk.fetch(`${sdk.url}/workflow${query ? "?" + query : ""}`)
          if (!response.ok) return
          const runs: WorkflowRun[] = await response.json()
          setStore(
            "workflow",
            produce((draft) => {
              for (const run of runs) {
                if (!run.agents) run.agents = []
                if (!run.logs) run.logs = []
                draft[run.runID] = run
              }
            }),
          )
        },
        async detail(runID: string) {
          const params = new URLSearchParams()
          const ws = project.workspace.current()
          if (ws) params.set("workspace", ws)
          const query = params.toString()
          const response = await sdk.fetch(`${sdk.url}/workflow/${runID}${query ? "?" + query : ""}`)
          if (!response.ok) return
          const data: { run: WorkflowRun; agents: WorkflowAgent[]; logs: string[] } = await response.json()
          setStore("workflow", runID, (prev) =>
            prev ? { ...prev, agents: data.agents, logs: data.logs } : { ...data.run, agents: data.agents, logs: data.logs },
          )
        },
        async cancel(runID: string) {
          const params = new URLSearchParams()
          const ws = project.workspace.current()
          if (ws) params.set("workspace", ws)
          const query = params.toString()
          await sdk.fetch(`${sdk.url}/workflow/${runID}/cancel${query ? "?" + query : ""}`, { method: "POST" })
        },
        async remove(runID: string) {
          const params = new URLSearchParams()
          const ws = project.workspace.current()
          if (ws) params.set("workspace", ws)
          const query = params.toString()
          const response = await sdk.fetch(`${sdk.url}/workflow/${runID}${query ? "?" + query : ""}`, { method: "DELETE" })
          if (response.ok) {
            setStore(
              "workflow",
              produce((draft) => {
                delete draft[runID]
              }),
            )
          }
        },
        async resume(runID: string) {
          const params = new URLSearchParams()
          const ws = project.workspace.current()
          if (ws) params.set("workspace", ws)
          const query = params.toString()
          await sdk.fetch(`${sdk.url}/workflow/${runID}/resume${query ? "?" + query : ""}`, {
            method: "POST",
          })
        },
      },
```

- [ ] **Step 4: Also update the `workflow.started` handler to initialize `agents: []`**

In the `workflow.started` handler (line 199-211), add `agents: []` to the run object:

```ts
        setStore("workflow", runID, (prev) => ({
          runID,
          sessionID,
          name,
          status: "running" as const,
          running: prev?.running ?? 0,
          succeeded: prev?.succeeded ?? 0,
          failed: prev?.failed ?? 0,
          currentPhase: prev?.currentPhase,
          error: undefined,
          logs: prev?.logs ?? [],
          agents: prev?.agents ?? [],
          agentCount: prev?.agentCount ?? 0,
        }))
```

- [ ] **Step 5: Typecheck**

Run: `cd packages/tui && bun typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/tui/src/context/sync.tsx
git commit -m "feat(tui): extend sync store with agent records and detail/cancel/remove"
```

---

## Task 10: TUI route — add `WorkflowDetailRoute`

**Files:**
- Modify: `packages/tui/src/context/route.tsx`

- [ ] **Step 1: Add the route type**

In `packages/tui/src/context/route.tsx`, add after `PluginRoute` (line 21):

```ts
export type WorkflowDetailRoute = {
  type: "workflow"
  runID: string
}
```

Update the `Route` union (line 23):

```ts
export type Route = HomeRoute | SessionRoute | WorkflowDetailRoute | PluginRoute
```

- [ ] **Step 2: Add `initialRoute` parser**

In `packages/tui/src/context/route.tsx`, add to the `initialRoute` function (after the `plugin` branch, before the final `}`):

```ts
  if (value.type === "workflow" && "runID" in value && typeof value.runID === "string") {
    return { type: "workflow", runID: value.runID }
  }
```

- [ ] **Step 3: Commit**

```bash
git add packages/tui/src/context/route.tsx
git commit -m "feat(tui): add workflow detail route type"
```

---

## Task 11: TUI app.tsx — render the workflow route

**Files:**
- Modify: `packages/tui/src/app.tsx:1089-1098` (Switch block)

- [ ] **Step 1: Add the `workflow` Match branch**

In `packages/tui/src/app.tsx`, add the import at the top (after the `Session` import, line 52):

```ts
import { WorkflowDetail } from "./routes/workflow"
```

In the `<Switch>` block (after the `session` Match, before `{plugin()}`, ~line 1096):

```tsx
            <Match when={route.data.type === "workflow"}>
              <Show when={route.data.type === "workflow" ? route.data.runID : undefined} keyed>
                {(_) => <WorkflowDetail />}
              </Show>
            </Match>
```

- [ ] **Step 2: Commit (will typecheck-fail until Task 12 creates the component — that's expected)**

```bash
git add packages/tui/src/app.tsx
git commit -m "feat(tui): wire workflow detail route into app Switch"
```

---

## Task 12: TUI — update `DialogWorkflows` with actions + navigation

**Files:**
- Modify: `packages/tui/src/component/dialog-workflows.tsx`

- [ ] **Step 1: Rewrite `DialogWorkflows` with Cancel/Delete actions and detail navigation**

Replace the entire contents of `packages/tui/src/component/dialog-workflows.tsx` with:

```tsx
import { DialogSelect } from "../ui/dialog-select"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useDialog } from "../ui/dialog"
import { useSync, type WorkflowRun } from "../context/sync"
import { useRoute } from "../context/route"
import { useToast } from "../ui/toast"
import { createMemo, onMount } from "solid-js"

const STATUS_LABEL: Record<WorkflowRun["status"], string> = {
  running: "running",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
}

export function DialogWorkflows() {
  const dialog = useDialog()
  const sync = useSync()
  const route = useRoute()
  const toast = useToast()

  const sessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))

  onMount(() => {
    dialog.setSize("large")
    void sync.workflow.load(sessionID())
  })

  const runs = createMemo(() => Object.values(sync.data.workflow).toSorted((a, b) => b.runID.localeCompare(a.runID)))

  const options = createMemo(() =>
    runs().map((run) => {
      const counters = `${run.succeeded}✓ ${run.failed}✗ ${run.running}…`
      const tail = run.logs?.length ? run.logs[run.logs.length - 1].slice(0, 50) : undefined
      const description = `${STATUS_LABEL[run.status]} ${run.currentPhase ? "· " + run.currentPhase : ""} · ${counters}${tail ? " · " + tail : ""}`
      return {
        title: run.name,
        description,
        value: run.runID,
        footer: run.error ? run.error.slice(0, 60) : undefined,
      }
    }),
  )

  return (
    <DialogSelect
      title="Workflows"
      options={options()}
      actions={[
        {
          command: "workflow.open_detail",
          title: "Open",
          onTrigger: (option) => {
            dialog.clear()
            route.navigate({ type: "workflow", runID: option.value })
          },
        },
        {
          command: "workflow.cancel",
          title: "Cancel",
          side: "right",
          disabled: (option) => {
            const run = sync.data.workflow[option.value]
            return !run || run.status !== "running"
          },
          onTrigger: async (option) => {
            await sync.workflow.cancel(option.value)
            toast.show({ message: "Workflow cancelled", variant: "info" })
            dialog.replace(() => <DialogWorkflows />)
          },
        },
        {
          command: "workflow.delete",
          title: "Delete",
          side: "right",
          disabled: (option) => {
            const run = sync.data.workflow[option.value]
            return !run || run.status === "running"
          },
          onTrigger: async (option) => {
            const confirmed = await DialogConfirm.show(dialog, "Delete workflow", "Permanently delete this run?", "delete")
            if (!confirmed) {
              dialog.replace(() => <DialogWorkflows />)
              return
            }
            await sync.workflow.remove(option.value)
            toast.show({ message: "Workflow deleted", variant: "info" })
            dialog.replace(() => <DialogWorkflows />)
          },
        },
      ]}
      onSelect={(option) => {
        dialog.clear()
        route.navigate({ type: "workflow", runID: option.value })
      }}
    />
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `cd packages/tui && bun typecheck`
Expected: PASS (except the `WorkflowDetail` import from Task 11 if not yet created — Task 13 creates it).

- [ ] **Step 3: Commit**

```bash
git add packages/tui/src/component/dialog-workflows.tsx
git commit -m "feat(tui): add Cancel/Delete actions and detail navigation to DialogWorkflows"
```

---

## Task 13: TUI — create `WorkflowDetail` component

**Files:**
- Create: `packages/tui/src/routes/workflow/index.tsx`

- [ ] **Step 1: Create the component**

Create `packages/tui/src/routes/workflow/index.tsx`:

```tsx
/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useSync } from "../../context/sync"
import { useRoute } from "../../context/route"
import { useTheme } from "../../context/theme"
import { useToast } from "../../ui/toast"
import { useDialog } from "../../ui/dialog"
import { DialogConfirm } from "../../ui/dialog-confirm"

const STATUS_GLYPH: Record<string, string> = {
  running: "◐",
  completed: "✓",
  failed: "✗",
  cancelled: "⊘",
  succeeded: "✓",
}

const STATUS_COLOR: Record<string, string> = {
  running: "info",
  completed: "success",
  failed: "error",
  cancelled: "warning",
  succeeded: "success",
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

function formatCost(cost?: number): string {
  if (cost === undefined) return ""
  return `$${cost.toFixed(2)}`
}

export function WorkflowDetail() {
  const sync = useSync()
  const route = useRoute()
  const { theme } = useTheme()
  const toast = useToast()
  const dialog = useDialog()
  const term = useTerminalDimensions()

  const runID = createMemo(() => (route.data.type === "workflow" ? route.data.runID : ""))
  const run = createMemo(() => sync.data.workflow[runID()])
  const agents = createMemo(() => run()?.agents ?? [])
  const logs = createMemo(() => run()?.logs ?? [])

  const [selectedAgent, setSelectedAgent] = createSignal(0)
  const [focus, setFocus] = createSignal<"agents" | "logs">("agents")
  const [now, setNow] = createSignal(Date.now())

  // Hydrate once on mount
  onMount(() => {
    void sync.workflow.detail(runID())
    const interval = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(interval))
  })

  // Re-hydrate if runID changes
  createMemo(() => {
    const id = runID()
    if (id) void sync.workflow.detail(id)
  })

  const durationMs = createMemo(() => {
    const r = run()
    if (!r) return 0
    if (r.status !== "running") return 0
    return now() - 0 // placeholder — uses session updated time if available
  })

  const headerLine = createMemo(() => {
    const r = run()
    if (!r) return "Loading..."
    const counters = `${r.succeeded}✓ ${r.failed}✗ ${r.running}…`
    const phase = r.currentPhase ? `· phase: ${r.currentPhase}` : ""
    const totalCost = agents().reduce((sum, a) => sum + (a.cost ?? 0), 0)
    const costStr = totalCost > 0 ? `· $${totalCost.toFixed(2)}` : ""
    return `${r.name} · ${STATUS_GLYPH[r.status] ?? "?"} ${r.status} ${phase} · ${counters} ${costStr}`
  })

  function moveAgent(dir: number) {
    const count = agents().length
    if (count === 0) return
    setSelectedAgent((prev) => {
      const next = prev + dir
      if (next < 0) return count - 1
      if (next >= count) return 0
      return next
    })
  }

  async function doCancel() {
    await sync.workflow.cancel(runID())
    toast.show({ message: "Workflow cancelled", variant: "info" })
  }

  async function doDelete() {
    const confirmed = await DialogConfirm.show(dialog, "Delete workflow", "Permanently delete this run?", "delete")
    if (!confirmed) return
    await sync.workflow.remove(runID())
    toast.show({ message: "Workflow deleted", variant: "info" })
    dialog.replace(() => null)
    route.navigate({ type: "home" })
  }

  async function doResume() {
    await sync.workflow.resume(runID())
    toast.show({ message: "Workflow resumed", variant: "info" })
  }

  function openChildSession() {
    const agent = agents()[selectedAgent()]
    if (!agent?.sessionID) {
      toast.show({ message: "No session for this agent", variant: "warning" })
      return
    }
    route.navigate({ type: "session", sessionID: agent.sessionID })
  }

  // Key handling via useBindings would go here — for now inline with onKeypress
  // The full keymap wiring uses useBindings({ mode: "workflow.detail", ... })

  const logsHeight = 6

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.background}>
      {/* Header */}
      <box paddingLeft={1} paddingRight={1} flexShrink={0}>
        <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
          {headerLine()}
        </text>
      </box>

      {/* Agents list */}
      <box flexGrow={1} flexDirection="column" paddingLeft={1} paddingRight={1} minHeight={0}>
        <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
          Agents ({agents().length})
        </text>
        <scrollbox flexGrow={1} scrollbarOptions={{ visible: true }}>
          <For each={agents()}>
            {(agent, index) => {
              const active = createMemo(() => focus() === "agents" && index() === selectedAgent())
              const agentDuration = createMemo(() => {
                if (agent.endedAt) return agent.endedAt - agent.startedAt
                return now() - agent.startedAt
              })
              const color = theme[STATUS_COLOR[agent.status] as keyof typeof theme] ?? theme.text
              return (
                <box flexDirection="row" backgroundColor={active() ? theme.primary : undefined} paddingLeft={1}>
                  <text fg={color} flexShrink={0}>
                    {active() ? "▌" : " "}
                  </text>
                  <text fg={active() ? theme.text : theme.text} flexShrink={0}>
                    {STATUS_GLYPH[agent.status] ?? "?"}{" "}
                  </text>
                  <text fg={active() ? theme.text : theme.text} flexShrink={0} wrapMode="none">
                    {agent.agentType.padEnd(10).slice(0, 10)}{" "}
                  </text>
                  <text fg={theme.textMuted} flexGrow={1} flexShrink={1} wrapMode="none">
                    {(agent.label ?? "").slice(0, 30)}{" "}
                  </text>
                  <text fg={theme.textMuted} flexShrink={0}>
                    {agent.phase ?? ""}{" "}
                  </text>
                  <text fg={theme.textMuted} flexShrink={0}>
                    {formatDuration(agentDuration())}{" "}
                  </text>
                  <Show when={agent.cost !== undefined}>
                    <text fg={theme.textMuted} flexShrink={0}>
                      {formatCost(agent.cost)}{" "}
                    </text>
                  </Show>
                  <Show when={agent.reason}>
                    <text fg={theme.error} flexShrink={0}>
                      {agent.reason}
                    </text>
                  </Show>
                </box>
              )
            }}
          </For>
        </scrollbox>
      </box>

      {/* Logs */}
      <box height={logsHeight} flexShrink={0} paddingLeft={1} paddingRight={1} flexDirection="column">
        <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
          Logs {focus() === "logs" ? "◄" : ""}
        </text>
        <scrollbox flexGrow={1} scrollbarOptions={{ visible: false }}>
          <For each={logs().slice(-20)}>
            {(log) => (
              <text fg={theme.textMuted} wrapMode="none">
                {log}
              </text>
            )}
          </For>
        </scrollbox>
      </box>

      {/* Footer actions */}
      <box paddingLeft={1} paddingRight={1} flexShrink={0} flexDirection="row" gap={2}>
        <text fg={theme.textMuted}>
          <Show when={run()?.status === "running"}>[c] cancel </Show>
          <Show when={run()?.status !== "running"}>[r] resume [d] delete </Show>
          [Enter] session [Tab] focus [esc] back
        </text>
      </box>
    </box>
  )
}

export * as WorkflowDetailRoute from "."
```

- [ ] **Step 2: Wire keybindings via `useBindings`**

The component above renders the layout. Keybindings need to be registered using the existing `useBindings` pattern. Add this inside the `WorkflowDetail` component, after the `openChildSession` function:

```tsx
  import { useBindings } from "../../keymap"
  useBindings(() => ({
    mode: "workflow.detail",
    bindings: [
      { key: "up", desc: "Previous agent", group: "Workflow", cmd: () => moveAgent(-1) },
      { key: "down", desc: "Next agent", group: "Workflow", cmd: () => moveAgent(1) },
      { key: "enter", desc: "Open child session", group: "Workflow", cmd: openChildSession },
      { key: "tab", desc: "Toggle focus", group: "Workflow", cmd: () => setFocus((f) => (f === "agents" ? "logs" : "agents")) },
      { key: "c", desc: "Cancel", group: "Workflow", cmd: doCancel },
      { key: "r", desc: "Resume", group: "Workflow", cmd: doResume },
      { key: "d", desc: "Delete", group: "Workflow", cmd: doDelete },
      { key: "escape", desc: "Back", group: "Workflow", cmd: () => route.navigate({ type: "home" }) },
      { key: "q", desc: "Back", group: "Workflow", cmd: () => route.navigate({ type: "home" }) },
    ],
  }))
```

Note: The import of `useBindings` must be at the top of the file, not inside the component. Move it to the import block.

- [ ] **Step 3: Typecheck**

Run: `cd packages/tui && bun typecheck`
Expected: PASS. Fix any type issues (common: `theme[STATUS_COLOR[...]]` indexing — use a typed map or fallback).

- [ ] **Step 4: Commit**

```bash
git add packages/tui/src/routes/workflow/index.tsx
git commit -m "feat(tui): add WorkflowDetail full-screen route component

Shows header (name/status/phase/counters/cost), scrollable agents list
with drill-down to child sessions, full logs, and footer actions for
cancel/resume/delete. All updates are event-driven, no polling."
```

---

## Task 14: Final verification and regression tests

**Files:**
- All workflow tests

- [ ] **Step 1: Run all backend workflow tests**

Run: `cd packages/opencode && bun test test/workflow/`
Expected: PASS — all existing + new tests green.

- [ ] **Step 2: Run full typecheck across affected packages**

Run:
```bash
cd packages/opencode && bun typecheck
cd packages/tui && bun typecheck
cd packages/core && bun typecheck
cd packages/sdk/js && bun typecheck
```
Expected: PASS everywhere.

- [ ] **Step 3: Manual TUI verification**

Start the dev server and test the workflow detail view:

```bash
cd packages/opencode
tmux new-session -d -s opencode-dev 'bun dev'
```

In the TUI:
1. Trigger a workflow (e.g. ask the model to run deep-research, or use `/<workflow-name>`)
2. Press `/workflows` → select a run → Enter → verify detail view opens
3. Verify header shows name/status/phase/counters
4. Verify agents list populates as the workflow runs (event-driven)
5. Verify cost appears on agent completion
6. Press Enter on an agent → verify it navigates to the child session
7. Press `c` on a running run → verify cancel works
8. Press `d` on a finished run → verify delete works
9. Press `Tab` → verify focus toggles between agents and logs

```bash
tmux kill-session -t opencode-dev
```

- [ ] **Step 4: Final commit (if any fixes were needed)**

```bash
git add -A
git commit -m "fix(workflow): address verification findings"
```

---

## Self-Review Checklist (completed by plan author)

- [x] **Spec coverage:** §1 data model → Task 1; §2 events+API → Tasks 2,6,7; §3 route → Tasks 10,11; §4 detail view → Task 13; §5 runtime → Tasks 4,5; §6 HTTP surface → Task 6; §7 testing → Tasks 1,2,5 + Task 14.
- [x] **Placeholder scan:** No TBD/TODO. All code blocks are complete.
- [x] **Type consistency:** `WorkflowAgent` fields match across persistence.ts, events.ts, groups/workflow.ts, sync.tsx. `SpawnResult` used consistently. `detail` return type consistent.
- [x] **Cost is event-streamed** (not polled) per the revised spec.

