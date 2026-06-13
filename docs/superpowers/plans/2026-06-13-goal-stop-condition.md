# Goal 停止条件功能 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 MiMo-Code 的 goal 停止条件功能迁移到 forked opencode，实现 `/goal <条件>` 命令 + 独立裁判模型门控 + TUI 侧边栏展示。

**Architecture:** 纯内存 Service（InstanceState Map）存储 per-session goal 状态。runLoop 停止前调用独立裁判模型判定条件是否满足。可配置裁判模型，未配置时 fallback 到 session 当前模型。通过 EventV2 广播状态变更给 TUI。

**Tech Stack:** TypeScript, Effect (Context/Layer/Service), Bun, AI SDK (generateObject/streamObject), SolidJS (TUI), zod, Drizzle/Effect Schema.

**Spec:** `docs/superpowers/specs/2026-06-13-goal-stop-condition-design.md`

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `packages/core/src/v1/config/config.ts` | 修改 | `Info` schema 新增 `goal` 可选字段 |
| `packages/opencode/src/session/goal.ts` | 新建 | 核心 Service：InstanceState Map + 5 个方法 + 裁判调用 + 事件 |
| `packages/opencode/src/command/index.ts` | 修改 | 新增 `Default.GOAL` 常量 |
| `packages/opencode/src/session/prompt.ts` | 修改 | `/goal` 命令处理 + goalGate + runLoop 集成 + layer 装配 |
| `packages/opencode/test/session/goal.test.ts` | 新建 | Service 状态机 + 事件测试 |
| `packages/tui/src/context/sync.tsx` | 修改 | store + 事件处理 |
| `packages/tui/src/plugin/adapters.tsx` | 修改 | `session.goal()` 访问器 |
| `packages/tui/src/feature-plugins/sidebar/goal.tsx` | 新建 | TUI 侧边栏面板 |
| `packages/tui/src/feature-plugins/builtins.ts` | 修改 | 注册 SidebarGoal |

---

### Task 1: Config schema — 新增 goal 配置字段

**Files:**
- Modify: `packages/core/src/v1/config/config.ts`

- [ ] **Step 1: 在 `Info` schema 末尾（`mode` 字段之前）新增 `goal` 字段**

在 `packages/core/src/v1/config/config.ts` 中，找到 `Info = Schema.Struct({` 定义（约 line 32），在 `mode` 字段（约 line 87）之前插入：

```ts
  goal: Schema.optional(
    Schema.Struct({
      judgeModel: Schema.optional(
        Schema.Struct({
          providerID: Schema.String.annotate({
            description: "Judge model provider, e.g. 'anthropic'",
          }),
          modelID: Schema.String.annotate({
            description: "Judge model ID, e.g. 'claude-haiku-4-20250414'",
          }),
        }),
      ).annotate({
        description:
          "Independent model for goal judgment. Falls back to session model if not set.",
      }),
      maxReact: Schema.optional(Schema.Number).annotate({
        description: "Max judge-driven re-entries before releasing (default: 12)",
      }),
    }),
  ).annotate({ description: "Goal stop-condition configuration" }),
```

- [ ] **Step 2: 验证类型检查通过**

Run: `cd packages/core && bun typecheck`
Expected: PASS（无新增错误）

- [ ] **Step 3: 提交**

```bash
git add packages/core/src/v1/config/config.ts
git commit -m "feat(goal): add goal config schema field"
```

---

### Task 2: Goal Service — 创建核心模块

**Files:**
- Create: `packages/opencode/src/session/goal.ts`

- [ ] **Step 1: 创建 `goal.ts`，写入完整 Service 实现**

创建文件 `packages/opencode/src/session/goal.ts`：

