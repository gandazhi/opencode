# Workflow TUI Dashboard & Detail View — Design

**Date:** 2026-06-14
**Status:** Approved (brainstorm complete)
**Related:** Issue #29059, PR #29789

## Goal

Add a full-screen detail view for workflow runs to the opencode TUI, with live sub-agent inspection (drill-down to child sessions), token/cost/retry/duration per agent, cancel/delete controls, and the backend data plumbing to support it.

This closes the UX gap between the existing engine (runtime.ts / sandbox.ts / persistence.ts) and what issue #29059 proposes — without touching the script API, sandbox, or resume mechanism (those are already beyond the issue).

## Non-Goals

- Do NOT change the workflow script API (`agent()`/`parallel()`/`pipeline()` globals).
- Do NOT change the sandbox (QuickJS), journal resume, or cycle/depth guards.
- Do NOT add a `/workflow <name>` slash command — direct launch via `/<workflow-name>` already exists and is out of scope.
- Do NOT add a plugin SDK export (`@opencode-ai/plugin/workflow`) — separate effort.
- Do NOT add an approval dialog — out of scope.

## Current State

Already present:
- `/workflows` slash command → `DialogWorkflows` modal (`packages/tui/src/component/dialog-workflows.tsx`), a `DialogSelect` list. Selecting a finished run only offers **resume**. No detail, no delete, no cancel in UI.
- Session sidebar (`packages/tui/src/routes/session/sidebar-workflows.tsx`) — live glyphs for the current session's runs.
- Sync store (`packages/tui/src/context/sync.tsx`) tracks `WorkflowRun` (counters, phase, logs capped at 10, error) via `workflow.*` events.
- Runtime spawns a real child **Session** per `agent()` call — but `RunEntry.childActorIDs` is declared (`runtime.ts:84`) and **never populated**.
- Session DB rows already carry full `cost` + token breakdown (`session.ts:93-140`) — cost is a **single source of truth** we can aggregate, no new storage needed.
- HTTP API: only `GET /workflow` (list) + `POST /workflow/:runID/resume`.

Gap vs. issue #29059: no full-screen dashboard, no per-run detail view (phase timeline, full log stream, sub-agents, tokens/cost, retries), no delete, no cancel in the UI.

## Decisions

| Decision | Choice |
|---|---|
| Form factor | **Modal list + detail route** (keep `/workflows` modal as the run-picker; Enter opens a new full-screen detail route). |
| Detail depth | **Full** — phases, full logs, sub-agents with drill-down, token/cost/retry/duration. |
| Direct launch | **Out of scope** — `/<workflow-name>` already exists. |
| Sub-agent | **Drill-down** — Enter on an agent row navigates to its child session. |
| Backend data | **Approach A (event-streamed cost)** — extend journal with agent lifecycle events; on `agent_end` the runtime reads the child session's accumulated cost/tokens once and embeds them in the journal event + `WorkflowAgentEnded` EventV2. No polling anywhere. |

## Architecture

### Data flow

```
Runtime (per agent() call)
  ├─ spawnShared creates child session → childActorIDs.add(child.id)
  ├─ journal append: agent_start {key, sessionID, agentType, label, phase, ts}
  ├─ publish WorkflowAgentStarted event
  ├─ ... child session runs ...
  ├─ on completion: read child session row ONCE → accumulated cost + tokens
  ├─ journal append: agent_end {key, ok, reason?, retry?, cost?, tokens?, ts}
  ├─ publish WorkflowAgentEnded event (carries cost/tokens)
  └─ sync store upserts agent record (status + cost/tokens) — realtime, no polling

GET /workflow/:runID (detail)
  ├─ loadJournal(runID) → rebuilds agents[] (with embedded cost/tokens) + logs[]
  └─ return { run, agents[], logs[] }  ← one-shot on open, events drive all live updates

TUI WorkflowDetail route
  ├─ onMount: GET /workflow/:runID  (one-shot hydration)
  ├─ subscribe workflow.* events  (status/phase/agent start+end+cost/log → ALL realtime)
  └─ onCleanup: unsubscribe
```

### Route / navigation

```
/workflows (modal DialogWorkflows)
   ↓ Enter on a run
   route.navigate({ type: "workflow", runID })
   ┌──────── WorkflowDetail (full-screen route) ────────┐
   │ header · agents (scroll) · logs · footer actions    │
   └──────────────────────────────────────────────────────┘
   ↓ Enter on an agent row
   route.navigate({ type: "session", sessionID })   ← reuses existing Session route
```

