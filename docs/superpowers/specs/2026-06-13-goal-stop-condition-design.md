# Goal 停止条件功能 — 设计文档

**日期：** 2026-06-13
**分支：** `feat/goal-stop-condition`
**来源：** 从 MiMo-Code `packages/opencode/src/session/goal.ts` 迁移

## 概述

Goal 是一个 **per-session 的停止条件机制**。用户输入 `/goal <条件>` 后，主 agent 的 runLoop 在想要停止时，必须先经过一个**独立裁判模型**读取完整对话记录，判定条件是否满足（或确实不可能完成）才能退出。

状态为**纯内存**（InstanceState Map，按 sessionID 索引），实例销毁时清除。无数据库持久化——goal 是临时运行时条件，不是持久数据。

### 关键决策

| 决策项 | 选择 | 理由 |
|--------|------|------|
| 持久化 | 纯内存（InstanceState）| goal 是临时停止条件，session 结束即失效。无需 DB migration，风险最低。|
| 迁移范围 | 全功能 | Service + goalGate + /goal 命令 + TUI 侧边栏 + 测试。与 MiMo-Code 功能完全对等。|
| 裁判模型 | 可配置，未配置时 fallback 到 session 当前模型 | config 中新增 `goal.judgeModel`；不配置则用 session 当前模型。|
| 最大重入次数 | 通过 `goal.maxReact` 配置，默认 12 | 安全阀，防止不可满足的条件无限消耗 token。|

## 架构

```
┌─ Config 层 ─────────── core/v1/config: 新增 goal.judgeModel + goal.maxReact 可选字段
│
├─ Service 层 ────────── session/goal.ts: InstanceState Map + evaluate(裁判调用)
│                         (移植 MiMo-Code goal.ts，适配 EventV2 + Provider/Auth API)
│
├─ 命令层 ────────────── command/index.ts: 新增 /goal 命令常量
│                         prompt.ts: /goal 命令处理 + goalGate 停止门控
│
├─ 事件层 ────────────── EventV2 "session.goal" 瞬时事件（不持久化）
│
├─ TUI 数据层 ────────── sync.tsx: store + 事件消费
│                         adapters.tsx: session.goal() 访问器
│
└─ TUI 展示层 ────────── sidebar/goal.tsx: 侧边栏面板
                          builtins.ts: 注册插件
```

## 文件变更清单

### 新建文件

| 文件 | 预估行数 | 说明 |
|------|----------|------|
| `packages/opencode/src/session/goal.ts` | ~200 | 核心 Service：InstanceState Map + set/get/clear/bumpReact/evaluate |
| `packages/tui/src/feature-plugins/sidebar/goal.tsx` | ~60 | TUI 侧边栏面板 |
| `packages/opencode/test/session/goal.test.ts` | ~200 | 单元测试 |

### 修改文件

| 文件 | 变更内容 |
|------|----------|
| `packages/opencode/src/session/prompt.ts` | goalGate 函数（~100 行）+ runLoop 集成 + /goal 命令处理（~20 行）|
| `packages/opencode/src/command/index.ts` | 新增 `Default.GOAL` 常量 |
| `packages/core/src/v1/config/config.ts` | `Info` schema 新增 `goal` 可选字段 |
| `packages/tui/src/context/sync.tsx` | store 类型 + 初始值 + 新增事件处理 case |
| `packages/tui/src/plugin/adapters.tsx` | 新增 `goal(sessionID)` 访问器 |
| `packages/tui/src/feature-plugins/builtins.ts` | 导入并注册 `SidebarGoal` |

---

## 1. Service 层（`session/goal.ts`）

### 数据结构

```ts
// 运行时状态（纯内存，InstanceState Map）
export type Goal = {
  condition: string
  react: number  // 裁判驱动的重入次数，上限 MAX_GOAL_REACT
}

// 裁判判定结果（zod，AI SDK generateObject 要求 zod）
export const Verdict = z.object({
  ok: z.boolean(),
  impossible: z.boolean().optional(),
  reason: z.string(),
})
```

### 事件定义