```ts
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionID } from "./schema"
import { Effect, Layer, Context, Schema } from "effect"
import { generateObject, streamObject, type ModelMessage } from "ai"
import z from "zod"
import { InstanceState } from "@/effect/instance-state"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import { Auth } from "@/auth"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { MessageV2 } from "./message-v2"
import type { ProviderV2, ModelV2 } from "@opencode-ai/core"

/**
 * Per-session stop-condition goal. `/goal`: once a goal is set, the main
 * runLoop refuses to stop until an independent judge model decides the
 * condition is satisfied (or genuinely impossible).
 *
 * State lives in InstanceState (per project instance), keyed by sessionID,
 * and is cleared on instance teardown.
 */

export type Goal = {
  condition: string
  /** Number of judge-driven re-entries so far; bounded by MAX_GOAL_REACT. */
  react: number
}

export const Verdict = z.object({
  ok: z.boolean(),
  impossible: z.boolean().optional(),
  reason: z.string(),
})
export type Verdict = z.infer<typeof Verdict>

const VerdictSchema = Schema.Struct({
  ok: Schema.Boolean,
  impossible: Schema.optional(Schema.Boolean),
  reason: Schema.String,
})

const LastVerdictSchema = Schema.Struct({
  ok: Schema.Boolean,
  impossible: Schema.optional(Schema.Boolean),
  reason: Schema.String,
  attempt: Schema.Number,
  messageID: Schema.optional(Schema.String),
  error: Schema.optional(Schema.Boolean),
})

/**
 * Broadcast whenever a session's goal changes — set, judged, or cleared.
 * `goal` undefined means there is no active goal (cleared / satisfied / impossible).
 */
export const Event = {
  Updated: EventV2.define({
    type: "session.goal",
    schema: {
      sessionID: SessionID,
      goal: Schema.optional(Schema.Struct({ condition: Schema.String })),
      lastVerdict: Schema.optional(LastVerdictSchema),
    },
  }),
}

// ---- Judge prompts ----

const JUDGE_SYSTEM = `You are evaluating a stop-condition hook. Read the conversation transcript carefully, then judge whether the user-provided condition is satisfied.

Your response must be a JSON object with one of these shapes:
- {"ok": true, "reason": "<quote evidence from the transcript that satisfies the condition>"}
- {"ok": false, "reason": "<quote what is missing or what blocks the condition>"}
- {"ok": false, "impossible": true, "reason": "<explain why the condition can never be satisfied>"}

Always include a "reason" field, quoting specific text from the transcript whenever possible. If the transcript does not contain clear evidence that the condition is satisfied, return {"ok": false, "reason": "insufficient evidence in transcript"}.

Only use {"ok": false, "impossible": true} when the condition is genuinely unachievable in this session — for example: the condition is self-contradictory, it depends on a resource or capability that is unavailable, or the assistant has explicitly tried, exhausted reasonable approaches, and stated it cannot be done. Apply your own judgment when deciding this — the assistant claiming the goal is impossible is evidence, not proof; independently confirm the condition is genuinely unachievable rather than deferring to the assistant's self-assessment. Do not use it just because the goal has not been reached yet or because progress is slow. When in doubt, return {"ok": false} without "impossible".`

const judgeUser = (condition: string) =>
  `Based on the conversation transcript above, has the following stopping condition been satisfied? Answer based on transcript evidence only.

Condition: ${condition}`

export interface Interface {
  readonly set: (sessionID: SessionID, condition: string) => Effect.Effect<void>
  readonly get: (sessionID: SessionID) => Effect.Effect<Goal | undefined>
  readonly clear: (sessionID: SessionID) => Effect.Effect<void>
  /** Increment the re-entry counter, returning the new count. */
  readonly bumpReact: (sessionID: SessionID) => Effect.Effect<number>
  /**
   * Run the judge over the conversation against the active goal's condition.
   * `msgs` is the main thread's message list; it is converted to native model
   * messages so the judge independently confirms the work rather than trusting
   * the assistant's self-report.
   */
  readonly evaluate: (input: {
    condition: string
    msgs: MessageV2.WithParts[]
    model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
  }) => Effect.Effect<Verdict>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionGoal") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    const events = yield* EventV2Bridge.Service

    const state = yield* InstanceState.make(() =>
      Effect.succeed({ goals: new Map<string, Goal>() }),
    )

    const set = Effect.fn("SessionGoal.set")(function* (sessionID: SessionID, condition: string) {
      const data = yield* InstanceState.get(state)
      data.goals.set(sessionID, { condition, react: 0 })
      yield* Effect.logInfo("goal set", { "session.id": sessionID, condition })
      yield* events.publish(Event.Updated, { sessionID, goal: { condition } })
    })