No explicit back-stack. `esc`/`q` from detail re-opens the modal; re-entry is via `/workflows`.

## §1 — Backend Data Model

### Journal format (backward-compatible)

Existing `{t:"agent", key, result, pass}` is preserved. New lifecycle events:

```js
{ t: "agent_start", key, sessionID, agentType, label?, phase?, ts }
{ t: "agent_end",   key, ok: boolean, reason?, retry?, cost?, tokens?, ts }
```

- `key` reuses existing `journalKeyBase + ":" + occ`; `agent_start` / `agent_end` / `agent` share the same key.
- `ts` = `Date.now()` (journal is append-only text, not on the sandbox determinism path; real time is fine).
- `cost` / `tokens` (on `agent_end`) = the child session's accumulated totals at completion (captured once by `spawnShared`, see §5 Change 5).
- `loadJournal` rebuilds `agents: AgentRecord[]` in `agent_start` appearance order; `agent_end` updates status/endedAt/reason/cost/tokens on the matching key.

### `WorkflowRun` / SDK type extension

```ts
type WorkflowRun = {
  // existing fields...
  agents: WorkflowAgent[]
  agentCount: number
  durationMs: number        // fixed at completion; live while running
  parentActorID?: string
  args?: unknown
  scriptSha?: string
}

type WorkflowAgent = {
  key: string
  sessionID?: string        // child session, for drill-down
  agentType: string
  label?: string
  phase?: string
  status: "running" | "succeeded" | "failed"
  reason?: string           // over-cap/timeout/...
  retry?: number
  startedAt: number
  endedAt?: number
  durationMs?: number
  cost?: number             // aggregated from child session
  tokens?: { input; output; reasoning; cache: { read; write } }
}
```

### Cost aggregation

Cost is **event-streamed**, not polled. When `spawnShared` resolves (the child session turn completes), the runtime reads the child session row's `cost` + `tokens_*` **once** and embeds them in the `agent_end` journal event and the `WorkflowAgentEnded` EventV2 event. The session table remains the single source of truth; cost is captured at completion and carried by the journal/event — no per-detail recomputation, no polling.

### `RunEntry.childActorIDs` populated

`spawnShared` does `entry.childActorIDs.add(child.id)` on child creation; the existing cancel path already consumes this set.

## §2 — Events & HTTP API

### New EventV2 events

```ts
WorkflowAgentStarted = "workflow.agent_started"
  { sessionID, runID, key, agentID?, agentType, label?, phase? }

WorkflowAgentEnded = "workflow.agent_ended"
  { sessionID, runID, key, status: "succeeded"|"failed", reason?, retry?, cost?, tokens? }
```

- `agentID` = child session ID (for drill-down).
- `cost` / `tokens` (on `agent_ended`) = the child session's **accumulated** totals at completion (read once from the session row). Present only for succeeded/failed agents whose child session produced cost data.
- Existing `WorkflowAgentFailed` is **kept** — it is the rich diagnostic source for failures; `agent_ended` with `status:"failed"` only converges state; they correlate by `key`.
- sync store subscribes to both events and updates `agents[]` (upsert by `key`). Cost/tokens arrive with `agent_ended`, realtime.

### HTTP API (groups/workflow.ts + handlers/workflow.ts)

```
GET    /workflow                 # existing list (RunSummary[]), unchanged
GET    /workflow/:runID          # NEW detail → { run, agents: WorkflowAgent[], logs: string[] }
POST   /workflow/:runID/cancel   # NEW → cancel(runID), returns run snapshot
DELETE /workflow/:runID          # NEW → deletes run row + journal + script file
POST   /workflow/:runID/resume   # existing, unchanged
```

**detail endpoint** returns `agents[]`: journal-rebuilt records (label/type/phase/status/retry/duration + embedded cost/tokens). Cost/tokens are already in the journal from the `agent_end` event, so the endpoint reads the journal only — **no session-row joins, no recomputation**. The endpoint is a one-shot hydration on detail-open; all subsequent updates arrive via events.

**delete endpoint**: validates non-running (running must cancel first); deletes `WorkflowRunTable` row + `clearJournal` + script file. Cascades child runs (`childRunIDs`).

### Realtime model

