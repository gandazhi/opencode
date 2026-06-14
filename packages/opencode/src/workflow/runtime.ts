import { Context, Deferred, Effect, Exit, Fiber, Layer, Schema, Scope } from "effect"
import os from "node:os"
import { createHash } from "node:crypto"
import { Database } from "@opencode-ai/core/database/database"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Location } from "@opencode-ai/core/location"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { workflowRef } from "./runtime-ref"
import { Config } from "@/config/config"
import { EffectBridge } from "@/effect/bridge"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Provider } from "@/provider/provider"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { Identifier } from "@/id/id"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { Agent } from "@/agent/agent"
import { deriveSubagentSessionPermission } from "@/agent/subagent-permissions"
import type { SessionID } from "@/session/schema"
import { parseMeta } from "./meta"
import { evalScript, type HostFn } from "./sandbox"
import { makeFileHooks, resolveInWorkspace } from "./workspace"
import { isInlineScript, resolveWorkflowScript } from "./resolve"
import { WorkflowAgentEnded, WorkflowAgentFailed, WorkflowAgentStarted, WorkflowChildFailed, WorkflowFinished, WorkflowLog, WorkflowPhase, WorkflowProgress, WorkflowStarted } from "./events"
import { WorkflowPersistence, journalKeyBase } from "./persistence"
import type { AgentRecord, RunSummary, WorkflowTokens } from "./persistence"

type ProviderID = ProviderV2.ID
type ModelID = ModelV2.ID

type Cfg = ConfigV1.Info & {
  workflow?: {
    maxConcurrentAgents?: number
    maxDepth?: number
    maxLifecycleAgents?: number
  }
}

const locks = new Map<string, Promise<unknown>>()
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>((r) => (release = r))
  locks.set(key, prev.then(() => next))
  await prev
  try {
    return await fn()
  } finally {
    release()
    if (locks.get(key) === next) locks.delete(key)
  }
}

/** Default wall-clock budget for a whole workflow script (12h research default). */
const SCRIPT_DEADLINE_MS = 12 * 60 * 60 * 1000
/** Unique sentinel for the per-agent timeout race: a timeout winner can never
 * collide with an agent deliverable (those are object | string | null). */
const STRAGGLER_TIMEOUT = Symbol("straggler-timeout")
/** Hard ceiling on total agents a single run may spawn (lifecycle cap). */
const MAX_LIFECYCLE_AGENTS = 1000
/** Default soft cap on concurrent agents when the caller does not specify one. */
const DEFAULT_MAX_CONCURRENT = 16
/** Marker prefix on errors from STRUCTURAL workflow faults (cycle, over-depth,
 * unknown name) — workflow-wiring bugs that must fail the whole tree loud rather
 * than degrade to the never-throw null that a child's RUNTIME failure yields. The
 * workflow() hook re-propagates any child outcome whose error carries this marker,
 * so the fault surfaces at the root run the user launched. */
const WORKFLOW_STRUCTURAL_ERROR = "WorkflowStructuralError"

type RunStatus = "running" | "completed" | "failed" | "cancelled"

export type RunOutcome =
  | { status: "completed"; result: unknown }
  | { status: "failed"; error: string }
  | { status: "cancelled" }

interface RunEntry {
  runID: string
  sessionID: SessionID
  status: RunStatus
  deferred: Deferred.Deferred<RunOutcome>
  fiber: Fiber.Fiber<void> | undefined
  childActorIDs: Set<string>
  worktrees: Set<string> // worktree directories pending disposition, for cancel cleanup
  childRunIDs: Set<string> // child workflow runIDs, for recursive cancel/reclaim
  name: string
  running: number
  succeeded: number
  failed: number
  agentCount: number
  capWarned: boolean
  // Model refs already warned about this run, so an unresolvable ref (e.g. a
  // workflow using "lite" with no model_groups.lite configured) logs ONCE per
  // run instead of once per agent spawn. Per-run, not layer-global, so a later
  // run re-warns. See resolveAgentModel.
  warnedModelRefs: Set<string>
  currentPhase: string | undefined
  // Location captured at launch time so debounced flushCounters (published via
  // layerBridge which lacks InstanceRef) can attach location explicitly. Without
  // this, WorkflowProgress events lack location and get dropped by the SSE
  // stream's directory filter, so TUI counters never update in real-time.
  eventLocation: Location.Info | undefined
}

