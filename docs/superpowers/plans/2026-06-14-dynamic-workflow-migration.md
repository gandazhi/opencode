# Dynamic Workflow Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the Dynamic Workflow feature from MiMo-Code (`/Users/gandazhi/code/agent/MiMo-Code/packages/opencode/src/workflow/`) into the forked opencode repo (`/Users/gandazhi/code/agent/opencode`), rewriting the spawn mechanism to use the target's Session+Task model.

**Architecture:** Strategy A (adapt Task model) + approach 2 (native spawn rewrite). The workflow core (sandbox, meta, persistence, journal, concurrency) is preserved; only `spawnShared` is rewritten to call `sessions.create()` + `prompts.prompt()` instead of `actor.spawn()`. Events move from `BusEvent` to `EventV2`. Notifications use synthetic-message injection instead of Inbox.

**Tech Stack:** Effect (services/layers/bridges), QuickJS (quickjs-emscripten), Drizzle (SQLite), SolidJS (TUI), EventV2 (typed events)

**Spec:** `docs/superpowers/specs/2026-06-14-dynamic-workflow-migration-design.md`

**Source reference:** `/Users/gandazhi/code/agent/MiMo-Code/packages/opencode/src/workflow/` — each task below references specific source files to copy from.

---

## File Structure

### New files (in `packages/opencode/src/workflow/`)

| File | Responsibility | Source |
|------|---------------|--------|
| `sandbox.ts` | QuickJS isolated execution (280 lines) | Verbatim from MiMo-Code |
| `meta.ts` | Meta parser — pure recursive descent (335 lines) | Verbatim from MiMo-Code |
| `runtime-ref.ts` | Late-bound WorkflowRuntime ref (18 lines) | Verbatim from MiMo-Code |
| `builtin.ts` | Built-in workflow registry (54 lines) | Verbatim (import path fix) |
| `builtin/deep-research.js` | Deep research workflow script (391 lines) | Verbatim from MiMo-Code |
| `resolve.ts` | Name→script resolution (45 lines) | Adapted (`.opencode/workflows/`) |
| `workspace.ts` | File-primitive jail (69 lines) | Adapted (Glob/Filesystem import) |
| `events.ts` | 6 EventV2 event definitions | Adapted (BusEvent→EventV2) |
| `workflow.sql.ts` | Drizzle table definition (31 lines) | Adapted (core imports) |
| `persistence.ts` | DB + journal IO (312 lines) | Adapted (Database.Service) |
| `runtime.ts` | Core orchestrator engine (~1230 lines) | Rewritten spawn; rest preserved |

### New files (other locations)

| File | Responsibility |
|------|---------------|
| `packages/opencode/src/tool/workflow.ts` | Workflow tool definition |
| `packages/opencode/src/tool/workflow.txt` | Tool description text |
| `packages/opencode/src/server/routes/instance/httpapi/groups/workflow.ts` | HTTP API routes |
| `packages/core/src/database/migration/<ts>_workflow.ts` | DB migration |
| `packages/tui/src/component/dialog-workflows.tsx` | TUI /workflows dialog |
| `packages/opencode/test/workflow/*.test.ts` | Tests |

### Modified files

| File | Change |
|------|--------|
| `packages/opencode/package.json` | Add `quickjs-emerson` dep |
| `packages/opencode/src/id/id.ts` | Add `workflow` prefix |
| `packages/opencode/src/effect/runtime-flags.ts` | Add `experimentalDynamicWorkflow` flag |
| `packages/opencode/src/effect/app-runtime.ts` | Wire `WorkflowRuntime.defaultLayer` |
| `packages/opencode/src/tool/registry.ts` | Register workflow tool (flag-gated) |
| `packages/opencode/src/config/config.ts` | Add `workflow` config section |
| `packages/opencode/src/command/index.ts` | Add `/deep-research` command |
| `packages/tui/src/context/sync.tsx` | Add workflow state slice |
| `packages/tui/src/app.tsx` | Register `/workflows` command |

---

## Task 1: Add quickjs-emscripten dependency

**Files:**
- Modify: `packages/opencode/package.json`

- [ ] **Step 1: Check latest version**

Run: `cd /Users/gandazhi/code/agent/opencode && bun pm view quickjs-emscripten version 2>/dev/null || npm view quickjs-emscripten version`

- [ ] **Step 2: Add to dependencies**

In `packages/opencode/package.json`, add to `dependencies` (alphabetical order after `patchright`):

```json
"quickjs-emscripten": "^0.31.0",
```

Use the version found in step 1 (or `latest` if uncertain — resolve after).

- [ ] **Step 3: Install**

Run: `cd /Users/gandazhi/code/agent/opencode && bun install`

Expected: dependency installed, `bun.lock` updated.

- [ ] **Step 4: Verify import works**

Run: `cd /Users/gandazhi/code/agent/opencode && bun -e "import('quickjs-emscripten').then(m => console.log(typeof m.getQuickJS))"`

Expected: prints `function`

- [ ] **Step 5: Commit**

```bash
cd /Users/gandazhi/code/agent/opencode
git add packages/opencode/package.json bun.lock
git commit -m "deps: add quickjs-emscripten for dynamic workflow sandbox"
```

---

## Task 2: Port sandbox.ts (QuickJS engine) — verbatim

**Files:**
- Create: `packages/opencode/src/workflow/sandbox.ts`
- Source: `/Users/gandazhi/code/agent/MiMo-Code/packages/opencode/src/workflow/sandbox.ts`

This file has ZERO internal imports — only `quickjs-emscripten`. It ports verbatim.

- [ ] **Step 1: Copy the file**

Run:
```bash
cp /Users/gandazhi/code/agent/MiMo-Code/packages/opencode/src/workflow/sandbox.ts \
   /Users/gandazhi/code/agent/opencode/packages/opencode/src/workflow/sandbox.ts
```

- [ ] **Step 2: Verify no `@/` or `../` imports exist**

Run: `grep -n "from ['\"]@\|from ['\"]\.\." /Users/gandazhi/code/agent/opencode/packages/opencode/src/workflow/sandbox.ts`

Expected: no matches (sandbox.ts only imports from `quickjs-emscripten`)

- [ ] **Step 3: Verify typecheck passes**

Run: `cd /Users/gandazhi/code/agent/opencode/packages/opencode && bun run typecheck 2>&1 | grep -i "sandbox" || echo "no sandbox errors"`

Expected: no errors mentioning sandbox

- [ ] **Step 4: Commit**

```bash
cd /Users/gandazhi/code/agent/opencode
git add packages/opencode/src/workflow/sandbox.ts
git commit -m "feat(workflow): port sandbox.ts — QuickJS isolated execution engine"
```

---

## Task 3: Port meta.ts (meta parser) — verbatim

**Files:**
- Create: `packages/opencode/src/workflow/meta.ts`
- Source: `/Users/gandazhi/code/agent/MiMo-Code/packages/opencode/src/workflow/meta.ts`

This file has ZERO imports. Pure recursive-descent parser.

- [ ] **Step 1: Copy the file**

Run:
```bash
cp /Users/gandazhi/code/agent/MiMo-Code/packages/opencode/src/workflow/meta.ts \
   /Users/gandazhi/code/agent/opencode/packages/opencode/src/workflow/meta.ts
```

- [ ] **Step 2: Write unit test**

Create `packages/opencode/test/workflow/meta.test.ts`:

```ts
import { describe, expect, it } from "bun:test"
import { parseMeta } from "@/workflow/meta"

describe("parseMeta", () => {
  it("parses a valid meta", () => {
    const script = `export const meta = {
  name: "test",
  description: "A test workflow",
  phases: [{ title: "Step1" }],
}
const x = 1`
    const result = parseMeta(script)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.meta.name).toBe("test")
      expect(result.meta.description).toBe("A test workflow")
      expect(result.meta.phases).toEqual([{ title: "Step1" }])
      // body preserves line numbers
      expect(result.body.split("\n").length).toBe(script.split("\n").length)
    }
  })

  it("fails without meta", () => {
    const result = parseMeta("const x = 1")
    expect(result.ok).toBe(false)
  })

  it("rejects function calls in meta", () => {
    const script = `export const meta = { name: foo() }`
    const result = parseMeta(script)
    expect(result.ok).toBe(false)
  })

  it("handles single-quoted strings and unquoted keys", () => {
    const script = `export const meta = { name: 'test', description: "desc" }`
    const result = parseMeta(script)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.meta.name).toBe("test")
  })
})
```