- status / phase / agent start / agent end (with cost+tokens) / log: **`workflow.*` events, realtime**.
- No polling. The detail endpoint is a one-shot hydration on open; events drive every live update thereafter.
- `durationMs` (run-level): completed run → fixed from `updatedAt - createdAt`; running run → `Date.now() - createdAt`, recomputed each 1s tick in the header (client clock only, no backend call). Agent-level `durationMs`: `endedAt - startedAt` if ended, else `Date.now() - startedAt` (client clock).
- Running run disappears (process restart): a `workflow.finished` event may arrive (clean) or the in-memory run is simply gone — reopening detail hits the persisted row; if the row is missing/unknown, toast + return to modal.

## §3 — Route & Navigation

### New Route type (`context/route.tsx`)

```ts
export type WorkflowDetailRoute = {
  type: "workflow"
  runID: string
}
export type Route = HomeRoute | SessionRoute | WorkflowDetailRoute | PluginRoute
```

`initialRoute` gains a `workflow` branch parser (supports `OPENCODE_ROUTE` env deep-link).

### `app.tsx` Switch

```tsx
<Match when={route.data.type === "workflow"}>
  <Show when={route.data.type === "workflow" ? route.data.runID : undefined} keyed>
    {(_) => <WorkflowDetail />}
  </Show>
</Match>
```

### Navigation

- modal → detail: `route.navigate({ type: "workflow", runID })`.
- detail → modal: `esc`/`q` → `dialog.replace(() => <DialogWorkflows />)`.
- detail → child session: Enter on agent row with `sessionID` → `route.navigate({ type: "session", sessionID })`.
- No explicit back-stack. Re-enter via `/workflows`.

### `DialogWorkflows` changes

Stays the run selector but:
- `actions` add `Cancel` (running only) and `Delete` (finished only), using `disabled` predicates.
- `onSelect` (Enter) → `route.navigate({ type: "workflow", runID })` (replaces the current "finished-only resume"). Resume action moves into the detail view.

## §4 — Detail View Layout & Interaction

### Layout (80×24)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ deep-research · ◐ running · phase: synthesize · 12✓ 2✗ 4… · $0.42 · 3m12s   │  header (fixed)
├──────────────────────────────────────────────────────────────────────────────┤
│ Agents                                              18 agents               │
│ ┌──────────────────────────────────────────────────────────────────────────┐ │
│ │ ▌ ◐ general  summarize report      synthesize   12s   $0.08  1.2k in   │ │  agents (scroll, main)
│ │   ✓ build    gather sources        research     45s   $0.15  3.1k in   │ │     ↑↓ select, Enter drill
│ │   ✗ plan     review risks          review       8s    timeout          │ │
│ │   ...                                                                   │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────────────────────┤
│ Logs                                                     [Tab] focus logs    │  logs tail (fixed ~6)
│ ▌ retrieved 8 sources for angle "performance"                                │
│   agent failed (timeout): review risks — retrying                            │
│   phase → synthesize                                                         │
├──────────────────────────────────────────────────────────────────────────────┤
│ [c] cancel  [r] resume  [d] delete  [Enter] open session       esc back      │  footer actions
└──────────────────────────────────────────────────────────────────────────────┘
```

### Regions

1. **Header** (fixed): `name · status_glyph · phase · counters · cost · duration`. Duration ticks live while running (`createSignal` + `setInterval(1s)`); cost via detail endpoint polling.
2. **Agents** (`flexGrow`, `scrollbox`): one row per agent = `glyph + type + label + phase + duration + cost + tokens/reason`. Selected row highlighted (`▌` gutter, reuses `DialogSelect` visuals). `↑↓` move, `Enter` drills into the agent's `sessionID`.
3. **Logs** (fixed ~6 rows, `scrollbox`): full log (detail endpoint pulls all once; `workflow.log` events append incrementally). `Tab` toggles agents ↔ logs focus.
4. **Footer actions**: `cancel` / `resume` / `delete` / `open session`, reusing `DialogSelect` actions pattern (with hotkeys + disabled predicates); `esc` returns to modal.

### Component data flow

`WorkflowDetail` lives at `packages/tui/src/routes/workflow/index.tsx` (new route directory, mirroring `routes/session/`).

```
onMount:
  1. sync.workflow.detail(runID)        ← NEW, GET /workflow/:runID, one-shot hydration {run, agents, logs}