interface StartInput {
  script: string
  sessionID: SessionID
  parentActorID: string
  args?: unknown
  model?: { providerID: ProviderID; modelID: ModelID }
  maxConcurrentAgents?: number
  // Hard ceiling on total agents this run may spawn (lifecycle cap). Defaults to
  // MAX_LIFECYCLE_AGENTS (1000). Over-cap agent() calls return null (graceful
  // degradation, never-throw), NOT throw — so a fan-out that wants more agents
  // than the cap degrades to the cap-limited subset instead of aborting the run.
  // Lowerable for tests; tunable in prod.
  maxLifecycleAgents?: number
  /** Per-agent wall-clock timeout (ms). When an individual agent() call's spawned
   * child produces no terminal outcome within this window, it is gracefully
   * cancelled and agent() resolves to null (the never-throw failure sentinel), so
   * one hung agent (e.g. an LLM TTFT wall) cannot stall a parallel/pipeline barrier
   * indefinitely. Default undefined = OFF (only the global scriptDeadlineMs bounds a
   * run). A per-call agent(prompt,{timeoutMs}) overrides this. */
  agentTimeoutMs?: number
  scriptDeadlineMs?: number
  // Internal (resume-only): when true, launch ignores any persisted journal and
  // truncates the stale `.jsonl` before the run appends. resume() sets this on the
  // script-change path (stored script_sha != current script's sha, MR104 P1-2) so
  // an EDITED script never replays results journaled against the OLD body. start()
  // never sets it (a fresh runID has no prior journal — nothing to invalidate).
  freshJournal?: boolean
  /** Root dir the guest's file primitives (readFile/writeFile/glob/exists) are
   * jailed to. Defaults to the caller's worktree. A child workflow inherits the
   * parent's workspace unless its workflow() opts override it. */
  workspace?: string
  /** Resolved names of ancestor workflows (root = empty). A workflow() whose
   * resolved child name is already here is a cycle → throw. */
  lineage?: readonly string[]
  /** Current nesting depth (root run = 0). */
  depth?: number
  /** Max nesting depth before workflow() throws. Defaults to config (8). */
  maxDepth?: number
}

/** Options the guest may pass to `agent(prompt, opts?)`. */
interface AgentOpts {
  agentType?: string
  tools?: readonly string[]
  /** A model reference resolved host-side via Provider.resolveModelRef: either a
   *  "provider/model" literal or a configured tier/group name (e.g. "lite").
   *  Omitted → the run's default model. Unknown group → falls back to the run
   *  default (never throws to the guest). */
  model?: string
  schema?: Record<string, unknown>
  isolation?: "worktree"
  label?: string
  phase?: string
  /** Per-call override of the run's agentTimeoutMs (ms). */
  timeoutMs?: number
}

export interface Interface {
  readonly start: (input: StartInput) => Effect.Effect<{ runID: string }>
  readonly status: (input: {
    runID: string
  }) => Effect.Effect<{ status: RunStatus | "unknown"; agentCount: number; currentPhase?: string }>
  readonly wait: (input: { runID: string; timeoutMs?: number }) => Effect.Effect<RunOutcome>
  readonly cancel: (input: { runID: string }) => Effect.Effect<void>
  readonly list: (input?: { sessionID?: SessionID }) => Effect.Effect<RunSummary[]>
  readonly resume: (input: { runID: string; agentTimeoutMs?: number }) => Effect.Effect<{ runID: string; resumed: boolean }>
  readonly detail: (input: {
    runID: string
  }) => Effect.Effect<
    | { status: "unknown" }
    | { run: RunSummary; agents: AgentRecord[]; logs: string[] }
  >
  readonly remove: (input: { runID: string }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorkflowRuntime") {}

/** A plain promise-based semaphore: at most `max` concurrent `run` callbacks. */
function makeSemaphore(max: number) {
  let active = 0
  const queue: Array<() => void> = []
  const release = () => {
    active--
    const next = queue.shift()
    if (next) next()
  }
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const attempt = () => {
          active++
          fn().then(
            (value) => {
              release()
              resolve(value)
            },
            (err) => {
              release()
              reject(err)
            },
          )
        }
        if (active < max) attempt()
        else queue.push(attempt)
      })
    },
  }
}