使用 forked opencode 的 **EventV2**（不是 MiMo-Code 的 BusEvent）。瞬时事件，不持久化：

```ts
export const Event = {
  Updated: EventV2.define({
    type: "session.goal",
    schema: {
      sessionID: SessionID,
      goal: Schema.Struct({ condition: Schema.String }).optional(),  // undefined = 无活跃 goal
      lastVerdict: Schema.Struct({
        ok: Schema.Boolean,
        impossible: Schema.Boolean.optional(),
        reason: Schema.String,
        attempt: Schema.Number,
        messageID: Schema.String.optional(),  // 锚定到被评判的那一轮 assistant 消息
        error: Schema.Boolean.optional(),
      }).optional(),
    },
  }),
}
```

### Service 接口

```ts
export interface Interface {
  readonly set: (sessionID: SessionID, condition: string) => Effect.Effect<void>
  readonly get: (sessionID: SessionID) => Effect.Effect<Goal | undefined>
  readonly clear: (sessionID: SessionID) => Effect.Effect<void>
  readonly bumpReact: (sessionID: SessionID) => Effect.Effect<number>
  readonly evaluate: (input: {
    condition: string
    msgs: SessionV1.WithParts[]
    model: { providerID: ProviderID; modelID: ModelID }
  }) => Effect.Effect<Verdict>
}
```

### Service 实现

```ts
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionGoal") {}

export const layer = Layer.effect(Service, Effect.gen(function* () {
  const provider = yield* Provider.Service
  const auth = yield* Auth.Service
  const config = yield* Config.Service
  const events = yield* EventV2Bridge.Service

  const state = yield* InstanceState.make(() =>
    Effect.succeed({ goals: new Map<string, Goal>() })
  )

  const set = Effect.fn("SessionGoal.set")(function* (sessionID, condition) {
    const data = yield* InstanceState.get(state)
    data.goals.set(sessionID, { condition, react: 0 })
    yield* events.publish(Event.Updated, { sessionID, goal: { condition } })
  })

  const get = Effect.fn("SessionGoal.get")(function* (sessionID) {
    const data = yield* InstanceState.get(state)
    return data.goals.get(sessionID)
  })

  const clear = Effect.fn("SessionGoal.clear")(function* (sessionID) {
    const data = yield* InstanceState.get(state)
    data.goals.delete(sessionID)
    yield* events.publish(Event.Updated, { sessionID, goal: undefined })
  })

  const bumpReact = Effect.fn("SessionGoal.bumpReact")(function* (sessionID) {
    const data = yield* InstanceState.get(state)
    const goal = data.goals.get(sessionID)
    if (!goal) return 0
    goal.react += 1
    return goal.react
  })

  const evaluate = Effect.fn("SessionGoal.evaluate")(function* (input) {
    const cfg = yield* config.get()
    const resolved = yield* provider.getModel(input.model.providerID, input.model.modelID)
    const language = yield* provider.getLanguage(resolved)
    const authInfo = yield* auth.get(input.model.providerID).pipe(Effect.orDie)

    const isOpenaiOauth = input.model.providerID === "openai" && authInfo?.type === "oauth"

    // 将对话转换为模型消息（保留 tool calls/results/images）
    const conversation = yield* MessageV2.toModelMessagesEffect(input.msgs, resolved)

    const messages = [
      ...(isOpenaiOauth ? [] : [{ role: "system", content: JUDGE_SYSTEM } satisfies ModelMessage]),
      ...conversation,
      { role: "user", content: judgeUser(input.condition) } satisfies ModelMessage,
    ]

    const params = {
      temperature: 0,
      messages,
      model: language,
      schema: Verdict,
    } satisfies Parameters<typeof generateObject>[0]

    if (isOpenaiOauth) {
      // OpenAI OAuth 路径：用 streamObject（system prompt 通过 providerOptions 传入）
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
      generateObject(params).then((r) => Verdict.parse(r.object))
    )
  })

  return Service.of({ set, get, clear, bumpReact, evaluate })
}))

export const defaultLayer = layer.pipe(
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
)

export const node = LayerNode.make(layer, [
  Provider.node, Auth.node, Config.node, EventV2Bridge.node,
])

export * as Goal from "./goal"
```