event subscribe (workflow.*): realtime status/phase/agent start+end(cost/tokens)/log — NO polling
onCleanup: unsubscribe
```

- status/phase/agent lifecycle/cost/tokens/log: **all event-driven realtime** (matches the existing TUI architecture — `sync.tsx` is fully event-driven).
- `durationMs` (run-level): completed run → fixed from `updatedAt - createdAt`; running run → `Date.now() - createdAt`, recomputed each 1s tick in the header (does not call the backend, pure client clock).
- agent-level `durationMs`: `endedAt - startedAt` if ended, else `Date.now() - startedAt` (client clock) while the detail view is open.
- Running run disappears (process restart): detail re-open hits persisted row; if missing/unknown → toast + auto-return to modal.

### sync store: agents array upsert

The store key is `store.workflow[runID]`; `agents` is an array inside it. Event handlers upsert by `key`:

```ts
// workflow.agent_started
setStore("workflow", runID, "agents", (prev = []) => {
  const idx = prev.findIndex((a) => a.key === key)
  if (idx === -1) return [...prev, { key, sessionID: agentID, agentType, label, phase, status: "running", startedAt: Date.now() }]
  return prev.map((a, i) => i === idx ? { ...a, sessionID: agentID, status: "running" } : a)
})
// workflow.agent_ended — carries cost/tokens
setStore("workflow", runID, "agents", (prev = []) =>
  prev.map((a) => a.key === key ? { ...a, status, reason, retry, endedAt: Date.now(), ...(cost !== undefined ? { cost } : {}), ...(tokens ? { tokens } : {}) } : a))