- [ ] **Step 3: Run test**

Run: `cd /Users/gandazhi/code/agent/opencode/packages/opencode && bun test test/workflow/meta.test.ts`

Expected: all tests pass

- [ ] **Step 4: Commit**

```bash
cd /Users/gandazhi/code/agent/opencode
git add packages/opencode/src/workflow/meta.ts packages/opencode/test/workflow/meta.test.ts
git commit -m "feat(workflow): port meta.ts — recursive-descent meta parser + tests"
```

---

## Task 4: Port runtime-ref.ts — verbatim

**Files:**
- Create: `packages/opencode/src/workflow/runtime-ref.ts`
- Source: `/Users/gandazhi/code/agent/MiMo-Code/packages/opencode/src/workflow/runtime-ref.ts`

This file only has a type import from `./runtime` (which we haven't created yet — that's fine, it's a type-only import).

- [ ] **Step 1: Copy the file**

Run:
```bash
cp /Users/gandazhi/code/agent/MiMo-Code/packages/opencode/src/workflow/runtime-ref.ts \
   /Users/gandazhi/code/agent/opencode/packages/opencode/src/workflow/runtime-ref.ts
```

- [ ] **Step 2: Commit**

```bash
cd /Users/gandazhi/code/agent/opencode
git add packages/opencode/src/workflow/runtime-ref.ts
git commit -m "feat(workflow): port runtime-ref.ts — late-bound runtime reference"
```

---

## Task 5: Port builtin.ts + deep-research.js

**Files:**
- Create: `packages/opencode/src/workflow/builtin.ts`
- Create: `packages/opencode/src/workflow/builtin/deep-research.js`
- Source: MiMo-Code equivalents

- [ ] **Step 1: Create the directory and copy deep-research.js**

Run:
```bash
mkdir -p /Users/gandazhi/code/agent/opencode/packages/opencode/src/workflow/builtin
cp /Users/gandazhi/code/agent/MiMo-Code/packages/opencode/src/workflow/builtin/deep-research.js \
   /Users/gandazhi/code/agent/opencode/packages/opencode/src/workflow/builtin/deep-research.js
```

- [ ] **Step 2: Copy builtin.ts**

Run:
```bash
cp /Users/gandazhi/code/agent/MiMo-Code/packages/opencode/src/workflow/builtin.ts \
   /Users/gandazhi/code/agent/opencode/packages/opencode/src/workflow/builtin.ts
```

- [ ] **Step 3: Verify deep-research.js meta parses**

Run:
```bash
cd /Users/gandazhi/code/agent/opencode/packages/opencode && bun -e "
import { parseMeta } from './src/workflow/meta.ts'
import DEEP_RESEARCH from './src/workflow/builtin/deep-research.js' with { type: 'text' }
const r = parseMeta(DEEP_RESEARCH)
console.log(r.ok ? 'OK: ' + r.meta.name : 'FAIL: ' + r.error)
"
```

Expected: `OK: deep-research`

> **Note on `with { type: "text" }`**: This is a Bun import attribute that inlines the .js file as a string. If the target repo's tsconfig or bundler doesn't support this syntax, add `// @ts-expect-error TS1192` above the import (as MiMo-Code does). Verify in step 3 — if it fails, add the suppression.

- [ ] **Step 4: Commit**

```bash
cd /Users/gandazhi/code/agent/opencode
git add packages/opencode/src/workflow/builtin.ts packages/opencode/src/workflow/builtin/
git commit -m "feat(workflow): port builtin.ts + deep-research.js"
```

---

## Task 6: Port resolve.ts — adapted paths

**Files:**
- Create: `packages/opencode/src/workflow/resolve.ts`
- Source: `/Users/gandazhi/code/agent/MiMo-Code/packages/opencode/src/workflow/resolve.ts`

- [ ] **Step 1: Find the target repo's Filesystem utility**

Run: `cd /Users/gandazhi/code/agent/opencode && grep -rn "export.*function.*exists\|export.*function.*readText" packages/opencode/src/ packages/core/src/ --include="*.ts" | grep -i "filesys\|fs-util\|Filesystem" | head -10`

This finds the equivalent of MiMo-Code's `@/util` `Filesystem` module. The target likely has an `FSUtil` or similar. Record the exact import path and function names.

- [ ] **Step 2: Create resolve.ts with adapted imports**

Create `packages/opencode/src/workflow/resolve.ts`:

```ts
import path from "path"
import { FSUtil } from "@/filesystem/fsutil"  // ← adjust to match step 1 result

const META_RE = /export\s+const\s+meta\s*=/

export function isInlineScript(nameOrScript: string): boolean {
  return META_RE.test(nameOrScript)
}

const SAFE_NAME = /^[A-Za-z0-9._-]+$/

export async function resolveWorkflowScript(name: string, start: string, stop: string): Promise<string | null> {
  if (!SAFE_NAME.test(name)) throw new Error(`invalid workflow name: ${JSON.stringify(name)}`)
  const subdirs = [".opencode/workflows", ".claude/workflows"]
  for (const found of await collectUp(name, subdirs, start, stop)) {
    return FSUtil.readText(found)
  }
  return null
}

async function collectUp(name: string, subdirs: string[], start: string, stop: string): Promise<string[]> {
  const out: string[] = []
  let current = start
  for (;;) {
    for (const sub of subdirs) {
      const candidate = path.join(current, sub, `${name}.js`)
      if (await FSUtil.exists(candidate)) out.push(candidate)
    }
    if (current === stop) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return out
}
```

> **IMPORTANT**: Replace `FSUtil` import path with the actual path found in step 1. The target repo uses `@/filesystem/fsutil` or similar — verify the exact export names (`exists`, `readText`).

- [ ] **Step 3: Verify typecheck**

Run: `cd /Users/gandazhi/code/agent/opencode/packages/opencode && bun run typecheck 2>&1 | grep "resolve" || echo "no resolve errors"`

- [ ] **Step 4: Commit**

```bash
cd /Users/gandazhi/code/agent/opencode
git add packages/opencode/src/workflow/resolve.ts
git commit -m "feat(workflow): port resolve.ts — workflow script name resolution"
```

---

## Task 7: Create workflow.sql.ts (Drizzle schema)

**Files:**
- Create: `packages/opencode/src/workflow/workflow.sql.ts`
- Source: `/Users/gandazhi/code/agent/MiMo-Code/packages/opencode/src/workflow/workflow.sql.ts`

- [ ] **Step 1: Create the schema file**

Create `packages/opencode/src/workflow/workflow.sql.ts`:

```ts
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Timestamps } from "@opencode-ai/core/database/schema.sql"
import type { SessionID } from "@/session/schema"

export const WorkflowRunTable = sqliteTable(
  "workflow_run",
  {
    id: text().primaryKey(),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    status: text().$type<"running" | "completed" | "failed" | "cancelled">().notNull(),
    running: integer().notNull().default(0),
    succeeded: integer().notNull().default(0),
    failed: integer().notNull().default(0),
    current_phase: text(),
    parent_actor_id: text(),
    args: text({ mode: "json" }),
    script_sha: text(),
    agent_timeout_ms: integer(),
    error: text(),
    ...Timestamps,
  },
  (table) => [
    index("workflow_run_session_idx").on(table.session_id),
    index("workflow_run_status_idx").on(table.status),
  ],
)
```

- [ ] **Step 2: Generate migration**

Run:
```bash
cd /Users/gandazhi/code/agent/opencode/packages/core && bun run script/migration.ts --name workflow
```

Expected: a new migration file created in `packages/core/src/database/migration/<timestamp>_workflow.ts`, and `migration.gen.ts` updated.

- [ ] **Step 3: Verify migration file looks correct**

Run: `ls -la /Users/gandazhi/code/agent/opencode/packages/core/src/database/migration/*workflow*`

Read the generated file to verify it contains `CREATE TABLE \`workflow_run\`` and the two indexes.

- [ ] **Step 4: Commit**

```bash
cd /Users/gandazhi/code/agent/opencode
git add packages/opencode/src/workflow/workflow.sql.ts packages/core/src/database/migration/
git commit -m "feat(workflow): add workflow_run table + migration"
```

---

## Task 8: Create events.ts (EventV2 definitions)

**Files:**
- Create: `packages/opencode/src/workflow/events.ts`
- Source: `/Users/gandazhi/code/agent/MiMo-Code/packages/opencode/src/workflow/events.ts` (adapted BusEvent→EventV2)

- [ ] **Step 1: Create events.ts**

Create `packages/opencode/src/workflow/events.ts`:

```ts
import { EventV2 } from "@opencode-ai/core/event"
import { Schema } from "effect"
import { SessionID } from "@/session/schema"

export const WorkflowPhase = EventV2.define({
  type: "workflow.phase",
  sync: { version: 1, aggregate: "runID" },
  schema: {
    sessionID: SessionID,
    runID: Schema.String,
    title: Schema.String,
  },
})

export const WorkflowLog = EventV2.define({
  type: "workflow.log",
  sync: { version: 1, aggregate: "runID" },
  schema: {
    sessionID: SessionID,
    runID: Schema.String,
    message: Schema.String,
  },
})

export const WorkflowStarted = EventV2.define({
  type: "workflow.started",
  sync: { version: 1, aggregate: "runID" },
  schema: {
    sessionID: SessionID,
    runID: Schema.String,
    name: Schema.String,
  },
})

export const WorkflowFinished = EventV2.define({
  type: "workflow.finished",
  sync: { version: 1, aggregate: "runID" },
  schema: {
    sessionID: SessionID,
    runID: Schema.String,
    status: Schema.Literal("completed", "failed", "cancelled"),
    error: Schema.optional(Schema.String),
  },
})

export const WorkflowAgentFailed = EventV2.define({
  type: "workflow.agent_failed",
  schema: {
    sessionID: SessionID,
    runID: Schema.String,
    actorID: Schema.optional(Schema.String),
    agentType: Schema.String,
    label: Schema.optional(Schema.String),
    phase: Schema.optional(Schema.String),
    reason: Schema.Literal("over-cap", "spawn-reject", "timeout", "actor-error", "no-deliverable"),
    errorMessage: Schema.optional(Schema.String),
  },
})

export const WorkflowChildFailed = EventV2.define({
  type: "workflow.child_failed",
  schema: {
    sessionID: SessionID,
    runID: Schema.String,
    childRunID: Schema.String,
    name: Schema.String,
    status: Schema.Literal("failed", "cancelled"),
    error: Schema.optional(Schema.String),
  },
})
```

- [ ] **Step 2: Verify typecheck**

Run: `cd /Users/gandazhi/code/agent/opencode/packages/opencode && bun run typecheck 2>&1 | grep "events" || echo "no events errors"`

- [ ] **Step 3: Commit**

```bash
cd /Users/gandazhi/code/agent/opencode
git add packages/opencode/src/workflow/events.ts
git commit -m "feat(workflow): add EventV2 event definitions"
```

---

## Task 9: Create workspace.ts (file-primitive jail)

**Files:**
- Create: `packages/opencode/src/workflow/workspace.ts`
- Source: `/Users/gandazhi/code/agent/MiMo-Code/packages/opencode/src/workflow/workspace.ts`

- [ ] **Step 1: Find the target repo's Glob utility**

Run: `cd /Users/gandazhi/code/agent/opencode && grep -rn "export.*Glob\|export.*function.*scan\|export.*function.*glob" packages/opencode/src/tool/glob.ts packages/core/src/ --include="*.ts" | head -10`

The target repo has a `GlobTool` (`packages/opencode/src/tool/glob.ts`). Find the underlying glob scan function it uses — likely from a shared package or `Ripgrep`. Record the exact import path.

- [ ] **Step 2: Create workspace.ts**

Create `packages/opencode/src/workflow/workspace.ts` (adjusting the Glob import per step 1):

```ts
import path from "path"
import { FSUtil } from "@/filesystem/fsutil"  // ← adjust to actual path

export function resolveInWorkspace(root: string, rel: string): string {
  const abs = path.resolve(root, rel)
  if (abs !== root && !isWithinPath(root, abs)) {
    throw new Error(`workspace path escapes the workspace root: ${JSON.stringify(rel)}`)
  }
  return abs
}

function isWithinPath(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return !rel.startsWith("..") && !path.isAbsolute(rel)
}

export function makeFileHooks(root: string) {
  return {
    async readFile(rel: unknown): Promise<string | null> {
      const abs = resolveInWorkspace(root, String(rel))
      if (!(await FSUtil.exists(abs))) return null
      return FSUtil.readText(abs)
    },
    async writeFile(rel: unknown, content: unknown): Promise<void> {
      const abs = resolveInWorkspace(root, String(rel))
      await FSUtil.write(abs, String(content))
    },
    async exists(rel: unknown): Promise<boolean> {
      const abs = resolveInWorkspace(root, String(rel))
      return FSUtil.exists(abs)
    },
    async glob(pattern: unknown): Promise<string[]> {
      // Use the target repo's glob mechanism.
      // The GlobTool uses ripgrep under the hood; for workspace scripts
      // we need a direct scan. Adjust the import and call per step 1.
      const { Glob } = await import("@/util/glob")  // ← adjust per step 1
      const abs = await Glob.scan(String(pattern), {
        cwd: root,
        absolute: true,
        include: "all" as const,
        dot: true,
      })
      return abs
        .map((p: string) => path.relative(root, p))
        .filter((rel: string) => rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel))
        .sort()
    },
  }
}
```

> **IMPORTANT**: The `FSUtil` and `Glob` imports MUST be adjusted to match the target repo's actual utility modules found in step 1. The `isWithinPath` helper replaces MiMo-Code's `Filesystem.contains` with a lexical check using `path.relative`.

- [ ] **Step 3: Verify typecheck**

Run: `cd /Users/gandazhi/code/agent/opencode/packages/opencode && bun run typecheck 2>&1 | grep "workspace" || echo "no workspace errors"`

- [ ] **Step 4: Commit**

```bash
cd /Users/gandazhi/code/agent/opencode
git add packages/opencode/src/workflow/workspace.ts
git commit -m "feat(workflow): port workspace.ts — file-primitive jail"
```

---

## Task 10: Add "workflow" ID prefix

**Files:**
- Modify: `packages/opencode/src/id/id.ts`

- [ ] **Step 1: Add prefix**

In `packages/opencode/src/id/id.ts`, add `workflow` to the `prefixes` object:

```ts
const prefixes = {
  job: "job",
  event: "evt",
  session: "ses",
  message: "msg",
  permission: "per",
  question: "que",
  part: "prt",
  pty: "pty",
  tool: "tool",
  workspace: "wrk",
  workflow: "wf",     // ← ADD THIS LINE
} as const
```

- [ ] **Step 2: Commit**

```bash
cd /Users/gandazhi/code/agent/opencode
git add packages/opencode/src/id/id.ts
git commit -m "feat(id): add 'workflow' prefix"
```

---

## Task 11: Create persistence.ts (DB + journal)

**Files:**
- Create: `packages/opencode/src/workflow/persistence.ts`
- Source: `/Users/gandazhi/code/agent/MiMo-Code/packages/opencode/src/workflow/persistence.ts`

- [ ] **Step 1: Find the target repo's data directory API**

Run: `cd /Users/gandazhi/code/agent/opencode && grep -rn "data.*path\|Path\.data\|dataDir\|XDG_DATA" packages/opencode/src/ packages/core/src/ --include="*.ts" | grep -v node_modules | grep -v ".test." | head -15`

The target repo must have a concept of a per-project data directory (where SQLite DB lives). Find the exact API to get the data directory path. Record it.

- [ ] **Step 2: Create persistence.ts**

Create `packages/opencode/src/workflow/persistence.ts`. This is adapted from the MiMo-Code source — the `Database.use((db) => ...)` calls become `const { db } = yield* Database.Service; db.insert(...)`.

```ts
import { Effect } from "effect"
import path from "path"
import { createHash } from "node:crypto"
import { appendFileSync, mkdirSync } from "node:fs"
import { eq, desc } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { WorkflowRunTable } from "./workflow.sql"
import { InstanceState } from "@/effect/instance-state"
import type { SessionID } from "@/session/schema"

// Data directory: resolved from the InstanceState context.
// Adjust per step 1 — likely InstanceState.directory or a Global.Path equivalent.
const scriptDir = () =>
  path.join(
    process.env.XDG_DATA_HOME || path.join(process.env.HOME || "~", ".local", "share"),
    "opencode",
    "workflow",
  )

function canonical(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(canonical)
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
  )
}

export function journalKeyBase(prompt: string, opts: {
  agentType?: string
  model?: unknown
  schema?: unknown
  phase?: string
  [k: string]: unknown
}): string {
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
  opts: { agentType?: string; model?: unknown; schema?: unknown; phase?: string; [k: string]: unknown },
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
    ...(row.agent_timeout_ms !== null && row.agent_timeout_ms !== undefined
      ? { agentTimeoutMs: row.agent_timeout_ms }
      : {}),
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
    db.insert(WorkflowRunTable)
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
  })

const recordPhase = (input: { runID: string; phase: string }) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    db.update(WorkflowRunTable).set({ current_phase: input.phase }).where(eq(WorkflowRunTable.id, input.runID)).run()
  })

const flushCounters = (input: { runID: string; running: number; succeeded: number; failed: number }) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    db.update(WorkflowRunTable)
      .set({ running: input.running, succeeded: input.succeeded, failed: input.failed })
      .where(eq(WorkflowRunTable.id, input.runID))
      .run()
  })

const recordTerminal = (input: { runID: string; status: "completed" | "failed" | "cancelled"; error?: string }) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    db.update(WorkflowRunTable)
      .set({ status: input.status, ...(input.error ? { error: input.error } : {}) })
      .where(eq(WorkflowRunTable.id, input.runID))
      .run()
  })

const list = (input?: { sessionID?: SessionID }) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = input?.sessionID
      ? db
          .select()
          .from(WorkflowRunTable)
          .where(eq(WorkflowRunTable.session_id, input.sessionID))
          .orderBy(desc(WorkflowRunTable.time_created))
          .all()
      : db.select().from(WorkflowRunTable).orderBy(desc(WorkflowRunTable.time_created)).all()
    return rows.map(toSummary)
  })

const load = (runID: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const row = db.select().from(WorkflowRunTable).where(eq(WorkflowRunTable.id, runID)).get()
    return row ? toSummary(row) : undefined
  })

const writeScript = (runID: string, body: string) =>
  Effect.promise(async () => {
    mkdirSync(scriptDir(), { recursive: true })
    await Bun.write(scriptPath(runID), body)
  })

const readScript = (runID: string) => Effect.promise(() => Bun.file(scriptPath(runID)).text())

const appendJournal = (runID: string, event: JournalEvent) =>
  Effect.promise(async () => {
    mkdirSync(scriptDir(), { recursive: true })
    const { appendFile } = await import("node:fs/promises")
    await appendFile(journalPath(runID), JSON.stringify(event) + "\n")
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
    mkdirSync(scriptDir(), { recursive: true })
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
```

> **IMPORTANT**: The `scriptDir()` function needs to use the target repo's actual data directory. Step 1 finds it. The DB calls use `Effect.gen` + `yield* Database.Service` pattern (not `Database.use`). The `drizzle-orm` `eq`/`desc` are imported from `"drizzle-orm"` directly (not from a re-export).

- [ ] **Step 3: Verify typecheck**

Run: `cd /Users/gandazhi/code/agent/opencode/packages/opencode && bun run typecheck 2>&1 | grep "persistence" || echo "no persistence errors"`

- [ ] **Step 4: Commit**

```bash
cd /Users/gandazhi/code/agent/opencode
git add packages/opencode/src/workflow/persistence.ts
git commit -m "feat(workflow): port persistence.ts — DB + journal IO"
```

---

## Task 12: Create the full runtime.ts (core engine with rewritten spawn)

This is the largest and most critical task. The runtime.ts from MiMo-Code is ~1234 lines. We port it with the following changes:
1. Import paths adapted (`@/bus` → EventV2, `@/inbox` → SessionPrompt, `@/actor/spawn-ref` → removed)
2. `spawnShared` rewritten to use `sessions.create` + `prompts.prompt`
3. `spawnIsolated` removed (isolation:"worktree" falls through to spawnShared)
4. Notification via synthetic-message injection (replaces Inbox.send)
5. Model ref resolution simplified (no tier names)

**Files:**
- Create: `packages/opencode/src/workflow/runtime.ts`
- Source: `/Users/gandazhi/code/agent/MiMo-Code/packages/opencode/src/workflow/runtime.ts`

- [ ] **Step 1: Copy the source runtime.ts as a starting point**

Run:
```bash
cp /Users/gandazhi/code/agent/MiMo-Code/packages/opencode/src/workflow/runtime.ts \
   /Users/gandazhi/code/agent/opencode/packages/opencode/src/workflow/runtime.ts
```

- [ ] **Step 2: Fix import block**

Replace the import section at the top of `runtime.ts`. The original imports are:

```ts
// ORIGINAL (MiMo-Code) — REPLACE THESE:
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import os from "node:os"
import { createHash } from "node:crypto"
import { spawnRef } from "@/actor/spawn-ref"           // ← REMOVE
import { workflowRef } from "./runtime-ref"
import { Config } from "@/config"
import { EffectBridge } from "@/effect"
import { Bus } from "@/bus"                             // ← REPLACE with EventV2Bridge
import { Inbox } from "@/inbox"                         // ← REMOVE
import { Worktree } from "@/worktree"
import { Provider } from "@/provider"
import { InstanceRef } from "@/effect/instance-ref"     // ← REMOVE (no worktree isolation)
import { Instance } from "@/project/instance"           // ← KEEP for worktree root
import { Identifier } from "@/id/id"
import type { SessionID } from "@/session/schema"
import type { ProviderID, ModelID } from "@/provider/schema"
import { parseMeta } from "./meta"
import { evalScript, type HostFn } from "./sandbox"
import { makeFileHooks, resolveInWorkspace } from "./workspace"
import { isInlineScript, resolveWorkflowScript } from "./resolve"
import { WorkflowAgentFailed, WorkflowChildFailed, WorkflowFinished, WorkflowLog, WorkflowPhase, WorkflowStarted } from "./events"
import { WorkflowPersistence, journalKeyBase } from "./persistence"
import type { RunSummary } from "./persistence"
import { Log, Lock } from "@/util"
```

Replace with:

```ts
// ADAPTED for target repo:
import { Context, Deferred, Effect, Exit, Fiber, Layer, Schema, Scope } from "effect"
import os from "node:os"
import { createHash } from "node:crypto"
import { workflowRef } from "./runtime-ref"
import { Config } from "@/config/config"
import { EffectBridge } from "@/effect/bridge"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { Agent } from "@/agent/agent"
import { deriveSubagentSessionPermission } from "@/agent/subagent-permissions"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Identifier } from "@/id/id"
import type { SessionID } from "@/session/schema"
import type { ProviderID, ModelID } from "@/provider/schema"
import { parseMeta } from "./meta"
import { evalScript, type HostFn } from "./sandbox"
import { makeFileHooks, resolveInWorkspace } from "./workspace"
import { isInlineScript, resolveWorkflowScript } from "./resolve"
import { WorkflowAgentFailed, WorkflowChildFailed, WorkflowFinished, WorkflowLog, WorkflowPhase, WorkflowStarted } from "./events"
import { WorkflowPersistence, journalKeyBase } from "./persistence"
import type { RunSummary } from "./persistence"
import { InstanceState } from "@/effect/instance-state"
import { Database } from "@opencode-ai/core/database/database"
```

> **Note**: `spawnRef`, `Inbox`, `Worktree`, `InstanceRef`, `Bus`, `Instance` imports are removed. `Session`, `SessionPrompt`, `Agent`, `deriveSubagentSessionPermission`, `SessionV1`, `EventV2Bridge` are added. `Log` and `Lock` from `@/util` — check if the target has equivalents; if not, use `console.warn` and a simple in-process mutex.

- [ ] **Step 3: Find Lock and Log equivalents**

Run: `cd /Users/gandazhi/code/agent/opencode && grep -rn "export.*Lock\|export.*function.*write.*lock\|class.*Lock" packages/opencode/src/ packages/core/src/ --include="*.ts" | head -10`

If no `Lock` exists, create a minimal inline mutex in runtime.ts:

```ts
// Minimal in-process mutex (if no @/util Lock exists)
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
```

- [ ] **Step 4: Replace the layer dependencies**

In the `layer` definition (the `Layer.effect(Service, Effect.gen(...))` block), find where services are pulled:

```ts
// ORIGINAL:
const bus = yield* Bus.Service
const inbox = yield* Inbox.Service
const worktree = yield* Worktree.Service
const provider = yield* Provider.Service
```

Replace with:

```ts
// ADAPTED:
const events = yield* EventV2Bridge.Service
const provider = yield* Provider.Service
```

`bus` → `events` everywhere. `inbox` is removed. `worktree` is removed (no isolation spawn in v1).

- [ ] **Step 5: Replace all `bus.publish` calls with `events.publish`**

Find all occurrences of `yield* bus.publish(SomeEvent, { ... })` and replace with `yield* events.publish(SomeEvent, { ... })`.

Also replace the `Effect.runFork(bus.publish(...))` fire-and-forget pattern with `Effect.runFork(events.publish(...))`.

There are approximately 8-10 `bus.publish` calls to replace. Search and replace:
- `bus.publish(WorkflowStarted` → `events.publish(WorkflowStarted`
- `bus.publish(WorkflowFinished` → `events.publish(WorkflowFinished`
- `bus.publish(WorkflowPhase` → `events.publish(WorkflowPhase`
- `bus.publish(WorkflowLog` → `events.publish(WorkflowLog`
- `bus.publish(WorkflowAgentFailed` → `events.publish(WorkflowAgentFailed`
- `bus.publish(WorkflowChildFailed` → `events.publish(WorkflowChildFailed`

- [ ] **Step 6: Rewrite `spawnShared` function**

Find the `spawnShared` function definition (around line 559 in the original). Replace the ENTIRE function body. The original uses `actor.spawn(...)` + `Deferred.await(spawned.outcome)`. Replace with:

```ts
const spawnShared = async (
  prompt: string,
  o: AgentOpts,
  resolvedModel: { providerID: ProviderID; modelID: ModelID } | undefined,
): Promise<unknown> => {
  entry.running++
  scheduleFlush(entry)
  let reason: FailReason = "actor-error"
  let errorMessage: string | undefined
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
          title: o.label ?? `workflow agent`,
          agent: subagent.name,
          permission,
        })

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
                ? { format: { type: "json_schema" as const, schema: o.schema } }
                : {}),
            })
            .pipe(
              Effect.map((msg: SessionV1.WithParts) => {
                if (o.schema) {
                  const v = (msg.info as { structured?: unknown }).structured ?? null
                  if (v === null) reason = "no-deliverable"
                  return v
                }
                const text = msg.parts.findLast((p: SessionV1.Part) => p.type === "text")?.text ?? null
                // text is typed as Schema.optional(Schema.String), so it can be undefined
                const v = text ?? null
                if (v === null) reason = "no-deliverable"
                return v
              }),
              Effect.catchCause(() =>
                Effect.sync(() => {
                  reason = "actor-error"
                  return null
                }),
              ),
            ),
          () => {
            reason = "timeout"
            // Cancel the child session prompt on timeout
            Effect.runFork(prompts.cancel(child.id).pipe(Effect.ignore))
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
  return value
}
```

> **Key differences from original**:
> - No `actor` parameter — services pulled from Effect context
> - `sessions.create` replaces `actor.spawn`
> - `prompts.prompt` replaces `Deferred.await(spawned.outcome)`
> - `msg.info.structured` / `msg.parts.findLast` replaces `outcome.structured` / `outcome.finalText`
> - `prompts.cancel` replaces `actor.cancel`
> - No `onActorID` callback (session ID is available synchronously)
> - No `childActorIDs` tracking (no reclaim needed for sessions — Session.remove handles cleanup)

- [ ] **Step 7: Remove `spawnIsolated` function**

Find the `spawnIsolated` function (around line 650-796 in original). Delete the ENTIRE function.

Then find where `agent()` hook dispatches based on `o.isolation`:

```ts
// ORIGINAL:
const agent: HostFn = (prompt, opts) => {
  const o = (opts ?? {}) as AgentOpts
  if (o.isolation !== "worktree") {
    // ... shared spawn path
  }
  return sem.run(async () => globalSemLocal.run(async () => {
    // ... isolated spawn path
  }))
}
```

Change to always use shared spawn (remove the isolation branch):

```ts
const agent: HostFn = (prompt: unknown, opts?: unknown) => {
  const o = (opts ?? {}) as AgentOpts
  const promptStr = String(prompt)
  // worktree isolation not supported in v1 — always shared spawn
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
    const result = await sem.run(async () =>
      globalSemLocal.run(async () => {
        if (entry.agentCount >= lifecycleCap) {
          warnCapOnce()
          publishAgentFailed(o, "over-cap")
          return null
        }
        entry.agentCount++
        const resolvedModel = await bridge.promise(resolveAgentModel(o.model, input.model, entry.warnedModelRefs))
        return spawnShared(promptStr, o, resolvedModel)
      }),
    )
    if (result !== null) {
      await Effect.runPromise(
        WorkflowPersistence.appendJournalSync(runID, [{ t: "agent", key, result, pass }]).pipe(Effect.ignore),
      )
    }
    return result
  })()
}
```

- [ ] **Step 8: Replace Inbox notification with synthetic-message injection**

Find the notification code in the work fiber's success/failure handlers (around line 1059-1091 in original). The original uses:

```ts
// ORIGINAL (success):
yield* inbox.send({
  receiverSessionID: input.sessionID,
  receiverActorID: input.parentActorID,
  ...
})
```

Replace with synthetic-message injection:

```ts
// ADAPTED (success):
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
```

Do the same for the failure path (replace `inbox.send` with `prompts.prompt` injecting the error message).

- [ ] **Step 9: Simplify resolveAgentModel**

Find the `resolveAgentModel` function (around line 204). Replace the body that calls `provider.resolveModelRef` with:

```ts
const resolveAgentModel = (
  ref: string | undefined,
  fallback: { providerID: ProviderID; modelID: ModelID } | undefined,
  warned: Set<string>,
): Effect.Effect<{ providerID: ProviderID; modelID: ModelID } | undefined> =>
  ref === undefined
    ? Effect.succeed(fallback)
    : ref.includes("/")
      ? Effect.try({
          try: () => Provider.parseModel(ref),
          catch: () => {
            if (!warned.has(ref)) {
              warned.add(ref)
              log.warn("workflow agent model ref did not resolve — using run default", { ref })
            }
            return fallback
          },
        }).pipe(
          Effect.catchAll(() => Effect.sync(() => fallback)),
        )
      : Effect.sync(() => {
          // Tier names (e.g. "lite") not supported in v1 — fallback
          if (!warned.has(ref)) {
            warned.add(ref)
            log.warn("workflow agent model tier not supported in v1 — using run default", { ref })
          }
          return fallback
        })
```

Wait — `Effect.try` with a function returning `fallback` in the catch is wrong. Fix:

```ts
const resolveAgentModel = (
  ref: string | undefined,
  fallback: { providerID: ProviderID; modelID: ModelID } | undefined,
  warned: Set<string>,
): Effect.Effect<{ providerID: ProviderID; modelID: ModelID } | undefined> => {
  if (ref === undefined) return Effect.succeed(fallback)
  if (ref.includes("/")) {
    return Effect.try({
      try: () => Provider.parseModel(ref),
      catch: () => null,
    }).pipe(
      Effect.map((m) => m ?? fallbackRef(ref, fallback, warned)),
    )
  }
  // Tier name — not supported in v1
  return Effect.succeed(fallbackRef(ref, fallback, warned))
}

function fallbackRef(
  ref: string,
  fallback: { providerID: ProviderID; modelID: ModelID } | undefined,
  warned: Set<string>,
) {
  if (!warned.has(ref)) {
    warned.add(ref)
    log.warn("workflow agent model ref did not resolve — using run default", { ref })
  }
  return fallback
}
```

- [ ] **Step 10: Remove reclaim's actor-cancel and worktree-remove**

Find the `reclaim` function (around line 312). The original cancels child actors and removes worktrees. Since we don't track childActorIDs or worktrees in v1, simplify:

```ts
const reclaim = (entry: RunEntry) =>
  Effect.gen(function* () {
    // v1: no actor tracking or worktree cleanup needed.
    // Sessions are self-contained; Session.remove handles child cleanup.
    // Only recurse into child workflow runs for cancel.
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
```

- [ ] **Step 11: Fix defaultLayer dependencies**

Find `defaultLayer` at the bottom of the file:

```ts
// ORIGINAL:
export const defaultLayer = layer.pipe(
  Layer.provide(Bus.defaultLayer),
  Layer.provide(Inbox.defaultLayer),
  Layer.provide(Worktree.defaultLayer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Config.defaultLayer),
)
```

Replace with:

```ts
// ADAPTED:
export const defaultLayer = layer.pipe(
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Config.defaultLayer),
  // EventV2Bridge, Session, SessionPrompt, Agent, Database are provided
  // by the app runtime's AppLayer (they're already in Layer.mergeAll)
)
```

- [ ] **Step 12: Verify typecheck**

Run: `cd /Users/gandazhi/code/agent/opencode/packages/opencode && bun run typecheck 2>&1 | head -40`

Fix any remaining import/type errors. Common issues:
- `SessionV1.WithParts` / `SessionV1.Part` type paths — verify from `@opencode-ai/core/v1/session`
- `prompts.resolvePromptParts` return type — may need casting
- `msg.info.structured` — the `SessionV1` message type may not have `structured` directly; check the actual field path

- [ ] **Step 13: Commit**

```bash
cd /Users/gandazhi/code/agent/opencode
git add packages/opencode/src/workflow/runtime.ts
git commit -m "feat(workflow): port runtime.ts — core engine with rewritten spawn

- spawnShared rewritten: sessions.create + prompts.prompt (replaces actor.spawn)
- spawnIsolated removed (worktree isolation deferred to v2)
- bus.publish → events.publish (EventV2Bridge)
- inbox.send → prompts.prompt synthetic message injection
- resolveAgentModel simplified (no tier name support in v1)
- reclaim simplified (no actor/worktree tracking)"
```

---

## Task 13: Add experimentalDynamicWorkflow flag

**Files:**
- Modify: `packages/opencode/src/effect/runtime-flags.ts`

- [ ] **Step 1: Add flag**

In `packages/opencode/src/effect/runtime-flags.ts`, add to the `ConfigService.Service` object literal (after `experimentalWorkspaces` or wherever alphabetical order fits):

```ts
experimentalDynamicWorkflow: enabledByExperimental("OPENCODE_EXPERIMENTAL_DYNAMIC_WORKFLOW"),
```

- [ ] **Step 2: Verify typecheck**

Run: `cd /Users/gandazhi/code/agent/opencode/packages/opencode && bun run typecheck 2>&1 | grep "runtime-flags" || echo "no errors"`

- [ ] **Step 3: Commit**

```bash
cd /Users/gandazhi/code/agent/opencode
git add packages/opencode/src/effect/runtime-flags.ts
git commit -m "feat(flags): add experimentalDynamicWorkflow flag"
```

---

## Task 14: Add workflow config section

**Files:**
- Modify: `packages/opencode/src/config/config.ts` (or create a separate schema)

The target repo's config sections are defined in `@opencode-ai/core/v1/config`. We need to add a `workflow` field. Check if there's a pattern for adding config sections.

- [ ] **Step 1: Find how config sections are defined**

Run: `cd /Users/gandazhi/code/agent/opencode && grep -rn "workflow\|experimental" packages/core/src/v1/config/ --include="*.ts" | head -10`

Check if `ConfigV1.Info` already has an `experimental` field where we can nest workflow settings.

- [ ] **Step 2: Add workflow config**

The simplest approach: add a `workflow` field to the config schema. In the target repo, the master config schema is `ConfigV1.Info` from `@opencode-ai/core/v1/config/config`. If we can't modify core, define it locally.

In `packages/opencode/src/config/config.ts`, find where `Info` type is extended. Add:

```ts
// If ConfigV1.Info is extensible, add:
// workflow: Schema.optional(Schema.Struct({
//   maxConcurrentAgents: Schema.optional(Schema.Number),
//   maxDepth: Schema.optional(Schema.Number),
//   maxLifecycleAgents: Schema.optional(Schema.Number),
//   scriptDeadlineMs: Schema.optional(Schema.Number),
// }))
```

If the core schema can't be modified easily, the runtime can read from `config.experimental` or a separate config key. The simplest path: read from `opencode.json` directly in runtime.ts via the `Config.Service`.

> **Pragmatic approach**: Since the config system is complex and shared with core, for v1 read the workflow settings from a dedicated config path. In runtime.ts, read `cfg.workflow` (typed loosely). The config schema addition can be a follow-up.

- [ ] **Step 3: Commit (or defer if config system requires core changes)**

If config section was added:
```bash
git add packages/opencode/src/config/
git commit -m "feat(config): add workflow runtime settings"
```

---

## Task 15: Create the workflow tool

**Files:**
- Create: `packages/opencode/src/tool/workflow.ts`
- Create: `packages/opencode/src/tool/workflow.txt`
- Source: MiMo-Code equivalents

- [ ] **Step 1: Copy workflow.txt**

Run:
```bash
cp /Users/gandazhi/code/agent/MiMo-Code/packages/opencode/src/tool/workflow.txt \
   /Users/gandazhi/code/agent/opencode/packages/opencode/src/tool/workflow.txt
```

- [ ] **Step 2: Copy and adapt workflow.ts**

Run:
```bash
cp /Users/gandazhi/code/agent/MiMo-Code/packages/opencode/src/tool/workflow.ts \
   /Users/gandazhi/code/agent/opencode/packages/opencode/src/tool/workflow.ts
```

Then fix imports. The original imports:

```ts
import * as Tool from "./tool"
import DESCRIPTION from "./workflow.txt"
import z from "zod"
import { Effect } from "effect"
import { Config } from "../config"
import { workflowRef } from "@/workflow/runtime-ref"
import { BuiltinWorkflow } from "@/workflow/builtin"
import type { SessionID } from "../session/schema"
```

Adapted:

```ts
import * as Tool from "./tool"
import DESCRIPTION from "./workflow.txt"
import z from "zod"
import { Effect } from "effect"
import { Config } from "@/config/config"
import { workflowRef } from "@/workflow/runtime-ref"
import { BuiltinWorkflow } from "@/workflow/builtin"
import type { SessionID } from "@/session/schema"
```

> **IMPORTANT**: Check how `Tool.define` works in the target repo (Task 2 of the API reference shows `Tool.define(id, Effect.gen(...))`). The MiMo-Code version uses `Tool.define<typeof parameters, Metadata, Config.Service>`. Verify this matches the target's `Tool.define` signature and adapt if needed.

- [ ] **Step 3: Verify typecheck**

Run: `cd /Users/gandazhi/code/agent/opencode/packages/opencode && bun run typecheck 2>&1 | grep "tool/workflow" || echo "no errors"`

- [ ] **Step 4: Commit**

```bash
cd /Users/gandazhi/code/agent/opencode
git add packages/opencode/src/tool/workflow.ts packages/opencode/src/tool/workflow.txt
git commit -m "feat(workflow): add workflow tool definition"
```

---

## Task 16: Register workflow tool in registry

**Files:**
- Modify: `packages/opencode/src/tool/registry.ts`

- [ ] **Step 1: Import WorkflowTool**

At the top of `packages/opencode/src/tool/registry.ts`, add:

```ts
import { WorkflowTool } from "./workflow"
import { BuiltinWorkflow } from "@/workflow/builtin"
```

- [ ] **Step 2: Add workflow tool init**

In the `Effect.all({ ... })` block where tools are initialized, add:

```ts
workflow: Tool.init(WorkflowTool),
```

> Note: This may fail typecheck if `Tool.init` requires specific dependencies. The workflow tool uses `workflowRef` (late binding) so it should only need `Config.Service`.

- [ ] **Step 3: Add to builtin array (flag-gated)**

Find the `builtin` array and add:

```ts
...(flags.experimentalDynamicWorkflow ? [tool.workflow] : []),
```

- [ ] **Step 4: Verify typecheck**

Run: `cd /Users/gandazhi/code/agent/opencode/packages/opencode && bun run typecheck 2>&1 | grep "registry" || echo "no errors"`

- [ ] **Step 5: Commit**

```bash
cd /Users/gandazhi/code/agent/opencode
git add packages/opencode/src/tool/registry.ts
git commit -m "feat(workflow): register workflow tool (flag-gated)"
```

---

## Task 17: Wire WorkflowRuntime.defaultLayer into app runtime

**Files:**
- Modify: `packages/opencode/src/effect/app-runtime.ts`

- [ ] **Step 1: Import and add to AppLayer**

In `packages/opencode/src/effect/app-runtime.ts`:

Add import:
```ts
import { WorkflowRuntime } from "@/workflow/runtime"
```

Add to `Layer.mergeAll(...)` — after `SessionPrompt.defaultLayer`:

```ts
  SessionPrompt.defaultLayer,
  WorkflowRuntime.defaultLayer,    // ← ADD THIS
  Instruction.defaultLayer,
```

- [ ] **Step 2: Verify typecheck**

Run: `cd /Users/gandazhi/code/agent/opencode/packages/opencode && bun run typecheck 2>&1 | grep "app-runtime" || echo "no errors"`

- [ ] **Step 3: Commit**

```bash
cd /Users/gandazhi/code/agent/opencode
git add packages/opencode/src/effect/app-runtime.ts
git commit -m "feat(workflow): wire WorkflowRuntime.defaultLayer into AppLayer"
```

---

## Task 18: Add /deep-research command

**Files:**
- Modify: `packages/opencode/src/command/index.ts`

- [ ] **Step 1: Add the deep-research command**

In `packages/opencode/src/command/index.ts`, add `DEEP_RESEARCH` to the `Default` const and register the command:

Add to `Default`:
```ts
export const Default = {
  // ... existing entries
  DEEP_RESEARCH: "deep-research",
} as const
```

Add the template function:
```ts
export function deepResearchTemplate(): string {
  return [
    "The user wants a deep, multi-source, fact-checked research report.",
    "",
    "Research request:",
    "$ARGUMENTS",
    "",
    "If the request is underspecified (missing scope, constraints, region, time range, etc.),",
    "ask 2-3 brief clarifying questions FIRST, then weave the answers into a refined question.",
    "",
    "When the request is specific enough, run the built-in deep-research workflow:",
    '  workflow({ operation: "run", name: "deep-research", args: "<the refined research question>" })',
    "",
    "Pass the full refined question as `args`. The workflow fans out web searches, fetches sources,",
    "adversarially verifies claims, and returns a cited report; relay its result to the user.",
  ].join("\n")
}
```

Add registration (flag-gated):
```ts
if (flags.experimentalDynamicWorkflow) {
  commands[Default.DEEP_RESEARCH] = {
    name: Default.DEEP_RESEARCH,
    description: "deep multi-source, fact-checked research report (runs the deep-research workflow)",
    source: "command",
    subtask: false,
    get template() {
      return deepResearchTemplate()
    },
    hints: ["$ARGUMENTS"],
  }
}
```

> **IMPORTANT**: Check how `flags` is accessed in this file — it's likely `yield* RuntimeFlags.Service` or similar. Match the existing pattern.

- [ ] **Step 2: Verify typecheck**

Run: `cd /Users/gandazhi/code/agent/opencode/packages/opencode && bun run typecheck 2>&1 | grep "command" || echo "no errors"`

- [ ] **Step 3: Commit**

```bash
cd /Users/gandazhi/code/agent/opencode
git add packages/opencode/src/command/index.ts
git commit -m "feat(workflow): add /deep-research command"
```

---

## Task 19: Create HTTP API routes

**Files:**
- Create: `packages/opencode/src/server/routes/instance/httpapi/groups/workflow.ts`
- Source: `/Users/gandazhi/code/agent/MiMo-Code/packages/opencode/src/server/routes/instance/workflows.ts`

The target repo uses Effect's `HttpApi`/`HttpApiGroup` pattern (not hono). Follow the existing group pattern from `session.ts`.

- [ ] **Step 1: Study the existing group pattern**

Read `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts` to understand the `HttpApiGroup.make` + `HttpApiEndpoint.get/post` pattern. Record how schemas, middleware, and OpenAPI annotations work.

- [ ] **Step 2: Create workflow.ts route group**

Create `packages/opencode/src/server/routes/instance/httpapi/groups/workflow.ts`:

```ts
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
import { Authorization } from "../middleware/authorization"
import { workflowRef } from "@/workflow/runtime-ref"
import { Identifier } from "@/id/id"
import { SessionID } from "@/session/schema"

const WorkflowRunSummary = Schema.Struct({
  runID: Schema.String,
  sessionID: SessionID,
  name: Schema.String,
  status: Schema.Union(
    Schema.Literal("running"),
    Schema.Literal("completed"),
    Schema.Literal("failed"),
    Schema.Literal("cancelled"),
  ),
  running: Schema.Number,
  succeeded: Schema.Number,
  failed: Schema.Number,
  currentPhase: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
})

const ListQuery = Schema.Struct({
  session_id: Schema.optional(SessionID),
})

const ResumeParams = Schema.Struct({
  runID: Schema.String,
})

export const WorkflowApi = HttpApi.make("workflow")
  .add(
    HttpApiGroup.make("workflow")
      .add(
        HttpApiEndpoint.get("list", "/workflows", {
          query: ListQuery,
          success: Schema.Array(Schema.asSchema(WorkflowRunSummary)),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.list",
            summary: "List workflow runs",
            description:
              "List dynamic-workflow runs for a session. session_id is REQUIRED — there is no per-user identity, so the session is the access boundary and an omitted/invalid session_id is a 400.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.post("resume", "/workflows/:runID/resume", {
          params: ResumeParams,
          success: Schema.Struct({
            runID: Schema.String,
            resumed: Schema.Boolean,
          }),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.resume",
            summary: "Resume a workflow run",
            description:
              "Re-launch a persisted workflow run by id. Returns { runID, resumed }; resumed is false if the run is unknown, still running, or has no persisted script.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "workflow", description: "Dynamic workflow management" }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Workflow API",
    }),
  )
```

> **IMPORTANT**: The actual route handler logic (calling `workflowRef.current`) needs to be wired. In the Effect HttpApi pattern, handlers are registered separately from the route definition. Check how `session.ts` registers its handlers (likely in a separate `handlers` array or via `HttpApiBuilder.handle`).

- [ ] **Step 3: Register the route group**

Find where route groups are aggregated (likely in a parent router or `httpapi/index.ts`). Add `WorkflowApi` to the aggregation.

- [ ] **Step 4: Implement the handlers**

The list handler calls `workflowRef.current?.list({ sessionID })`, the resume handler calls `workflowRef.current?.resume({ runID })`. Both guard on `workflowRef.current` being undefined.

- [ ] **Step 5: Verify typecheck and commit**

```bash
cd /Users/gandazhi/code/agent/opencode/packages/opencode && bun run typecheck 2>&1 | grep "workflow.ts" | grep -v "src/workflow" || echo "no route errors"
```

```bash
cd /Users/gandazhi/code/agent/opencode
git add packages/opencode/src/server/routes/instance/httpapi/groups/workflow.ts
git commit -m "feat(workflow): add HTTP API routes (list + resume)"
```

---

## Task 20: Add TUI workflow state slice

**Files:**
- Modify: `packages/tui/src/context/sync.tsx`

- [ ] **Step 1: Add WorkflowRun type**

Near the other type definitions in `sync.tsx`:

```ts
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
}
```

- [ ] **Step 2: Add to store**

In the `createStore` generic type:

```ts
workflow: { [runID: string]: WorkflowRun }
```

In the initial values:

```ts
workflow: {},
```

- [ ] **Step 3: Add event handlers**

In the event subscription `switch` block:

```ts
case "workflow.started": {
  const p = event.properties
  setStore("workflow", p.runID, {
    runID: p.runID,
    sessionID: p.sessionID,
    name: p.name,
    status: "running",
    running: 0,
    succeeded: 0,
    failed: 0,
  })
  break
}
case "workflow.phase": {
  if (!store.workflow[event.properties.runID]) break
  setStore("workflow", event.properties.runID, "currentPhase", event.properties.title)
  break
}
case "workflow.finished": {
  if (!store.workflow[event.properties.runID]) break
  setStore("workflow", event.properties.runID, "status", event.properties.status)
  break
}
```

- [ ] **Step 4: Add loadWorkflows and resumeWorkflow methods**

```ts
async function loadWorkflows(sessionID: string) {
  try {
    const res = await sdk.client.workflow.list({ session_id: sessionID })
    if (res.data) {
      for (const run of res.data as WorkflowRun[]) {
        setStore("workflow", run.runID, reconcile(run))
      }
    }
  } catch {}
}

async function resumeWorkflow(runID: string) {
  try {
    await sdk.client.workflow.resume({ runID })
  } catch {}
}
```

> **Note**: The SDK client methods (`sdk.client.workflow.list/resume`) need to exist. They are auto-generated from the HTTP API schema. After Task 19 creates the API, regenerate the SDK or verify the client is auto-wired.

- [ ] **Step 5: Expose methods from the context**

Add `loadWorkflows` and `resumeWorkflow` to the return value of the sync context.

- [ ] **Step 6: Commit**

```bash
cd /Users/gandazhi/code/agent/opencode
git add packages/tui/src/context/sync.tsx
git commit -m "feat(tui): add workflow state slice, event handlers, and API methods"
```

---

## Task 21: Create TUI /workflows dialog

**Files:**
- Create: `packages/tui/src/component/dialog-workflows.tsx`
- Source: `/Users/gandazhi/code/agent/MiMo-Code/packages/opencode/src/cli/cmd/tui/component/dialog-workflows.tsx`

- [ ] **Step 1: Find the target repo's dialog UI primitives**

Run: `ls /Users/gandazhi/code/agent/opencode/packages/tui/src/ui/dialog*.tsx`

Record the exact export names for `useDialog`, `DialogConfirm`, `DialogSelect`.

- [ ] **Step 2: Create dialog-workflows.tsx**

Create `packages/tui/src/component/dialog-workflows.tsx`:

```tsx
import { useDialog } from "@/ui/dialog"
import { DialogConfirm } from "@/ui/dialog-confirm"
import { DialogSelect, type DialogSelectOption } from "@/ui/dialog-select"
import { useRoute } from "@/context/route"
import { useSync } from "@/context/sync"
import { createMemo, onCleanup, onMount } from "solid-js"

export function DialogWorkflows() {
  const dialog = useDialog()
  const route = useRoute()
  const sync = useSync()

  const currentSessionID = createMemo(() =>
    route.data.type === "session" ? route.data.sessionID : undefined,
  )

  onMount(() => {
    const sid = currentSessionID()
    if (sid) sync.loadWorkflows(sid)
    const interval = setInterval(() => {
      const s = currentSessionID()
      if (s) sync.loadWorkflows(s)
    }, 1000)
    onCleanup(() => clearInterval(interval))
  })

  const runs = createMemo(() => {
    const sid = currentSessionID()
    return Object.values(sync.data.workflow)
      .filter((r) => !sid || r.sessionID === sid)
      .toSorted((a, b) => (a.runID < b.runID ? -1 : 1))
  })

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const list = runs()
    if (list.length === 0)
      return [{ title: "(no workflow runs)", value: "empty", onSelect: (d) => d.clear() }]
    return list.map((r) => ({
      title: `${r.name}  ${r.status}  ${r.currentPhase ?? "-"}  ${r.succeeded}\u2713 ${r.failed}\u2717 ${r.running}\u27f3`,
      value: r.runID,
      onSelect: async (d) => {
        if (r.status === "running" || r.status === "failed" || r.status === "cancelled") {
          const ok = await DialogConfirm.show(
            d,
            "Resume workflow",
            `Re-run "${r.name}"? This re-executes the workflow and may incur cost.`,
          )
          if (ok === true) void sync.resumeWorkflow(r.runID)
          return
        }
        d.clear()
      },
    }))
  })

  return <DialogSelect title="Workflows" options={options()} />
}
```

> **IMPORTANT**: Verify the exact import paths and component APIs from step 1. The dialog primitives may have slightly different names or props in the target repo.

- [ ] **Step 3: Commit**

```bash
cd /Users/gandazhi/code/agent/opencode
git add packages/tui/src/component/dialog-workflows.tsx
git commit -m "feat(tui): add /workflows dialog component"
```

---

## Task 22: Register /workflows command in TUI

**Files:**
- Modify: `packages/tui/src/app.tsx`

- [ ] **Step 1: Import DialogWorkflows**

```ts
import { DialogWorkflows } from "@/component/dialog-workflows"
```

- [ ] **Step 2: Add command to appCommands**

In the `appCommands` createMemo array, add:

```ts
{
  name: "workflow.list",
  title: "Workflows",
  category: "Session",
  slashName: "workflows",
  run: () => {
    dialog.replace(() => <DialogWorkflows />)
  },
},
```

> **Note**: If the flag needs to be checked in TUI (the target repo's TUI may have its own flag system), add an `enabled` check. Otherwise the command is always available and the workflow tool is gated server-side.

- [ ] **Step 3: Commit**

```bash
cd /Users/gandazhi/code/agent/opencode
git add packages/tui/src/app.tsx
git commit -m "feat(tui): register /workflows command"
```

---

## Task 23: Integration test — basic workflow run

**Files:**
- Create: `packages/opencode/test/workflow/runtime.test.ts`

- [ ] **Step 1: Write integration test**

```ts
import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { WorkflowRuntime } from "@/workflow/runtime"
// Import the test runtime/layers from the repo's test helpers

describe("workflow runtime", () => {
  it("runs a simple workflow script that returns a value", async () => {
    const script = `
export const meta = { name: "test-simple", description: "test" }
return { ok: true, value: 42 }
`
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* WorkflowRuntime.Service
        const started = yield* runtime.start({
          script,
          sessionID: "test-session" as any,
          parentActorID: "test",
        })
        return yield* runtime.wait({ runID: started.runID, timeoutMs: 5000 })
      }).pipe(Effect.provide(WorkflowRuntime.defaultLayer)),
    )
    expect(result.status).toBe("completed")
  })
})
```

> **Note**: This test needs a proper test layer providing Session, SessionPrompt, Agent, etc. Check the target repo's existing test patterns for how to construct test layers. The test may need to mock `sessions.create` and `prompts.prompt` for a true unit test, or use a real session for integration.

- [ ] **Step 2: Run test**

Run: `cd /Users/gandazhi/code/agent/opencode/packages/opencode && bun test test/workflow/runtime.test.ts`

Expected: test passes

- [ ] **Step 3: Commit**

```bash
cd /Users/gandazhi/code/agent/opencode
git add packages/opencode/test/workflow/runtime.test.ts
git commit -m "test(workflow): basic runtime integration test"
```

---

## Task 24: Gate test — /deep-research end-to-end

This is the migration's **acceptance test**. It verifies the full pipeline works.

**Manual verification steps:**

- [ ] **Step 1: Build and start the server**

```bash
cd /Users/gandazhi/code/agent/opencode
OPENCODE_EXPERIMENTAL_DYNAMIC_WORKFLOW=1 bun run dev
```

Or if there's a specific start command:
```bash
OPENCODE_EXPERIMENTAL_DYNAMIC_WORKFLOW=1 bun run packages/opencode/src/index.ts
```

- [ ] **Step 2: Open TUI**

```bash
OPENCODE_EXPERIMENTAL_DYNAMIC_WORKFLOW=1 opencode
```

- [ ] **Step 3: Verify /deep-research command exists**

Type `/deep` in the TUI — the `/deep-research` command should appear in autocomplete.

- [ ] **Step 4: Run deep-research**

```
/deep-research What are the performance differences between Bun and Node.js?
```

- [ ] **Step 5: Verify workflow starts**

Open `/workflows` — should show a `deep-research` run with status `running` and live counters updating.

- [ ] **Step 6: Verify completion**

Wait for the run to complete. Verify:
1. Status changes to `completed` in `/workflows`
2. The parent session receives a synthetic message with the result
3. The result contains `answer`, `findings`, `sources`, `stats` fields
4. `stats.agentRuns` > 0

- [ ] **Step 7: Verify journal exists**

```bash
ls ~/.local/share/opencode/workflow/*.jsonl
cat ~/.local/share/opencode/workflow/wf_*.jsonl | head -5
```

Expected: journal file exists with agent result entries.

- [ ] **Step 8: Test resume**

From `/workflows`, select the completed run and choose to resume. Verify it re-runs (replays journal hits instantly for cached agents).

- [ ] **Step 9: Document the verification**

If all steps pass, the migration is complete. If any step fails, file issues for the specific failures.

---

## Post-migration checklist

- [ ] All files in `packages/opencode/src/workflow/` follow the self-export pattern (`export * as Xxx from "./xxx"`)
- [ ] `docs/workflow/workflow-rules.md` accurately describes the target repo's behavior
- [ ] `docs/workflow/workflow-best-practices.md` references `.opencode/workflows/` (not `.mimocode/`)
- [ ] `bun run typecheck` passes from `packages/opencode`
- [ ] `bun test` passes for workflow tests
- [ ] `/deep-research` runs end-to-end
- [ ] `/workflows` TUI dialog shows runs and allows resume
- [ ] Journal files are created and replayable on resume