    const get = Effect.fn("SessionGoal.get")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      return data.goals.get(sessionID)
    })

    const clear = Effect.fn("SessionGoal.clear")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      data.goals.delete(sessionID)
      yield* Effect.logInfo("goal cleared", { "session.id": sessionID })
      yield* events.publish(Event.Updated, { sessionID, goal: undefined })
    })

    const bumpReact = Effect.fn("SessionGoal.bumpReact")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const goal = data.goals.get(sessionID)
      if (!goal) return 0
      goal.react += 1
      return goal.react
    })

    const evaluate = Effect.fn("SessionGoal.evaluate")(function* (input: {
      condition: string
      msgs: MessageV2.WithParts[]
      model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
    }) {
      const cfg = yield* config.get()
      const resolved = yield* provider.getModel(input.model.providerID, input.model.modelID)
      const language = yield* provider.getLanguage(resolved)

      const authInfo = yield* auth.get(input.model.providerID).pipe(Effect.orDie)
      const isOpenaiOauth = input.model.providerID === "openai" && authInfo?.type === "oauth"

      const conversation = yield* MessageV2.toModelMessagesEffect(input.msgs, resolved)

      yield* Effect.logDebug("goal judge transcript", {
        condition: input.condition,
        messageCount: conversation.length,
      })

      const messages: ModelMessage[] = [
        ...(isOpenaiOauth ? [] : [{ role: "system" as const, content: JUDGE_SYSTEM }]),
        ...conversation,
        { role: "user" as const, content: judgeUser(input.condition) },
      ]

      const params = {
        temperature: 0,
        messages,
        model: language,
        schema: Verdict,
      } satisfies Parameters<typeof generateObject>[0]

      if (isOpenaiOauth) {
        return yield* Effect.promise(async () => {
          const result = streamObject({
            ...params,
            providerOptions: ProviderTransform.providerOptions(resolved, {
              instructions: JUDGE_SYSTEM,
              store: false,
            }),
            onError: () => {},
          })
          for await (const part of result.fullStream) {
            if (part.type === "error") throw part.error
          }
          return Verdict.parse(await result.object)
        })
      }

      return yield* Effect.promise(() =>
        generateObject(params).then((r) => Verdict.parse(r.object)),
      )
    })

    return Service.of({ set, get, clear, bumpReact, evaluate })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
)

export const node = LayerNode.make(layer, [Provider.node, Auth.node, Config.node, EventV2Bridge.node])

export * as Goal from "./goal"
```

- [ ] **Step 2: 验证类型检查通过**

Run: `cd packages/opencode && bun typecheck 2>&1 | head -30`
Expected: 无 `goal.ts` 相关错误（可能有 `MessageV2.WithParts` 或 `ProviderV2`/`ModelV2` 导入路径需要修正——根据实际错误调整 import）

注意：如果 `import type { ProviderV2, ModelV2 } from "@opencode-ai/core"` 不对，改为：
```ts
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
```

- [ ] **Step 3: 提交**

```bash
git add packages/opencode/src/session/goal.ts
git commit -m "feat(goal): add Goal service with judge model evaluation"
```

---

### Task 3: Service 单元测试 — 状态机和事件

**Files:**
- Create: `packages/opencode/test/session/goal.test.ts`

- [ ] **Step 1: 创建测试文件，写状态机 + 事件测试**

创建文件 `packages/opencode/test/session/goal.test.ts`：

```ts
import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { Database } from "@opencode-ai/core/database/database"
import { Storage } from "@/storage/storage"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { Auth } from "@/auth"
import { Provider } from "@/provider/provider"
import { Goal } from "@/session/goal"
import type { SessionID } from "@/session/schema"
import { testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    Goal.layer.pipe(
      Layer.provide(EventV2Bridge.defaultLayer),
      Layer.provide(Config.defaultLayer),
      Layer.provide(Auth.defaultLayer),
      Layer.provide(Provider.defaultLayer),
    ),
    testInstanceStoreLayer,
  ),
)

describe("Goal.Service state machine", () => {
  it.instance("set creates goal with react=0", () =>
    Effect.gen(function* () {
      const goalSvc = yield* Goal.Service
      const sessionID = "test-session-1" as SessionID

      yield* goalSvc.set(sessionID, "all tests passing")
      const goal = yield* goalSvc.get(sessionID)

      expect(goal).toEqual({ condition: "all tests passing", react: 0 })
    }),
  )

  it.instance("clear removes goal", () =>
    Effect.gen(function* () {
      const goalSvc = yield* Goal.Service
      const sessionID = "test-session-2" as SessionID

      yield* goalSvc.set(sessionID, "some condition")
      yield* goalSvc.clear(sessionID)
      const goal = yield* goalSvc.get(sessionID)

      expect(goal).toBeUndefined()
    }),
  )

  it.instance("bumpReact increments counter", () =>
    Effect.gen(function* () {
      const goalSvc = yield* Goal.Service
      const sessionID = "test-session-3" as SessionID

      yield* goalSvc.set(sessionID, "some condition")
      const react1 = yield* goalSvc.bumpReact(sessionID)
      const react2 = yield* goalSvc.bumpReact(sessionID)

      expect(react1).toBe(1)
      expect(react2).toBe(2)
    }),
  )

  it.instance("set resets react to 0 on overwrite", () =>
    Effect.gen(function* () {
      const goalSvc = yield* Goal.Service
      const sessionID = "test-session-4" as SessionID

      yield* goalSvc.set(sessionID, "first condition")
      yield* goalSvc.bumpReact(sessionID)
      yield* goalSvc.bumpReact(sessionID)
      yield* goalSvc.set(sessionID, "second condition")
      const goal = yield* goalSvc.get(sessionID)

      expect(goal).toEqual({ condition: "second condition", react: 0 })
    }),
  )

  it.instance("bumpReact returns 0 when no goal", () =>
    Effect.gen(function* () {
      const goalSvc = yield* Goal.Service
      const sessionID = "test-session-5" as SessionID

      const react = yield* goalSvc.bumpReact(sessionID)
      expect(react).toBe(0)
    }),
  )
})