```

Cost/token arrive with `agent_ended`; no polling fills them in.

### Keymap (mode `workflow.detail`)

| Key | Action |
|---|---|
| `↑`/`↓` | agents list move |
| `Enter` | drill into selected agent's session (disabled if no sessionID) |
| `Tab` | agents ↔ logs focus toggle |
| `c` | cancel (running only) |
| `r` | resume (non-running only) |
| `d` | delete (non-running only, confirm) |
| `o` | open the run's parent session |
| `esc`/`q` | back to modal |

### sync store new methods

```ts
workflow: {
  load(sessionID?)        // existing
  resume(runID)           // existing
  detail(runID)           // NEW: GET /workflow/:runID → store into store.workflow[runID].agents/logs
  cancel(runID)           // NEW: POST /workflow/:runID/cancel
  remove(runID)           // NEW: DELETE /workflow/:runID
}
```

## §5 — Backend Runtime Changes

### Change 1: `spawnShared` returns child metadata

Currently returns `value`. Returns `{ value, childID?, reason? }` so the caller (the `agent()` hook, which owns `key`) can do journal/event work. `childID` is captured from the `Effect.gen` closure after `sessions.create`.

### Change 2: `agent()` hook emits events + writes journal

Pass `key` into `spawnShared` (signature: `spawnShared(key, prompt, o, resolvedModel)`). Inside `spawnShared`, after child creation:
1. `entry.childActorIDs.add(child.id)`
2. `appendJournalSync(agent_start)` with `{ key, sessionID: child.id, agentType, label, phase, ts }`
3. `publish(WorkflowAgentStarted)`

After `spawnShared` returns, in the `agent()` hook:
1. `appendJournalSync(agent_end)` with `{ key, ok, reason, retry, ts }`
2. `publish(WorkflowAgentEnded)`

### Change 3: `persistence.ts` journal parsing

`JournalEvent` union gains:
```ts
| { t: "agent_start"; key; sessionID?; agentType; label?; phase?; ts }
| { t: "agent_end";   key; ok: boolean; reason?; retry?; ts }
```

`loadJournal` rebuilds `agents: AgentRecord[]`:
- `agent_start` → push new record (status: running)
- `agent_end` → find same-key record, update status/endedAt/reason
- `agent` (success result) → does not affect agents list (start/end already present)

Return type extends: `JournalLoad = { results, pass, agents, logs }` (logs collected in full from `t:"log"` events, no longer solely from the event stream).

### Change 4: `Interface` + runtime new methods

```ts
interface Interface {
  // existing: start, status, wait, cancel, list, resume
  detail(runID): Effect<{ run: RunSummary; agents: WorkflowAgent[]; logs: string[] } | { status: "unknown" }>
  remove(runID): Effect<void>   // validates non-running → deletes DB row + journal + script
}
```

**`detail` implementation**:
1. In-memory `runs.get(runID)` → running run: journal + childActorIDs computed live.
2. No memory → `WorkflowPersistence.load(runID)` + `loadJournal`: finished run.
3. `agents[]` cost/tokens come **directly from the journal** (`agent_end` events already embed them) — no session-row reads, no recomputation.
4. `run.durationMs` = `time_updated - time_created` (from the DB row / RunSummary); the TUI extends it client-side for running runs (see §4).
5. `logs` returned by the endpoint = `loadJournal`'s collected logs (the `t:"log"` events already in the journal). Single source of truth: the journal file, not the event stream.

**`remove` implementation**:
1. If running → `Effect.fail` (frontend should cancel first).
2. `WorkflowPersistence.remove(runID)` — delete row + `clearJournal` + delete script file.
3. Cascade `childRunIDs` recursively.

### Change 5: cost capture at agent completion

`spawnShared` resolves after `prompts.prompt()` returns. At that point the child session row already holds the **accumulated** `cost` + `tokens_*` for the completed turn. `spawnShared` reads it once via `sessions.get(child.id)` and includes it in its return value, so the `agent()` hook can embed `cost`/`tokens` in the `agent_end` journal event and `WorkflowAgentEnded` EventV2.

Signature: `spawnShared(key, prompt, o, resolvedModel) → { value, childID?, reason?, cost?, tokens? }`.

`Session.Service` is yielded inside `spawnShared`'s existing `Effect.gen` (already the case); no new layer-level yield needed since `detail` no longer aggregates cost.

## §6 — HTTP API Surface

### New schemas (`groups/workflow.ts`)

```ts
export const WorkflowAgentStatus = Schema.Literals(["running", "succeeded", "failed"])
export const WorkflowTokens = Schema.Struct({
  input: Schema.Number, output: Schema.Number, reasoning: Schema.Number,
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
  durationMs: Schema.optional(Schema.Number),
  cost: Schema.optional(Schema.Number),
  tokens: Schema.optional(WorkflowTokens),
})
export const WorkflowRunDetail = Schema.Struct({
  run: WorkflowRunSummary,
  agents: Schema.Array(WorkflowAgent),
  logs: Schema.Array(Schema.String),
})
export const EmptyResult = Schema.Struct({ ok: Schema.Boolean })
```

### Paths

```ts
export const WorkflowPaths = {
  list: root,
  detail: `${root}/:runID`,
  cancel: `${root}/:runID/cancel`,
  delete: `${root}/:runID`,
  resume: `${root}/:runID/resume`,
}
```

### New endpoints

```ts
HttpApiEndpoint.get("detail", WorkflowPaths.detail, {
  params: { runID: Schema.String }, query: WorkspaceRoutingQuery,
  success: described(WorkflowRunDetail, "Run detail with agents and logs"),
})
HttpApiEndpoint.post("cancel", WorkflowPaths.cancel, {
  params: { runID: Schema.String }, query: WorkspaceRoutingQuery,
  success: described(WorkflowRunSummary, "Run snapshot after cancel"),
})
HttpApiEndpoint.del("delete", WorkflowPaths.delete, {
  params: { runID: Schema.String }, query: WorkspaceRoutingQuery,
  success: described(EmptyResult, "Deletion result"),
})
```

Each with `OpenApi.annotations` (identifier/summary/description), following the existing `.annotateMerge` pattern.

### Handlers (`handlers/workflow.ts`)

```ts
const detail = Effect.fn("WorkflowHttpApi.detail")(function* (ctx: { params: { runID: string } }) {
  const runtime = workflowRef.current
  if (!runtime) return yield* Effect.fail(WorkflowNotFoundError.make({ runID: ctx.params.runID }))
  const result = yield* runtime.detail({ runID: ctx.params.runID })
  if ("status" in result && result.status === "unknown")
    return yield* Effect.fail(WorkflowNotFoundError.make({ runID: ctx.params.runID }))
  return result
})
const cancel = Effect.fn("WorkflowHttpApi.cancel")(function* (ctx: { params: { runID: string } }) {
  const runtime = workflowRef.current
  if (!runtime) return null
  yield* runtime.cancel({ runID: ctx.params.runID })
  return yield* runtime.status({ runID: ctx.params.runID })
})
const remove = Effect.fn("WorkflowHttpApi.delete")(function* (ctx: { params: { runID: string } }) {
  const runtime = workflowRef.current
  if (!runtime) return { ok: false }
  yield* runtime.remove({ runID: ctx.params.runID })
  return { ok: true }
})
return handlers.handle("list", list).handle("detail", detail).handle("cancel", cancel).handle("delete", remove).handle("resume", resume)
```

### Error schemas (explicit, per handlers AGENTS.md)

```ts
export const WorkflowNotFoundError = Schema.ErrorClass({
  identifier: "WorkflowNotFoundError", title: "Workflow not found", fields: { runID: Schema.String },
})
export const WorkflowRunningError = Schema.ErrorClass({
  identifier: "WorkflowRunningError", title: "Workflow is still running", fields: { runID: Schema.String },
})
```

- `detail` unknown run → `WorkflowNotFoundError` (404).
- `delete` on a running run → `WorkflowRunningError` (runtime.remove also validates; HTTP layer guards first).

Both declared on their endpoints' `error:` so they are SDK-visible.

### SDK regeneration

Run `./packages/sdk/js/script/build.ts` so `@opencode-ai/sdk/v2` carries the new types. The sync store's `WorkflowRun` type switches to the SDK-exported type (rather than hand-written).

## §7 — Testing

Principles (AGENTS.md): test actual implementation, do not duplicate logic into tests, avoid mocks where possible, run from package dirs.

### Backend (`packages/opencode/test/workflow/`)

1. **`detail.test.ts`** (new) — run a built-in/inline script calling `agent()`, after completion:
   - `agents[]` non-empty; each has `key/agentType/startedAt/endedAt/status`.
   - cost aggregated = the child session row's `cost` (not 0/undefined).
   - `logs[]` contains `log()` messages.
   - Unknown runID → `{ status: "unknown" }`.

2. **`journal-lifecycle.test.ts`** (new) — inline script calling `agent()` twice (one success, one schema-mismatch → no-deliverable):
   - Re-`loadJournal(runID)`, assert `agents.length === 2`.
   - Failed agent `status: "failed"`, `reason: "no-deliverable"`.
   - `agent_start.ts < agent_end.ts`.
   - Resume: `agent_start`/`agent_end` not re-appended on journal hit.

3. **`remove.test.ts`** (new):
   - `remove` on a running run → `WorkflowRunningError`.
   - After cancel, `remove` → DB row, journal file, script file all gone.
   - Cascade: parent `remove` deletes child run rows too.

4. **Regression** — `sandbox.test.ts` asserts agent lifecycle events don't break determinism (resume PRNG sequence unchanged); `persistence.test.ts` asserts the new `agents`/`logs` fields don't break existing assertions.

### Frontend (`packages/tui`)

5. **`dialog-workflows.test.tsx`** (new) — render `DialogWorkflows`, assert `Cancel`/`Delete` actions appear with correct `disabled`; mock `sync.workflow` and assert call paths.

6. **`workflow-detail.test.tsx`** (new) — render `WorkflowDetail` with mock detail data:
   - header shows name/status/phase/counters/cost/duration.
   - agents row count matches; `Enter` triggers `route.navigate({type:"session"})`.
   - `Tab` toggles agents ↔ logs focus.
   - `c` → cancel; `d` → confirm → remove.

   If `packages/tui` has no test harness, fall back to manual verification via `bun dev`.

### Verification commands

```bash
cd packages/opencode && bun test test/workflow/
cd packages/tui && bun test 2>/dev/null || echo "tui no harness, manual verify"
cd packages/opencode && bun typecheck
cd packages/tui && bun typecheck
cd packages/core && bun typecheck   # if workflow.sql.ts touched
./packages/sdk/js/script/build.ts   # SDK type sync
```

## Open Questions

None remaining — all sections approved.

## Implementation Order (suggested)

1. Backend data model (§1): journal events + `loadJournal` rebuild + `WorkflowRun`/`WorkflowAgent` types.
2. Runtime changes (§5): `spawnShared` signature, `agent()` hook events/journal, `detail`/`remove` methods, layer yields `Session.Service`.
3. HTTP API (§2, §6): schemas, endpoints, handlers, error classes.
4. SDK regeneration.
5. sync store methods (§4): `detail`/`cancel`/`remove` + event subscriptions for `agent_started`/`agent_ended`.
6. Route + `DialogWorkflows` changes (§3).
7. `WorkflowDetail` component (§4).
8. Tests (§7).