### 裁判 Prompt

直接复用 MiMo-Code 的验证逻辑（严格证据判定，不改动）：

**`JUDGE_SYSTEM`：**

```
You are evaluating a stop-condition hook. Read the conversation transcript carefully, then judge whether the user-provided condition is satisfied.

Your response must be a JSON object with one of these shapes:
- {"ok": true, "reason": "<quote evidence from the transcript that satisfies the condition>"}
- {"ok": false, "reason": "<quote what is missing or what blocks the condition>"}
- {"ok": false, "impossible": true, "reason": "<explain why the condition can never be satisfied>"}

Always include a "reason" field, quoting specific text from the transcript whenever possible. If the transcript does not contain clear evidence that the condition is satisfied, return {"ok": false, "reason": "insufficient evidence in transcript"}.

Only use {"ok": false, "impossible": true} when the condition is genuinely unachievable in this session — for example: the condition is self-contradictory, it depends on a resource or capability that is unavailable, or the assistant has explicitly tried, exhausted reasonable approaches, and stated it cannot be done. Apply your own judgment when deciding this — the assistant claiming the goal is impossible is evidence, not proof; independently confirm the condition is genuinely unachievable rather than deferring to the assistant's self-assessment. Do not use it just because the goal has not been reached yet or because progress is slow. When in doubt, return {"ok": false} without "impossible".
```

**`judgeUser(condition)`：**

```
Based on the conversation transcript above, has the following stopping condition been satisfied? Answer based on transcript evidence only.

Condition: ${condition}
```

### 与 MiMo-Code 的差异点

| MiMo-Code | forked opencode | 变化 |
|-----------|----------------|------|
| `BusEvent.define` | `EventV2.define` | 事件 API 适配 |
| `Bus.Service` | `EventV2Bridge.Service` | 事件 service 适配 |
| `EffectLogger.create` | `Effect.logInfo` / `Effect.logDebug` | 用 Effect 内置日志 |
| `Bus.layer` | `EventV2Bridge.defaultLayer` | layer 依赖替换 |

---

## 2. goalGate — runLoop 停止门控

### 挂接点

forked opencode 的 runLoop 在 `prompt.ts:1164-1183` 检查停止条件。goalGate 需要在 agent **即将 break 退出循环**时拦截：

```
runLoop 循环体:
  ...
  if (停止条件满足) {     ← prompt.ts:1164
    ┌─ goalGate 插入点 ──────────────────────────────┐
    │ 1. 无活跃 goal? → 放行 break                     │
    │ 2. 调裁判 evaluate(transcript, condition)        │
    │ 3. ok 或 impossible? → 清除 goal，放行 break      │
    │ 4. react > MAX_GOAL_REACT? → 清除 goal，放行     │
    │ 5. 未满足 → 注入 system-reminder，continue       │
    └─────────────────────────────────────────────────┘
    break
  }
```

### goalGate 实现