function cpuCount(): number {
  const n = os.cpus().length
  return n > 0 ? n : 4
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const config = yield* Config.Service
    const database = yield* Database.Service
    const promptsSvc = yield* SessionPrompt.Service
    const layerBridge = yield* EffectBridge.make()
    const scope = yield* Scope.Scope
    const runs = new Map<string, RunEntry>()

    const warnOnce = (warned: Set<string>, ref: string) => {
      if (warned.has(ref)) return
      warned.add(ref)
      Effect.runFork(Effect.logWarning("workflow agent model ref did not resolve — using run default", { ref }))
    }

    const resolveAgentModel = (
      ref: string | undefined,
      fallback: { providerID: ProviderID; modelID: ModelID } | undefined,
      warned: Set<string>,
    ): Effect.Effect<{ providerID: ProviderID; modelID: ModelID } | undefined> =>
      ref === undefined
        ? Effect.succeed(fallback)
        : ref.includes("/")
          ? Effect.sync(() => {
              try {
                return Provider.parseModel(ref)
              } catch {
                warnOnce(warned, ref)
                return fallback
              }
            })
          : Effect.sync(() => {
              warnOnce(warned, ref)
              return fallback
            })

    // Process-wide concurrency ceiling: ONE semaphore shared by every run
    // (including nested children), so tree-wide concurrent agents can never
    // exceed it regardless of nesting depth. It is a PURE process/config property,
    // sized SOLELY from config.workflow.maxConcurrentAgents (falling back to the
    // min(16, 2×cores) default) — NEVER seeded or raised by any per-launch
    // maxConcurrentAgents input. A per-run input only ever NARROWS that run's own
    // semaphore (clamped ≤ global, below); it can neither raise the global nor bind
    // a later run to an earlier run's cap. Resolved LAZILY on the first launch
    // (config.get reads the per-instance ALS context, live inside launch but NOT at
    // layer-build time) and memoized at service scope so every subsequent launch() —
    // including nested children — shares the same semaphore. `cfg`/`globalMax`/
    // `globalSem` are reused by later tasks (T12 maxDepth, T14 maxLifecycleAgents).
    let cfg: Cfg | undefined
    let globalMax = 0
    let globalSem: ReturnType<typeof makeSemaphore> | undefined
    const ensureGlobal = Effect.fn("WorkflowRuntime.ensureGlobal")(function* () {
      if (globalSem) return globalSem
      // Resolve config once (this is the only suspension point). Cached on `cfg`
      // for reuse by later per-run reads (maxDepth, maxLifecycleAgents).
      cfg ??= yield* config.get()
      globalMax = Math.max(
        1,
        cfg.workflow?.maxConcurrentAgents ?? Math.min(DEFAULT_MAX_CONCURRENT, 2 * Math.max(1, cpuCount())),
      )
      // Assign synchronously with ??= so two concurrent first-launches that both
      // passed the guard above (the `config.get()` await is a suspension point)
      // converge on ONE semaphore instead of transiently doubling the ceiling.
      // Frozen for the process lifetime: a later config change to
      // maxConcurrentAgents does NOT rebuild it (acceptable while workflow is
      // experimental — the global ceiling is a process/config property).
      globalSem ??= makeSemaphore(globalMax)
      return globalSem
    })

    // Debounced counter flush: coalesce high-rate running/succeeded/failed updates
    // to at most one DB write per ~250ms per run. flushNow is the synchronous final
    // flush on terminal. All best-effort.
    const flushTimers = new Map<string, ReturnType<typeof setTimeout>>()
    // Persist counters to DB AND publish a workflow.progress event so clients
    // (TUI) can show live agent counts. Single source of truth: the in-memory
    // entry. Publishing here (rather than at each ++ site) coalesces the
    // high-frequency bursts the semaphore already debounces.
    const flushCounters = (entry: RunEntry) =>
      Effect.gen(function* () {
        yield* WorkflowPersistence.flushCounters({
          runID: entry.runID,
          running: entry.running,
          succeeded: entry.succeeded,
          failed: entry.failed,
        }).pipe(Effect.ignore)
        yield* events
          .publish(
            WorkflowProgress,
            {
              sessionID: entry.sessionID,
              runID: entry.runID,
              running: entry.running,
              succeeded: entry.succeeded,
              failed: entry.failed,
            },
            entry.eventLocation ? { location: entry.eventLocation } : undefined,
          )
          .pipe(Effect.ignore)
      })
    const flushNow = (entry: RunEntry) => {
      const t = flushTimers.get(entry.runID)
      if (t) {
        clearTimeout(t)
        flushTimers.delete(entry.runID)
      }
      return flushCounters(entry)
    }
    const scheduleFlush = (entry: RunEntry) => {
      if (flushTimers.has(entry.runID)) return
      flushTimers.set(
        entry.runID,
        setTimeout(() => {
          flushTimers.delete(entry.runID)
          layerBridge.fork(flushCounters(entry))
        }, 250),
      )
    }

    const reclaim = (entry: RunEntry) =>
      Effect.gen(function* () {
        yield* Effect.forEach(
          [...entry.childRunIDs],
          (childRunID) =>
            Effect.gen(function* () {
              const child = runs.get(childRunID)
              if (child && child.status === "running") yield* cancelEntry(child)
            }).pipe(Effect.ignore),
          { concurrency: "unbounded", discard: true },
        )
      })

    const cancelEntry = (entry: RunEntry): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (entry.status !== "running") return
        yield* reclaim(entry)
        yield* flushNow(entry)
        yield* WorkflowPersistence.recordTerminal({ runID: entry.runID, status: "cancelled" }).pipe(Effect.ignore)
        if (entry.fiber) yield* Fiber.interrupt(entry.fiber)
        entry.status = "cancelled"
        yield* Deferred.succeed(entry.deferred, { status: "cancelled" })
        yield* events.publish(WorkflowFinished, { sessionID: entry.sessionID, runID: entry.runID, status: "cancelled" })
      }).pipe(Effect.provideService(Database.Service, database))

    const waitFor = (childRunID: string) =>
      Effect.gen(function* () {
        const child = runs.get(childRunID)
        if (!child) return { status: "failed" as const, error: "child run missing" }
        return yield* Deferred.await(child.deferred)
      })

    const launch = Effect.fn("WorkflowRuntime.launch")(function* (input: StartInput, runID: string, name: string) {
      // The guest body is the script with the `meta` literal blanked out (parseMeta
      // preserves line numbers). start already validated meta and resume only loads
      // a previously-validated script, so this parse is purely to extract the body;
      // it never gates here. Fall back to the raw script if parse somehow fails.
      const parsed = parseMeta(input.script)
      const body = parsed.ok ? parsed.body : input.script
      const instanceCtx = yield* InstanceRef
      const workspaceID = yield* WorkspaceRef
      const workspaceRoot = input.workspace ?? instanceCtx?.worktree ?? ""
      const fileHooks = makeFileHooks(workspaceRoot)
      const deferred = yield* Deferred.make<RunOutcome>()
      const eventLocation =
        instanceCtx !== undefined
          ? new Location.Info({
              directory: AbsolutePath.make(instanceCtx.directory),
              ...(workspaceID ? { workspaceID } : {}),
              project: { id: Project.ID.make(instanceCtx.project.id), directory: AbsolutePath.make(instanceCtx.worktree) },
            })
          : undefined
      const entry: RunEntry = {
        runID,
        sessionID: input.sessionID,
        status: "running",
        deferred,
        fiber: undefined,
        childActorIDs: new Set<string>(),
        worktrees: new Set<string>(),
        childRunIDs: new Set<string>(),
        name,
        running: 0,
        succeeded: 0,
        failed: 0,
        agentCount: 0,
        capWarned: false,
        warnedModelRefs: new Set<string>(),
        currentPhase: undefined,
        eventLocation,
      }
      runs.set(runID, entry)
      // Stamp a sha256 of the FULL script body (the exact bytes writeScript persists
      // and resume's readScript reads back), so resume can detect a between-cycle
      // edit by comparing this to the current file's sha — apples-to-apples, MR104
      // P1-2. recordStart re-stamps it on every (re)launch, so a changed-script
      // relaunch overwrites the stale sha and a subsequent resume replays correctly.
      const scriptSha = createHash("sha256").update(input.script).digest("hex")
      yield* WorkflowPersistence.recordStart({
        runID,
        sessionID: input.sessionID,
        name,
        parentActorID: input.parentActorID,
        args: input.args,
        scriptSha,
        agentTimeoutMs: input.agentTimeoutMs,
      }).pipe(Effect.ignore)
      yield* WorkflowPersistence.writeScript(runID, input.script).pipe(Effect.ignore)

      // Replay journal: prior agent() results (empty on a fresh run). On resume,
      // a cache hit returns instantly with no spawn; misses spawn + append. The
      // occ counter disambiguates byte-identical calls into distinct slots.
      // freshJournal (resume's script-change path) truncates the stale `.jsonl`
      // FIRST so loadJournal returns empty AND the run's appends don't interleave
      // with results journaled against the old script body — a later resume would
      // otherwise read both and replay the wrong results.
      if (input.freshJournal) yield* WorkflowPersistence.clearJournal(runID).pipe(Effect.ignore)
      const journal = yield* WorkflowPersistence.loadJournal(runID)
      const occ = new Map<string, number>()
      const pass = journal.pass

      // Capture the bridge BEFORE forking so it snapshots the caller's
      // Instance/Workspace context — the quickjs Promise boundary in agent()
      // would otherwise lose it.
      const bridge = yield* EffectBridge.make()

      // Resolve the process-wide ceiling NOW (under the live Instance context) so
      // its semaphore object exists before any spawn site closes over it. Sized
      // PURELY from config (memoized after the first launch); a per-launch
      // maxConcurrentAgents never seeds or raises it — it only narrows this run's
      // own semaphore below.
      const globalSemLocal = yield* ensureGlobal()
      // Nesting safety (T12): carried through every run. lineage = resolved names of
      // ancestor workflows (root = empty); depth = this run's level (root = 0). A
      // workflow() whose child name is already in lineage is a cycle, and a child
      // beyond maxDepth is over-deep — both throw at the call site (workflowHook).
      // maxDepth precedence: explicit per-run input > config > module default 8.
      const lineage = input.lineage ?? []
      const depth = input.depth ?? 0
      const maxDepth = input.maxDepth ?? cfg?.workflow?.maxDepth ?? 8
      // Per-run soft cap: defaults to the global ceiling, clamped to ≤ global so a
      // child can shrink its own concurrency but never exceed the process ceiling.
      // The 2×cores clamp is GONE — the global semaphore is the real throttle.
      const requested = input.maxConcurrentAgents ?? globalMax
      const max = Math.max(1, Math.min(requested, globalMax))
      const sem = makeSemaphore(max)
      // Lifecycle cap (total agents over the run's life). Resolved once here so
      // both spawn paths (shared + isolated) share it; over-cap calls return null.
      const lifecycleCap = input.maxLifecycleAgents ?? cfg?.workflow?.maxLifecycleAgents ?? MAX_LIFECYCLE_AGENTS
      // Over-cap → null (see maxLifecycleAgents doc): warn ONCE per run so the
      // dropped work is visible without spamming a log line per over-cap call.
      const warnCapOnce = () => {
        if (entry.capWarned) return
        entry.capWarned = true
        Effect.runFork(Effect.logWarning("workflow lifecycle agent cap reached — over-cap agents return null", { runID, cap: lifecycleCap }))
      }
      // Per-agent wall-clock timeout. Run-level default (OFF unless set); a per-call
      // opts.timeoutMs overrides it. Resolved per agent() call since opts is per-call.
      const runAgentTimeoutMs = input.agentTimeoutMs
      // Race a child's outcome-await against the effective per-agent timeout. On a
      // TRUE timeout: gracefully cancel that one child (the lever reclaim uses) and
      // yield null — the never-throw sentinel the guest already tolerates, so a hung
      // agent can't stall a parallel/pipeline barrier. A genuine null deliverable
      // (agent failed fast) is NOT a timeout → no cancel. No timeout configured
      // (undefined / <=0) ⇒ await unbounded (current behavior, only scriptDeadline bounds).
      const awaitWithTimeout = <A>(
        _sessionID: string,
        opts: AgentOpts,
        await_: Effect.Effect<A | null>,
        onTimeout?: () => void,
      ) => {
        const ms = opts.timeoutMs ?? runAgentTimeoutMs
        if (!ms || ms <= 0) return await_
        return Effect.raceFirst(
          await_,
          Effect.sleep(`${ms} millis`).pipe(Effect.as(STRAGGLER_TIMEOUT as unknown as A | null)),
        ).pipe(
          Effect.flatMap((r) =>
            r === (STRAGGLER_TIMEOUT as unknown)
              ? Effect.sync(() => {
                  try {
                    onTimeout?.()
                  } catch {
                    /* observability must never escape */
                  }
                  return null
                })
              : Effect.succeed(r),
          ),
        )
      }

      // Publish a WorkflowAgentFailed event for an agent() call that resolved to
      type FailReason = "over-cap" | "spawn-reject" | "timeout" | "actor-error" | "no-deliverable"
      const publishAgentFailed = (
        o: AgentOpts,
        reason: FailReason,
        info: { errorMessage?: string } = {},
      ) => {
        try {
          bridge.fork(
            events
              .publish(WorkflowAgentFailed, {
                sessionID: input.sessionID,
                runID,
                agentType: o.agentType ?? "general",
                label: o.label,
                phase: o.phase ?? entry.currentPhase,
                reason,
                errorMessage: info.errorMessage,
              })
              .pipe(Effect.ignore),
          )
        } catch {
          /* observability must never escape */
        }
      }

      yield* events.publish(WorkflowStarted, { sessionID: input.sessionID, runID, name })

      type SpawnResult = { value: unknown; childID?: string; reason: FailReason; cost?: number; tokens?: WorkflowTokens }

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
        let tokens: WorkflowTokens | undefined
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
              yield* WorkflowPersistence.appendJournalSync(runID, [
                {
                  t: "agent_start",
                  key,
                  sessionID: child.id,
                  agentType: o.agentType ?? "general",
                  label: o.label,
                  phase: o.phase ?? entry.currentPhase,
                  ts: startTs,
                  pass,
                },
              ]).pipe(Effect.ignore)
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
                      const info = msg.info as {
                        cost?: number
                        tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
                      }
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

      const agent: HostFn = (prompt: unknown, opts?: unknown) => {
        const o = (opts ?? {}) as AgentOpts
        const promptStr = String(prompt)
        const base = journalKeyBase(promptStr, {
          agentType: o.agentType,
          model: o.model,
          schema: o.schema,
          phase: o.phase,
        })
        const n = occ.get(base) ?? 0
        occ.set(base, n + 1)
        const key = base + ":" + n
        if (journal.results.has(key)) {
          entry.succeeded++
          scheduleFlush(entry)
          return Promise.resolve(journal.results.get(key))
        }
        return (async () => {
          let spawnResult: SpawnResult
          const result = await sem.run(async () =>
            globalSemLocal.run(async () => {
              if (entry.agentCount >= lifecycleCap) {
                warnCapOnce()
                publishAgentFailed(o, "over-cap")
                spawnResult = { value: null, reason: "over-cap" }
                return null
              }
              entry.agentCount++
              const resolvedModel = await bridge.promise(resolveAgentModel(o.model, input.model, entry.warnedModelRefs))
              spawnResult = await spawnShared(key, promptStr, o, resolvedModel)
              return spawnResult.value
            }),
          )
          const ok = result !== null
          const sr = spawnResult!
          // Emit agent_end (journal + event) with cost/tokens captured at completion
          const endTs = Date.now()
          await bridge.promise(
            WorkflowPersistence.appendJournalSync(runID, [
              {
                t: "agent_end",
                key,
                ok,
                reason: ok ? undefined : sr.reason,
                ts: endTs,
                ...(sr.cost !== undefined ? { cost: sr.cost } : {}),
                ...(sr.tokens ? { tokens: sr.tokens } : {}),
                pass,
              },
            ]).pipe(Effect.ignore),
          )
          bridge.fork(
            events.publish(WorkflowAgentEnded, {
              sessionID: input.sessionID,
              runID,
              key,
              status: ok ? ("succeeded" as const) : ("failed" as const),
              reason: ok ? undefined : sr.reason,
              ...(sr.cost !== undefined ? { cost: sr.cost } : {}),
              ...(sr.tokens ? { tokens: sr.tokens } : {}),
            }),
          )
          if (ok) {
            await bridge.promise(
              WorkflowPersistence.appendJournalSync(runID, [{ t: "agent", key, result, pass }]).pipe(Effect.ignore),
            )
          }
          return result
        })()
      }

      const phase: HostFn = (title: unknown) => {
        entry.currentPhase = String(title)
        bridge.fork(WorkflowPersistence.recordPhase({ runID, phase: String(title) }).pipe(Effect.ignore))
        bridge.fork(WorkflowPersistence.appendJournal(runID, { t: "phase", title: String(title), pass }).pipe(Effect.ignore))
        bridge.fork(events.publish(WorkflowPhase, { sessionID: input.sessionID, runID, title: String(title) }))
        return undefined
      }

      const logHook: HostFn = (message: unknown) => {
        bridge.fork(WorkflowPersistence.appendJournal(runID, { t: "log", msg: String(message), pass }).pipe(Effect.ignore))
        bridge.fork(events.publish(WorkflowLog, { sessionID: input.sessionID, runID, message: String(message) }))
        return undefined
      }

      // workflow(nameOrScript, args?, opts?) — schedule a CHILD workflow as its
      // own independent sub-run, awaited inline. Mirrors agent()→Actor.spawn one
      // level up: mint a deterministic child runID (stable across resume so the
      // parent journal can find the child), resolve name→script, launch it, await
      // its RunOutcome. A child that fails resolves to null (never-throw, like
      // agent()) so parallel/pipeline over children degrade gracefully. An unknown
      // name THROWS (Effect.die → the guest call rejects → the run fails loud).
      const workflowOcc = new Map<string, number>()
      const workflowHook: HostFn = (nameOrScript: unknown, childArgs?: unknown, opts?: unknown) => {
        const spec = String(nameOrScript)
        const o = (opts ?? {}) as { workspace?: string; maxConcurrentAgents?: number }
        // Content key over the SEMANTIC inputs that reach the child (spec + args).
        // occ disambiguates byte-identical workflow() calls into distinct slots.
        const base = createHash("sha256")
          .update(JSON.stringify({ spec, args: childArgs ?? null }))
          .digest("hex")
        const n = workflowOcc.get(base) ?? 0
        workflowOcc.set(base, n + 1)
        const key = base + ":" + n
        // Parent-journal hit: a completed child replays its result with NO relaunch
        // (the two-level resume short-circuit — parent journal skips the whole child
        // sub-run; the child's own journal would handle agent-level skip if it were
        // re-run). Counts as a succeeded outcome so the live view reflects replay
        // progress. The "wf:" prefix keeps this slot namespace disjoint from agent() keys.
        if (journal.results.has("wf:" + key)) {
          entry.succeeded++
          scheduleFlush(entry)
          return Promise.resolve(journal.results.get("wf:" + key))
        }
        const childRunID = "wf_" + createHash("sha256").update(runID + key).digest("hex")
        return bridge.promise(
          Effect.gen(function* () {
            const childScript = isInlineScript(spec)
              ? spec
              : yield* Effect.promise(() => resolveWorkflowScript(spec, workspaceRoot, instanceCtx?.worktree ?? ""))
            if (childScript === null)
              return yield* Effect.die(new Error(`${WORKFLOW_STRUCTURAL_ERROR}: unknown workflow: ${JSON.stringify(spec)}`))
            // Nesting guards (T12) — LAUNCH path only (a journal HIT early-returned
            // above without deriving childName/childRunID, and a cached child already
            // completed in a prior pass, so re-validating would be wrong). The child's
            // lineage name is its resolved saved name, or a content-hash label for an
            // inline body so distinct inline children don't collide AND an inline body
            // that re-invokes itself is still caught as a cycle. Over-depth and cycle
            // are SCRIPT-LOGIC errors → Effect.die (fail loud), same posture as the
            // unknown-name die above. The guest await rejects → the orchestrator script
            // throws → the parent run fails with this message.
            // NOTE: saved names key on the name alone (args-independent), so saved
            // A→A with different args IS a cycle; an inline body keys on its content
            // hash WHICH INCLUDES args, so inline A→A with different args is NOT a
            // cycle and is bounded only by maxDepth.
            const childName = isInlineScript(spec) ? "inline:" + base.slice(0, 12) : spec
            if (depth + 1 > maxDepth) {
              return yield* Effect.die(new Error(`${WORKFLOW_STRUCTURAL_ERROR}: workflow nesting exceeds maxDepth (${maxDepth})`))
            }
            if (lineage.includes(childName)) {
              return yield* Effect.die(
                new Error(`${WORKFLOW_STRUCTURAL_ERROR}: workflow cycle detected: ${childName} is already an ancestor`),
              )
            }
            entry.childRunIDs.add(childRunID)
            // The child is an independent sub-run: it gets its own per-run lifecycle
            // cap + per-agent timeout (defaults), deliberately NOT inherited from the
            // parent. Tree-wide concurrency is bounded by the global semaphore,
            // not by propagating these per-run knobs.
            yield* launch(
              {
                script: childScript,
                sessionID: input.sessionID,
                parentActorID: input.parentActorID,
                args: childArgs,
                model: input.model,
                // A child may narrow its workspace to a subdir but never widen it
                // beyond the parent's root — resolveInWorkspace throws on escape
                // (a script-logic error → fail loud), same posture as the jail itself.
                workspace: o.workspace ? resolveInWorkspace(workspaceRoot, String(o.workspace)) : workspaceRoot,
                maxConcurrentAgents: o.maxConcurrentAgents,
                scriptDeadlineMs: input.scriptDeadlineMs,
                // Extend the nesting context for the child (T12): append this child to
                // the ancestor lineage, increment depth, carry the same cap down.
                lineage: [...lineage, childName],
                depth: depth + 1,
                maxDepth,
              },
              childRunID,
              isInlineScript(spec) ? "inline" : spec,
            )
            const childOutcome = yield* waitFor(childRunID)
            // Structural faults (cycle / depth / unknown-name) are workflow-wiring
            // BUGS, not runtime conditions — propagate them loud instead of degrading
            // to null like a child's runtime failure, so the fault surfaces at the root
            // run. Each ancestor re-dies in turn; slice from the marker so the message
            // doesn't accrete a "workflow script rejected:" prefix at every level.
            if (childOutcome.status === "failed" && childOutcome.error.includes(WORKFLOW_STRUCTURAL_ERROR)) {
              const idx = childOutcome.error.indexOf(WORKFLOW_STRUCTURAL_ERROR)
              return yield* Effect.die(new Error(childOutcome.error.slice(idx)))
            }
            // Runtime failure (NOT structural — that path re-died above): the child's
            // agents failed, it hit its deadline, or it was cancelled. workflow() still
            // returns null (never-throw); this event records WHY for triage. Mirrors
            // WorkflowAgentFailed. Fire-and-forget so a bus problem can't break the run.
            if (childOutcome.status !== "completed") {
              yield* events
                .publish(WorkflowChildFailed, {
                  sessionID: input.sessionID,
                  runID,
                  childRunID,
                  name: isInlineScript(spec) ? "inline" : spec,
                  status: childOutcome.status, // "failed" | "cancelled"
                  ...(childOutcome.status === "failed" ? { error: childOutcome.error } : {}),
                })
                .pipe(Effect.ignore)
            }
            const value = childOutcome.status === "completed" ? (childOutcome.result ?? null) : null
            // Journal ONLY a successful child (null = failure → not cached → re-runs
            // on resume, self-heal — same contract as agent()). Synchronous append so
            // it survives a mid-run kill.
            if (value !== null) {
              yield* WorkflowPersistence.appendJournalSync(runID, [
                { t: "agent", key: "wf:" + key, result: value, pass },
              ]).pipe(Effect.ignore)
            }
            return value
          }),
        )
      }

      const hooks: Record<string, HostFn> = {
        agent,
        phase,
        log: logHook,
        workflow: workflowHook,
        readFile: fileHooks.readFile,
        writeFile: fileHooks.writeFile,
        glob: fileHooks.glob,
        exists: fileHooks.exists,
      }

      const work = Effect.gen(function* () {
        // Object-form tryPromise: bare tryPromise wraps any rejection as an
        // UnknownError whose .message is the useless "An error occurred in
        // Effect.tryPromise" (the real error lands in .cause), so the failed-run
        // error field / WorkflowFinished.error below would be opaque. Catching to
        // the raw Error makes result.failure the sandbox Error itself, whose
        // .message already carries the guest {name,message,stack} (vm.dump
        // preserves it through the sandbox throw site) — a script-logic crash is
        // then diagnosable from the run's error alone, no repro needed.
        // Per-run PRNG seed = first 4 bytes of sha1(runID). runID is unique-per-run
        // and persisted, so resume of the SAME run derives the SAME seed → guest
        // Math.random replays identically (the replay invariant). Two UNRELATED runs
        // of the same script get DIFFERENT runIDs → different seeds → different
        // sequences, so sampling-style scripts get fresh coverage instead of
        // repeating the same picks. Bun's lifetime-classify verification sample
        // is the motivating use case.
        const seed = createHash("sha1").update(runID).digest().readUInt32BE(0)
        const result = yield* Effect.tryPromise({
          try: () => evalScript(body, hooks, { deadlineMs: input.scriptDeadlineMs ?? SCRIPT_DEADLINE_MS, args: input.args, seed }),
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }).pipe(Effect.result)

        if (result._tag === "Success") {
          entry.status = "completed"
          yield* flushNow(entry)
          yield* WorkflowPersistence.recordTerminal({ runID, status: "completed" }).pipe(Effect.ignore)
          yield* Deferred.succeed(deferred, { status: "completed", result: result.success })
          yield* events.publish(WorkflowFinished, { sessionID: input.sessionID, runID, status: "completed" })
          const prompts = yield* SessionPrompt.Service
          yield* prompts
            .prompt({
              sessionID: input.sessionID,
              parts: [
                {
                  type: "text" as const,
                  synthetic: true,
                  text:
                    `Workflow completed. run_id: ${runID}\n` +
                    JSON.stringify(result.success ?? null).slice(0, 4000),
                },
              ],
            })
            .pipe(Effect.ignore)
          return
        }
        yield* reclaim(entry)
        const error = result.failure instanceof Error ? result.failure.message : String(result.failure)
        entry.status = "failed"
        Effect.runFork(Effect.logWarning("workflow run failed", { runID, error }))
        yield* flushNow(entry)
        yield* WorkflowPersistence.recordTerminal({ runID, status: "failed", error }).pipe(Effect.ignore)
        yield* Deferred.succeed(deferred, { status: "failed", error })
        yield* events.publish(WorkflowFinished, { sessionID: input.sessionID, runID, status: "failed", error })
        const prompts = yield* SessionPrompt.Service
        yield* prompts
          .prompt({
            sessionID: input.sessionID,
            parts: [
              {
                type: "text" as const,
                synthetic: true,
                text: `Workflow failed. run_id: ${runID}\nerror: ${error}`,
              },
            ],
          })
          .pipe(Effect.ignore)
      })

      entry.fiber = yield* work.pipe(Effect.forkIn(scope))
      return { runID }
    })

    const start = Effect.fn("WorkflowRuntime.start")(function* (input: StartInput) {
      const parsed = parseMeta(input.script)
      if (!parsed.ok) return yield* Effect.die(parsed.error)
      const runID = Identifier.descending("workflow")
      return yield* launch(input, runID, parsed.meta.name).pipe(
        Effect.provideService(Database.Service, database),
        Effect.provideService(SessionPrompt.Service, promptsSvc),
      )
    })

    const status = Effect.fn("WorkflowRuntime.status")(function* (input: { runID: string }) {
      const entry = runs.get(input.runID)
      if (!entry) return { status: "unknown" as const, agentCount: 0 }
      return {
        status: entry.status,
        agentCount: entry.agentCount,
        ...(entry.currentPhase !== undefined ? { currentPhase: entry.currentPhase } : {}),
      }
    })

    const wait = Effect.fn("WorkflowRuntime.wait")(function* (input: { runID: string; timeoutMs?: number }) {
      const entry = runs.get(input.runID)
      if (!entry) return { status: "failed" as const, error: `unknown runID ${input.runID}` }
      if (input.timeoutMs === undefined) return yield* Deferred.await(entry.deferred)
      const raced = yield* Deferred.await(entry.deferred).pipe(
        Effect.timeout(input.timeoutMs),
        Effect.catchTag("TimeoutError", () => Effect.succeed(null)),
      )
      if (raced === null) return { status: "failed" as const, error: "workflow wait timed out" }
      return raced
    })

    const cancel = Effect.fn("WorkflowRuntime.cancel")(function* (input: { runID: string }) {
      const entry = runs.get(input.runID)
      if (!entry) return
      yield* cancelEntry(entry)
    })

    const list = Effect.fn("WorkflowRuntime.list")(function* (input?: { sessionID?: SessionID }) {
      return yield* WorkflowPersistence.list(input).pipe(
        Effect.provideService(Database.Service, database),
      )
    })

    const resume = Effect.fn("WorkflowRuntime.resume")(function* (input: { runID: string; agentTimeoutMs?: number }) {
      return yield* Effect.promise(() =>
        withLock("workflow-resume:" + input.runID, () =>
          Effect.runPromise(
            Effect.gen(function* () {
              const live = runs.get(input.runID)
              if (live && live.status === "running") return { runID: input.runID, resumed: false }
              const row = yield* WorkflowPersistence.load(input.runID)
              if (!row) return { runID: input.runID, resumed: false }
              const read = yield* WorkflowPersistence.readScript(input.runID).pipe(Effect.exit)
              const script = Exit.isSuccess(read) ? read.value : ""
              if (!script) return { runID: input.runID, resumed: false }
              const currentSha = createHash("sha256").update(script).digest("hex")
              const freshJournal = row.scriptSha !== currentSha
              yield* launch(
                {
                  script,
                  sessionID: row.sessionID,
                  parentActorID: row.parentActorID ?? "main",
                  args: row.args,
                  freshJournal,
                  agentTimeoutMs: input.agentTimeoutMs ?? row.agentTimeoutMs,
                },
                input.runID,
                row.name,
              )
              return { runID: input.runID, resumed: true }
            }).pipe(
              Effect.provideService(Database.Service, database),
              Effect.provideService(SessionPrompt.Service, promptsSvc),
            ),
          ),
        ),
      )
    })

    const detail = Effect.fn("WorkflowRuntime.detail")(function* (input: { runID: string }) {
      const journal = yield* WorkflowPersistence.loadJournal(input.runID).pipe(
        Effect.provideService(Database.Service, database),
      )
      const summary = yield* WorkflowPersistence.load(input.runID).pipe(
        Effect.provideService(Database.Service, database),
      )
      if (!summary) return { status: "unknown" as const }
      return { run: summary, agents: journal.agents, logs: journal.logs }
    })

    const remove = Effect.fn("WorkflowRuntime.remove")(function* (input: { runID: string }) {
      const live = runs.get(input.runID)
      if (live && live.status === "running") {
        return yield* Effect.die(
          new Error(`${WORKFLOW_STRUCTURAL_ERROR}: cannot remove a running workflow — cancel first`),
        )
      }
      // Cascade child runs
      if (live) {
        for (const childRunID of live.childRunIDs) {
          yield* WorkflowPersistence.remove(childRunID).pipe(
            Effect.provideService(Database.Service, database),
            Effect.ignore,
          )
        }
      }
      yield* WorkflowPersistence.remove(input.runID).pipe(
        Effect.provideService(Database.Service, database),
      )
      runs.delete(input.runID)
    })

    const impl = Service.of({ start, status, wait, cancel, list, resume, detail, remove })
    // Late-bind the impl so the `workflow` tool can resolve it without forcing a
    // WorkflowRuntime.Service requirement onto ToolRegistry.layer. See
    // runtime-ref.ts for rationale.
    workflowRef.current = impl
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (workflowRef.current === impl) workflowRef.current = undefined
      }),
    )
    return impl
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(SessionPrompt.defaultLayer),
)

export * as WorkflowRuntime from "./runtime"