describe("Goal.Service events", () => {
  it.instance("set publishes session.goal event with condition", () =>
    Effect.gen(function* () {
      const goalSvc = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const sessionID = "test-session-ev-1" as SessionID
      const received = yield* Deferred.make<typeof Goal.Event.Updated.data.Type>()

      const unsub = yield* events.subscribe(Goal.Event.Updated)
      const fiber = yield* Effect.fork(Stream.runForEach(unsub, (data) =>
        Effect.gen(function* () {
          if ((data as any).goal?.condition === "event test condition") {
            yield* Deferred.doneUnsafe(received, Effect.succeed(data as any))
          }
        }),
      ))
      yield* Effect.addFinalizer(() => fiber.interrupt)

      yield* goalSvc.set(sessionID, "event test condition")
      const data = yield* Deferred.await(received).pipe(Effect.timeout("3 seconds"), Effect.flatten)

      expect(data.goal).toEqual({ condition: "event test condition" })
      expect(data.lastVerdict).toBeUndefined()
    }),
  )

  it.instance("clear publishes session.goal event with goal undefined", () =>
    Effect.gen(function* () {
      const goalSvc = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const sessionID = "test-session-ev-2" as SessionID
      const received = yield* Deferred.make<typeof Goal.Event.Updated.data.Type>()

      yield* goalSvc.set(sessionID, "will be cleared")

      const unsub = yield* events.subscribe(Goal.Event.Updated)
      const fiber = yield* Effect.fork(Stream.runForEach(unsub, (data) =>
        Effect.gen(function* () {
          if ((data as any).sessionID === sessionID && (data as any).goal === undefined) {
            yield* Deferred.doneUnsafe(received, Effect.succeed(data as any))
          }
        }),
      ))
      yield* Effect.addFinalizer(() => fiber.interrupt)

      yield* goalSvc.clear(sessionID)
      const data = yield* Deferred.await(received).pipe(Effect.timeout("3 seconds"), Effect.flatten)

      expect(data.goal).toBeUndefined()
    }),
  )
})
```

注意：如果 `events.subscribe` + `Stream.runForEach` 模式编译有问题，改用 `events.listen` 模式（参照 `test/session/session.test.ts:49-56`）：

```ts
const unsub = yield* events.listen((event) => {
  if (event.type === Goal.Event.Updated.type) {
    const data = event.data as typeof Goal.Event.Updated.data.Type
    if (data.goal?.condition === "event test condition") {
      Deferred.doneUnsafe(received, Effect.succeed(data))
    }
  }
  return Effect.void
})
yield* Effect.addFinalizer(() => unsub)
```

- [ ] **Step 2: 运行测试，确认全部通过**

Run: `cd packages/opencode && bun test test/session/goal.test.ts`
Expected: 7 passing

- [ ] **Step 3: 提交**

```bash
git add packages/opencode/test/session/goal.test.ts
git commit -m "test(goal): add state machine and event tests"
```

---

### Task 4: Command 常量 — 新增 GOAL

**Files:**
- Modify: `packages/opencode/src/command/index.ts:54-57`

- [ ] **Step 1: 在 `Default` 对象中添加 `GOAL`**

在 `packages/opencode/src/command/index.ts` 中，将 `Default` 对象（约 line 54-57）从：

```ts
export const Default = {
  INIT: "init",
  REVIEW: "review",
} as const
```

改为：

```ts
export const Default = {
  INIT: "init",
  REVIEW: "review",
  GOAL: "goal",
} as const
```

- [ ] **Step 2: 验证类型检查通过**

Run: `cd packages/opencode && bun typecheck 2>&1 | grep -i error | head -5`
Expected: 无新增错误

- [ ] **Step 3: 提交**

```bash
git add packages/opencode/src/command/index.ts
git commit -m "feat(goal): add GOAL command constant"
```

---

### Task 5: prompt.ts 集成 — /goal 命令处理

**Files:**
- Modify: `packages/opencode/src/session/prompt.ts`

- [ ] **Step 1: 在 prompt.ts 顶部添加 import**

在 `packages/opencode/src/session/prompt.ts` 的 import 区域（约 line 27 `import { Command }` 之后）添加：

```ts
import { Goal } from "./goal"
```

- [ ] **Step 2: 在 layer 函数体内获取 Goal.Service**

在 `Effect.gen(function* () {` 内的服务获取区域（约 line 124-127 附近，`const events = yield* EventV2Bridge.Service` 之后）添加：

```ts
    const goalSvc = yield* Goal.Service
```

- [ ] **Step 3: 在 `command` 函数开头添加 `/goal` 特殊处理**

在 `const command = Effect.fn("SessionPrompt.command")(function* (input: CommandInput) {` 内部（约 line 1417），在现有 `const cmd = yield* commands.get(input.command)` 之前插入：

```ts
      // /goal command: special handling, not a template command
      if (input.command === Command.Default.GOAL) {
        const condition = input.arguments.trim()
        if (!condition || condition === "clear" || condition === "reset") {
          yield* goalSvc.clear(input.sessionID)
          yield* Effect.logInfo("goal cleared via command", { "session.id": input.sessionID })
          // Return a synthetic message indicating goal was cleared
          const msg: SessionV1.Assistant = {
            id: MessageID.ascending(),
            parentID: undefined,
            role: "assistant",
            mode: input.agent ?? "build",
            agent: input.agent ?? "build",
            variant: undefined,
            path: { cwd: ctx.directory, root: ctx.worktree },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "",
            providerID: "",
            time: { created: Date.now(), completed: Date.now() },
            sessionID: input.sessionID,
            parts: [{ type: "text", text: "Goal cleared." }],
          }
          yield* sessions.updateMessage(msg)
          return { info: msg, parts: msg.parts }
        }
        yield* goalSvc.set(input.sessionID, condition)
        return yield* prompt({
          sessionID: input.sessionID,
          messageID: input.messageID,
          parts: [{ type: "text", text: condition }],
          agent: input.agent,
          model: input.model,
          variant: input.variant,
        })
      }
```

注意：`ctx` 变量需要在 `command` 函数内获取。如果 `ctx` 不在该作用域，使用 `yield* InstanceState.context` 获取。检查 `command` 函数上下文——可能需要：
```ts
        const ctx = yield* InstanceState.context
```
放在 `/goal` 处理块的开头。

- [ ] **Step 4: 验证类型检查通过**

Run: `cd packages/opencode && bun typecheck 2>&1 | grep -i error | head -10`
Expected: 无新增错误（可能需要微调 `SessionV1.Assistant` 的字段——参照 `prompt.ts:1239-1253` 现有 assistant message 创建模式）

- [ ] **Step 5: 提交**

```bash
git add packages/opencode/src/session/prompt.ts
git commit -m "feat(goal): add /goal command handling in prompt.ts"
```

---

### Task 6: prompt.ts 集成 — goalGate + runLoop 挂接

**Files:**
- Modify: `packages/opencode/src/session/prompt.ts`

- [ ] **Step 1: 添加 MAX_GOAL_REACT 常量**

在 `packages/opencode/src/session/prompt.ts` 的常量区域（约 line 78-84 附近）添加：

```ts
const MAX_GOAL_REACT = 12
```

- [ ] **Step 2: 在 runLoop 函数定义之前添加 goalGate 函数**

在 `const runLoop: ... = Effect.fn("SessionPrompt.run")(` 定义（约 line 1134）之前，插入 `goalGate` 函数。`goalGate` 需要 `config`、`events`、`sessions`、`goalSvc` 这些来自 layer scope 的变量，所以定义在 layer 函数体内：

```ts
    const goalGate = Effect.fn("SessionPrompt.goalGate")(function* (input: {
      sessionID: SessionID
      msgs: SessionV1.WithParts[]
      lastAssistantID: string
      model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
    }): Effect.Effect<boolean> {
      const goal = yield* goalSvc.get(input.sessionID)
      if (!goal) return true

      const cfg = yield* config.get()
      const maxReact = cfg.goal?.maxReact ?? MAX_GOAL_REACT

      let verdict: Goal.Verdict
      try {
        verdict = yield* goalSvc.evaluate({
          condition: goal.condition,
          msgs: input.msgs,
          model: cfg.goal?.judgeModel ?? input.model,
        })
      } catch (e) {
        yield* Effect.logWarning("goal judge error, failing open", { error: String(e) })
        const attempt = goal.react + 1
        yield* events.publish(Goal.Event.Updated, {
          sessionID: input.sessionID,
          goal: undefined,
          lastVerdict: { ok: false, reason: "judge error", attempt, error: true },
        })
        yield* goalSvc.clear(input.sessionID)
        return true
      }

      const attempt = goal.react + 1

      if (verdict.ok || verdict.impossible) {
        yield* events.publish(Goal.Event.Updated, {
          sessionID: input.sessionID,
          goal: undefined,
          lastVerdict: { ...verdict, attempt, messageID: input.lastAssistantID },
        })
        yield* goalSvc.clear(input.sessionID)
        return true
      }

      const react = yield* goalSvc.bumpReact(input.sessionID)
      if (react > maxReact) {
        yield* Effect.logWarning("goal react cap reached, releasing", {
          "session.id": input.sessionID,
          react,
        })
        yield* events.publish(Goal.Event.Updated, {
          sessionID: input.sessionID,
          goal: undefined,
          lastVerdict: { ...verdict, attempt, messageID: input.lastAssistantID },
        })
        yield* goalSvc.clear(input.sessionID)
        return true
      }

      yield* events.publish(Goal.Event.Updated, {
        sessionID: input.sessionID,
        goal: { condition: goal.condition },
        lastVerdict: { ...verdict, attempt, messageID: input.lastAssistantID },
      })

      // Inject synthetic user message with system-reminder
      const reminderMsg: SessionV1.User = {
        id: MessageID.ascending(),
        parentID: input.lastAssistantID,
        role: "user",
        mode: "build",
        agent: "build",
        path: { cwd: ctx.directory, root: ctx.worktree },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: input.model.modelID,
        providerID: input.model.providerID,
        time: { created: Date.now() },
        sessionID: input.sessionID,
      }
      yield* sessions.updateMessage(reminderMsg)
      yield* sessions.appendParts(reminderMsg.id, [
        {
          type: "text",
          text: [
            "<system-reminder>",
            `The goal is not yet satisfied: ${verdict.reason}`,
            "Keep working toward the goal.",
            "</system-reminder>",
          ].join("\n"),
          synthetic: true,
        } as SessionV1.TextPart,
      ])

      return false
    })
```

注意：`ctx` 需要在 goalGate 内获取。两种方式：
- 方式 A（如果 goalGate 在 runLoop 内部上下文中）：`const ctx = yield* InstanceState.context`
- 方式 B：goalGate 外层已有 ctx 变量

检查 `prompt.ts:1136` runLoop 内部确实有 `const ctx = yield* InstanceState.context`，但 goalGate 定义在 runLoop **之前**。所以需要在 goalGate 内部加：
```ts
      const ctx = yield* InstanceState.context
```

同时需要 import `ProviderV2` 和 `ModelV2`：在文件顶部 import 区添加：
```ts
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
```
（检查是否已导入——`prompt.ts:55` 已有 `import { ModelV2 } from "@opencode-ai/core/model"`，line 54 已有 `import { ProviderV2 } from "@opencode-ai/core/provider"`，所以不需要重复导入）

- [ ] **Step 3: 在 runLoop 的停止检查块中插入 goalGate 调用**

在 `prompt.ts` 的 runLoop 内（约 line 1164-1183），将现有的停止检查块：

```ts
          if (
            lastAssistant?.finish &&
            !["tool-calls"].includes(lastAssistant.finish) &&
            !hasToolCalls &&
            lastUser.id < lastAssistant.id
          ) {
            const orphan = lastAssistantMsg?.parts.find(
```

改为（在 `{` 和 `const orphan` 之间插入 goalGate）：

```ts
          if (
            lastAssistant?.finish &&
            !["tool-calls"].includes(lastAssistant.finish) &&
            !hasToolCalls &&
            lastUser.id < lastAssistant.id
          ) {
            // Goal gate: check if goal condition is satisfied before stopping
            const allowStop = yield* goalGate({
              sessionID,
              msgs,
              lastAssistantID: lastAssistant.id,
              model: { providerID: model.providerID, modelID: model.id },
            })
            if (!allowStop) continue

            const orphan = lastAssistantMsg?.parts.find(
```

注意：`model` 变量在 runLoop 中约 line 1194 `const model = yield* getModel(...)` 定义。但 goalGate 调用点在 line 1164，在 `model` 定义之前。解决方案：将 `model` 的获取提前到 goalGate 调用之前。即把 `const model = yield* getModel(...)` 移到 `step++` 之前（line 1185 之前），或者在 goalGate 调用时单独获取 model：

```ts
            // 需要在停止检查前获取 model
            const goalModel = yield* getModel(lastUser.model.providerID, lastUser.model.modelID, sessionID)
            const allowStop = yield* goalGate({
              sessionID,
              msgs,
              lastAssistantID: lastAssistant.id,
              model: { providerID: goalModel.providerID, modelID: goalModel.id },
            })
```

更简洁的方案：直接用 `lastUser.model`（已存在于消息中）：
```ts
            const allowStop = yield* goalGate({
              sessionID,
              msgs,
              lastAssistantID: lastAssistant.id,
              model: lastUser.model,
            })
```

检查 `lastUser` 是否有 `.model` 属性——参照 `prompt.ts:1189-1190`：`modelID: lastUser.model.modelID, providerID: lastUser.model.providerID`，确认 `lastUser.model` 存在且是 `{ providerID, modelID }` 结构。使用这个方案。

- [ ] **Step 4: 验证类型检查通过**

Run: `cd packages/opencode && bun typecheck 2>&1 | grep -i error | head -10`
Expected: 无新增错误

- [ ] **Step 5: 提交**

```bash
git add packages/opencode/src/session/prompt.ts
git commit -m "feat(goal): add goalGate stop-condition check in runLoop"
```

---

### Task 7: prompt.ts — Layer 装配（添加 Goal 依赖）

**Files:**
- Modify: `packages/opencode/src/session/prompt.ts:1549-1582, 1687-1714`

- [ ] **Step 1: 在 `defaultLayer` 中添加 Goal.defaultLayer**

在 `defaultLayer` 定义（约 line 1549-1582）中，在 `Layer.provide(Command.defaultLayer)` 之后添加：

```ts
    Layer.provide(Goal.defaultLayer),
```

完整位置（在 `Layer.provide(Command.defaultLayer)` 之后，`Layer.provide(Permission.defaultLayer)` 之前）。

- [ ] **Step 2: 在 `node` 导出中添加 Goal.node**

在 `node` 定义（约 line 1687-1714）的依赖数组中，在 `Command.node` 之后添加：

```ts
  Goal.node,
```

- [ ] **Step 3: 验证类型检查通过**

Run: `cd packages/opencode && bun typecheck 2>&1 | grep -i error | head -10`
Expected: 无新增错误

- [ ] **Step 4: 提交**

```bash
git add packages/opencode/src/session/prompt.ts
git commit -m "feat(goal): wire Goal service into prompt layer and node deps"
```

---

### Task 8: TUI 数据同步 — sync.tsx store + 事件处理

**Files:**
- Modify: `packages/tui/src/context/sync.tsx`

- [ ] **Step 1: 在 store 类型定义中添加 `goal` 字段**

在 `packages/tui/src/context/sync.tsx` 的 store 类型定义中（约 line 85-87 `todo` 字段之后），添加：

```ts
      goal: {
        [sessionID: string]: {
          condition?: string
          verdicts: {
            [messageID: string]: {
              ok: boolean
              impossible?: boolean
              reason: string
              attempt: number
              error?: boolean
            }
          }
          lastMessageID?: string
        }
      }
```

- [ ] **Step 2: 在 store 初始值中添加 `goal: {}`**

在 store 初始值中（约 line 122 `todo: {}` 之后），添加：

```ts
      goal: {},
```

- [ ] **Step 3: 在事件处理 switch 中添加 `session.goal` case**

在事件处理 switch 中（约 line 242-244 `case "todo.updated"` 之后），添加：

```tsx
        case "session.goal": {
          const { sessionID: sid, goal: goalData, lastVerdict } = event.properties
          setStore("goal", sid, (prev: any) => {
            const base = prev ?? { condition: undefined, verdicts: {}, lastMessageID: undefined }
            const verdicts = { ...base.verdicts }
            if (lastVerdict?.messageID) {
              verdicts[lastVerdict.messageID] = {
                ok: lastVerdict.ok,
                impossible: lastVerdict.impossible,
                reason: lastVerdict.reason,
                attempt: lastVerdict.attempt,
                error: lastVerdict.error,
              }
            }
            return {
              condition: goalData?.condition,
              verdicts,
              lastMessageID: lastVerdict?.messageID ?? base.lastMessageID,
            }
          })
          break
        }
```

- [ ] **Step 4: 验证类型检查通过**

Run: `cd packages/tui && bun typecheck 2>&1 | grep -i error | head -10`
Expected: 无新增错误

- [ ] **Step 5: 提交**

```bash
git add packages/tui/src/context/sync.tsx
git commit -m "feat(goal): add goal store and event handling in TUI sync"
```

---

### Task 9: TUI 访问器 — adapters.tsx

**Files:**
- Modify: `packages/tui/src/plugin/adapters.tsx:118-145`

- [ ] **Step 1: 在 `session` 对象中添加 `goal` 访问器**

在 `packages/tui/src/plugin/adapters.tsx` 的 `session:` 对象中（约 line 130-132 `todo` 之后），添加：

```tsx
      goal(sessionID) {
        return sync.data.goal[sessionID]
      },
```

- [ ] **Step 2: 验证类型检查通过**

Run: `cd packages/tui && bun typecheck 2>&1 | grep -i error | head -5`
Expected: 无新增错误

- [ ] **Step 3: 提交**

```bash
git add packages/tui/src/plugin/adapters.tsx
git commit -m "feat(goal): add session.goal() accessor in TUI adapters"
```

---

### Task 10: TUI 侧边栏面板 — goal.tsx

**Files:**
- Create: `packages/tui/src/feature-plugins/sidebar/goal.tsx`
- Modify: `packages/tui/src/feature-plugins/builtins.ts`

- [ ] **Step 1: 创建 `goal.tsx`**

创建文件 `packages/tui/src/feature-plugins/sidebar/goal.tsx`：

```tsx
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, Show } from "solid-js"

const id = "internal:sidebar-goal"

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const goal = createMemo(() => props.api.state.session.goal(props.session_id))
  const show = createMemo(() => !!goal()?.condition)

  const status = createMemo(() => {
    const g = goal()
    if (!g?.lastMessageID) return null
    const v = g.verdicts[g.lastMessageID]
    if (!v) return null
    if (v.ok) return { icon: "\u2713", text: "goal met", color: theme().primary }
    if (v.impossible) return { icon: "\u2298", text: "impossible", color: theme().text }
    if (v.error) return { icon: "!", text: "judge error", color: theme().text }
    return { icon: "\u27F3", text: `round ${v.attempt} \u00B7 not met`, color: theme().text }
  })

  return (
    <Show when={show()}>
      <box>
        <box flexDirection="row" gap={1}>
          <text fg={theme().primary}>
            <b>Goal</b>
          </text>
        </box>
        <box flexDirection="row" gap={1}>
          <text fg={theme().textDim}>{goal()!.condition}</text>
        </box>
        <Show when={status()}>
          <box flexDirection="row" gap={1}>
            <text fg={status()!.color}>{status()!.icon}</text>
            <text fg={theme().textDim}>{status()!.text}</text>
          </box>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 380,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = { id, tui }
export default plugin
```

- [ ] **Step 2: 在 `builtins.ts` 中注册 SidebarGoal**

修改 `packages/tui/src/feature-plugins/builtins.ts`。

在 import 区域（约 line 9 `import SidebarTodo` 之后）添加：

```tsx
import SidebarGoal from "./sidebar/goal"
```

在 `createBuiltinPlugins` 返回数组中（约 line 28 `SidebarTodo` 之后）添加：

```tsx
    SidebarGoal,
```

- [ ] **Step 3: 验证类型检查通过**

Run: `cd packages/tui && bun typecheck 2>&1 | grep -i error | head -10`
Expected: 无新增错误

- [ ] **Step 4: 提交**

```bash
git add packages/tui/src/feature-plugins/sidebar/goal.tsx packages/tui/src/feature-plugins/builtins.ts
git commit -m "feat(goal): add goal sidebar panel and register in builtins"
```

---

### Task 11: 全量类型检查和测试验证

- [ ] **Step 1: opencode 包类型检查**

Run: `cd packages/opencode && bun typecheck`
Expected: PASS（无 goal 相关错误）

- [ ] **Step 2: tui 包类型检查**

Run: `cd packages/tui && bun typecheck`
Expected: PASS（无 goal 相关错误）

- [ ] **Step 3: core 包类型检查**

Run: `cd packages/core && bun typecheck`
Expected: PASS

- [ ] **Step 4: 运行 goal 测试**

Run: `cd packages/opencode && bun test test/session/goal.test.ts`
Expected: 7 passing

- [ ] **Step 5: 运行现有 session 测试确保无回归**

Run: `cd packages/opencode && bun test test/session/`
Expected: 所有测试通过（包括现有 session.test.ts）

- [ ] **Step 6: 如果所有检查通过，创建一个验证提交**

```bash
git log --oneline -10
```

确认所有 Task 的提交都在 `feat/goal-stop-condition` 分支上。

---

## Self-Review 结果

### Spec 覆盖检查

| Spec 章节 | 对应 Task | 状态 |
|-----------|----------|------|
| Config 层 | Task 1 | ✓ |
| Service 层 (goal.ts) | Task 2 | ✓ |
| Service 测试 | Task 3 | ✓ |
| Command 常量 | Task 4 | ✓ |
| /goal 命令处理 | Task 5 | ✓ |
| goalGate 停止门控 | Task 6 | ✓ |
| Layer 装配 | Task 7 | ✓ |
| TUI 数据同步 | Task 8 | ✓ |
| TUI 访问器 | Task 9 | ✓ |
| TUI 侧边栏 | Task 10 | ✓ |
| 全量验证 | Task 11 | ✓ |

### 类型一致性检查

- `Goal.Service` tag: `@opencode/SessionGoal` — 一致
- `Event.Updated` type: `"session.goal"` — Service (Task 2) 和 TUI sync (Task 8) 一致
- `Verdict` 字段: `ok`, `impossible`, `reason` — Service 和 goalGate 一致
- `goal(sessionID)` 访问器 — adapters (Task 9) 和 sidebar (Task 10) 一致
- `lastUser.model` 结构 `{ providerID, modelID }` — 确认与 prompt.ts:1189 一致