```ts
const MAX_GOAL_REACT = 12  // 默认值，可通过 config.goal.maxReact 覆盖

const goalGate = Effect.fn("SessionPrompt.goalGate")(function* (input: {
  sessionID: SessionID
  msgs: SessionV1.WithParts[]
  lastAssistantID: string
  model: { providerID: ProviderID; modelID: ModelID }
}): Effect.Effect<boolean> {  // true = 放行停止, false = 继续循环
  const goalSvc = yield* Goal.Service
  const goal = yield* goalSvc.get(input.sessionID)
  if (!goal) return true  // 无活跃 goal，直接放行

  const cfg = yield* config.get()
  const maxReact = cfg.goal?.maxReact ?? MAX_GOAL_REACT

  // 调裁判
  let verdict: Verdict
  try {
    verdict = yield* goalSvc.evaluate({
      condition: goal.condition,
      msgs: input.msgs,
      model: cfg.goal?.judgeModel ?? input.model,  // 可配置裁判模型
    })
  } catch (e) {
    // fail-open：裁判出错不卡死用户
    yield* Effect.logWarning("goal judge error, failing open", { error: String(e) })
    yield* goalSvc.clear(input.sessionID)
    yield* events.publish(Goal.Event.Updated, {
      sessionID: input.sessionID,
      goal: undefined,
      lastVerdict: {
        ok: false, reason: "judge error", attempt: goal.react + 1, error: true,
      },
    })
    return true
  }

  const attempt = goal.react + 1

  // 条件满足 或 确认不可能
  if (verdict.ok || verdict.impossible) {
    yield* events.publish(Goal.Event.Updated, {
      sessionID: input.sessionID,
      goal: undefined,
      lastVerdict: { ...verdict, attempt, messageID: input.lastAssistantID },
    })
    yield* goalSvc.clear(input.sessionID)
    return true
  }

  // 超出重试上限
  const react = yield* goalSvc.bumpReact(input.sessionID)
  if (react > maxReact) {
    yield* Effect.logWarning("goal react cap reached, releasing", {
      "session.id": input.sessionID, react,
    })
    yield* events.publish(Goal.Event.Updated, {
      sessionID: input.sessionID,
      goal: undefined,
      lastVerdict: { ...verdict, attempt, messageID: input.lastAssistantID },
    })
    yield* goalSvc.clear(input.sessionID)
    return true
  }

  // 未满足：发布 verdict + 注入 system-reminder，强制继续
  yield* events.publish(Goal.Event.Updated, {
    sessionID: input.sessionID,
    goal: { condition: goal.condition },
    lastVerdict: { ...verdict, attempt, messageID: input.lastAssistantID },
  })

  // 注入 synthetic user 消息，包含 system-reminder
  const reminderMessage: SessionV1.User = {
    id: MessageID.ascending(),
    parentID: input.lastAssistantID,
    role: "user",
    parts: [{
      type: "text",
      text: [
        "<system-reminder>",
        `The goal is not yet satisfied: ${verdict.reason}`,
        "Keep working toward the goal.",
        "</system-reminder>",
      ].join("\n"),
      synthetic: true,
    }],
    // ... session schema 要求的其他必填字段
  }
  yield* sessions.appendParts(input.lastAssistantID, reminderMessage.parts)
  // （具体持久化机制遵循 runLoop 中已有的 synthetic message 模式）

  return false  // 继续循环
})
```

### runLoop 集成

在 `prompt.ts:1164` 的停止检查块内部，`break` 之前插入：

```ts
if (
  lastAssistant?.finish &&
  !["tool-calls"].includes(lastAssistant.finish) &&
  !hasToolCalls &&
  lastUser.id < lastAssistant.id
) {
  // ★ goalGate 拦截
  const allowStop = yield* goalGate({
    sessionID,
    msgs,
    lastAssistantID: lastAssistant.id,
    model: { providerID: model.providerID, modelID: model.id },
  })
  if (!allowStop) continue  // 裁判判定未满足，继续循环

  // 现有代码：orphan 检查 + 日志 + break
  ...
  break
}
```

**作用范围：** goalGate 只对主 agent 生效。subtask 有独立的 runLoop，不经过此检查点——与 MiMo-Code 一致。

**与 MiMo-Code 的差异：** MiMo-Code 有两个 goalGate 调用点；forked opencode 只需一个，因为其 runLoop 结构更简洁——`prompt.ts:1164` 是唯一的主退出点。

---

## 3. 命令注册

### `/goal` 命令

`/goal` **不**注册到 commands map 中（不走模板系统），而是在 `prompt.ts` 的 `command` 函数里特殊拦截，与 MiMo-Code 做法一致。因为 `/goal` 的行为是设置运行时状态，不是发送 prompt 给 LLM。

**command/index.ts：**

```ts
export const Default = {
  INIT: "init",
  REVIEW: "review",
  GOAL: "goal",  // 新增
} as const
```

**prompt.ts command 函数处理：**

```ts
if (name === Command.Default.GOAL) {
  const goalSvc = yield* Goal.Service
  const condition = args.trim()

  // /goal clear | /goal reset | /goal（空参数）
  if (!condition || condition === "clear" || condition === "reset") {
    yield* goalSvc.clear(input.sessionID)
    // 返回 synthetic reply: "Goal cleared."
    return /* ... */
  }

  // /goal <condition>
  yield* goalSvc.set(input.sessionID, condition)
  // condition 文本作为本轮 prompt，驱动 agent 立即开始工作
  return yield* prompt({
    sessionID: input.sessionID,
    parts: [{ type: "text", text: condition }],
    agent: input.agent,
    model: input.model,
  })
}
```

---

## 4. 配置

在 `core/v1/config/config.ts` 的 `Info` schema 中新增可选 `goal` 字段：

```ts
goal: Schema.optional(
  Schema.Struct({
    judgeModel: Schema.optional(
      Schema.Struct({
        providerID: Schema.String.annotate({
          description: "裁判模型 provider，例如 'anthropic'",
        }),
        modelID: Schema.String.annotate({
          description: "裁判模型 ID，例如 'claude-haiku-4-20250414'",
        }),
      })
    ).annotate({
      description: "独立的裁判模型。未配置时 fallback 到 session 当前模型。",
    }),
    maxReact: Schema.optional(Schema.Number).annotate({
      description: "裁判驱动的最大重入次数，超过后强制放行（默认: 12）",
    }),
  })
).annotate({ description: "Goal 停止条件配置" }),
```

**用户配置示例（`opencode.json`）：**

```json
{
  "goal": {
    "judgeModel": {
      "providerID": "anthropic",
      "modelID": "claude-haiku-4-20250414"
    },
    "maxReact": 15
  }
}
```

**裁判模型解析逻辑：** `cfg.goal?.judgeModel ?? sessionModel` — 未配置时使用 session 当前模型。

---

## 5. TUI 展示层

### 数据同步（`sync.tsx`）

**store 新增 `goal` 字段类型：**

```ts
goal: {
  [sessionID: string]: {
    condition?: string
    verdicts: { [messageID: string]: GoalVerdict }
    lastMessageID?: string
  }
}
```

**初始值：** `goal: {}`

**事件处理（event switch 新增 case）：**

```tsx
case "session.goal": {
  const { sessionID, goal, lastVerdict } = event.properties
  setStore("goal", sessionID, (prev) => {
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
      condition: goal?.condition,
      verdicts,
      lastMessageID: lastVerdict?.messageID ?? base.lastMessageID,
    }
  })
  break
}
```

**设计说明：** `goal: undefined` 表示 goal 已清除（满足/不可能/手动清除），但**保留累积的 verdict 历史**，方便用户追溯每轮判定记录。

### 访问器（`adapters.tsx`）

```tsx
session: {
  // ... 现有方法 ...
  goal(sessionID) {
    return sync.data.goal[sessionID]
  },
}
```

### 侧边栏面板（新建 `sidebar/goal.tsx`）

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
          <text fg={theme().primary}><b>Goal</b></text>
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
    order: 380,  // 在 LSP(350) 和 Todo(400) 之间
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

### 插件注册（`builtins.ts`）

```tsx
import SidebarGoal from "./sidebar/goal"

// createBuiltinPlugins 返回数组中，SidebarLsp 之后加入：
SidebarGoal,
```

### 展示效果

```
┌─────────────────────────┐
│ LSP                     │
│   ✓ typescript          │
│                         │
│ Goal                    │  ← 新增
│   All tests passing     │
│   ⟳ round 2 · not met   │
│                         │
│ Todo                    │
│   ▸ fix auth flow       │
└─────────────────────────┘
```

verdict 图标含义：
- `✓` — 条件已满足，goal 已清除
- `⊘` — 条件确认不可能完成，goal 已清除
- `⟳` — 第 N 轮，条件尚未满足，agent 继续工作
- `!` — 裁判调用出错，fail-open 放行

---

## 6. 测试策略

**文件：** `packages/opencode/test/session/goal.test.ts`
**框架：** Bun Test + Effect，使用 `testEffect` + `it.instance`

### 测试覆盖范围

**1. Service 状态机测试（纯内存逻辑）**

| 测试用例 | 说明 |
|----------|------|
| `set creates goal with react=0` | set → get 返回 `{ condition, react: 0 }` |
| `clear removes goal` | clear → get 返回 undefined |
| `bumpReact increments counter` | bumpReact 递增 react，返回新值 |
| `set resets react to 0 on overwrite` | 对已存在的 goal 调用 set 会重置 react |
| `bumpReact returns 0 when no goal` | 无 goal 时 bumpReact 返回 0 |
| `set publishes session.goal event` | set 发布 Event.Updated，goal 有值 |
| `clear publishes goal:undefined event` | clear 发布 Event.Updated，goal 为 undefined |

**2. goalGate 门控逻辑测试**

| 测试用例 | 说明 |
|----------|------|
| `passes through when no goal` | 无 goal → 返回 true（放行停止）|
| `releases when judge returns ok` | verdict.ok=true → 清除 goal，返回 true |
| `releases when judge returns impossible` | verdict.impossible=true → 清除 goal，返回 true |
| `re-enters loop when judge returns not-ok` | verdict.ok=false → 注入 reminder，返回 false |
| `releases after react cap` | react > maxReact → 清除 goal，返回 true |
| `fails open on judge error` | evaluate 抛错 → 清除 goal，返回 true |

**3. /goal 命令测试**

| 测试用例 | 说明 |
|----------|------|
| `sets goal and prompts with condition` | `/goal X` → goal.set + 用 "X" 作为 prompt |
| `clear clears goal` | `/goal clear` → goal.clear |
| `reset clears goal` | `/goal reset` → goal.clear |
| `empty goal clears goal` | `/goal`（空）→ goal.clear |

### Mock 策略

裁判模型**必须** mock，避免真实 LLM 调用。推荐方案：

**在 test layer 中覆盖 `Goal.Service`**，将 `evaluate` 替换为返回固定 `Verdict` 的实现。这样可以隔离测试 goalGate 的门控逻辑（条件判断、react 计数、事件发布），这是测试重点。

```ts
const mockGoalLayer = Layer.succeed(Goal.Service, Goal.Service.of({
  set: /* 透传到真实 InstanceState */,
  get: /* 透传 */,
  clear: /* 透传 */,
  bumpReact: /* 透传 */,
  evaluate: () => Effect.succeed({ ok: true, reason: "mock" }),  // 固定 verdict
}))
```

---

## 实施顺序

1. **Config** — `Info` schema 新增 `goal` 字段（`core/v1/config/config.ts`）
2. **Service** — 创建 `session/goal.ts`（5 个方法 + layer 导出）
3. **Command** — 新增 `Default.GOAL` 常量（`command/index.ts`）
4. **prompt.ts** — `/goal` 命令处理 + goalGate + runLoop 集成
5. **Layer 装配** — `Goal` 加入 `prompt.ts` 的 defaultLayer 和 node 依赖
6. **TUI 同步** — store 字段 + 事件处理（`sync.tsx`）
7. **TUI 访问器** — `session.goal()`（`adapters.tsx`）
8. **TUI 侧边栏** — 创建 `sidebar/goal.tsx` + 注册到 `builtins.ts`
9. **测试** — `test/session/goal.test.ts`
10. **类型检查** — 从 `packages/opencode` 和 `packages/tui` 执行 `bun typecheck`

## 风险评估

| 风险 | 缓解措施 |
|------|----------|
| `prompt.ts` 文件大（1716 行），编辑可能破坏现有流程 | goalGate 是自包含函数；集成只需一个 `if` + `continue`，表面积最小 |
| 裁判模型给每次停止判定增加延迟 | 裁判只在有活跃 goal 时运行。未运行 `/goal` 则零开销 |
| 裁判 API 出错可能困住 agent | 所有裁判错误 fail-open 放行。加上 react 上限（12）作为硬安全阀 |
| InstanceState Map 随 session 数增长 | `clear()` 和实例销毁时清除 entry。受活跃 session 数量约束 |
