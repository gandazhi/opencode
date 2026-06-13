# Dynamic Workflow 迁移设计

> 将 MiMo-Code 的 Dynamic Workflow 功能迁移到 fork 的 opencode 仓库。

## 背景

**源仓库**：`/Users/gandazhi/code/agent/MiMo-Code`（`packages/opencode/src/workflow/`）
**目标仓库**：`/Users/gandazhi/code/agent/opencode`（`packages/opencode/src/workflow/`）

Dynamic Workflow 是一个确定性的多智能体编排引擎。编排逻辑由一段 JavaScript 脚本描述，在隔离的 QuickJS 沙箱中执行，通过 host 注入的原语（`agent()` / `parallel()` / `pipeline()` / `workflow()`）fan-out 子智能体。脚本支持 journal 持久化和 resume。

## 迁移策略

**策略 A：适配 Task 模型**——重写 runtime.ts 的 spawn 逻辑，改用目标库的 Session+Task 机制（`sessions.create` + `prompts.prompt`）来派生子智能体。不引入 Actor 层。

**架构方案 2：原生重写 spawn 函数**——不创建 spawnRef 仿真层，直接在 `spawnShared` 函数体里调用目标库原生 API。

### 功能范围

| 功能 | 首版 | 后续 |
|------|------|------|
| sandbox 执行 + meta 解析 | ✅ | — |
| agent() / parallel() / pipeline() DSL | ✅ | — |
| journal 持久化 + resume | ✅ | — |
| 嵌套子工作流 workflow() | ✅ | — |
| deep-research 内置工作流 + /deep-research 命令 | ✅ | — |
| TUI /workflows 对话框 | ✅ | — |
| HTTP API (list/resume) | ✅ | — |
| worktree 隔离 (isolation:"worktree") | ❌ | ✅ |
| model tier ref 解析 ("lite" 等) | ❌ | ✅ |

### 通知机制

- **EventV2 事件**：workflow.started/phase/log/finished → TUI 实时监控
- **HTTP API**：GET /workflows → TUI 列表/轮询
- **合成消息注入**：workflow 完成后注入到父 session → 父 session 的 LLM 下一轮看到结果

## 架构

### 文件布局

全部放在 `packages/opencode/src/workflow/`，遵循目标库的 `AGENTS.md` 规范（flat exports + `export * as Foo from "./foo"` self-reexport）。

```
packages/opencode/src/workflow/
├── runtime.ts          ← 核心引擎（重写 spawn，其余逻辑保留）
├── sandbox.ts          ← QuickJS 沙箱（直接移植，零改动）
├── meta.ts             ← meta 解析器（直接移植，零改动）
├── persistence.ts      ← DB + journal（适配 Database.Service）
├── events.ts           ← EventV2 事件定义（从 BusEvent 改为 EventV2）
├── builtin.ts          ← 内置工作流注册（直接移植）
├── builtin/
│   └── deep-research.js ← deep-research 脚本（直接移植）
├── resolve.ts          ← 名字→脚本解析（适配路径 .opencode/workflows/）
├── workspace.ts        ← 文件 jail（适配 Glob/Filesystem 工具路径）
├── workflow.sql.ts     ← Drizzle 表定义（适配 core 包 schema 模式）
└── runtime-ref.ts      ← 晚绑定引用（直接移植）
```

### 消费者文件（workflow/ 目录外）

```
packages/opencode/src/
├── tool/
│   ├── workflow.ts       ← workflow 工具定义（适配 Tool.define 模式）
│   ├── workflow.txt      ← 工具描述（直接移植）
│   └── registry.ts       ← 注册 workflow 工具（加 flag 门控）
├── server/routes/instance/httpapi/groups/
│   └── workflow.ts       ← HTTP API 路由（适配路由组模式）
├── effect/
│   ├── app-runtime.ts    ← 接入 WorkflowRuntime.defaultLayer
│   └── runtime-flags.ts  ← 加 experimentalDynamicWorkflow flag
├── config/config.ts      ← 加 workflow 配置段
├── command/index.ts      ← 加 /deep-research 命令
└── id/id.ts              ← 加 "workflow" 前缀

packages/core/src/
└── (migration 放这里，遵循 core 包模式)

packages/tui/src/
├── context/sync.tsx              ← 加 workflow 状态同步
├── component/dialog-workflows.tsx ← /workflows 对话框
└── app.tsx                       ← 注册 /workflows 命令
```

### 依赖方向

```
                    ┌──────────────────────────────────┐
                    │  src/workflow/ (自包含核心)        │
                    │                                   │
                    │  sandbox.ts ← quickjs-emscripten  │
                    │  meta.ts   ← 纯函数，零依赖        │
                    │  runtime.ts ──► Session+Task API  │ ← 唯一重写点
                    │              ► Database.Service   │
                    │              ► EventV2            │
                    │              ► Provider           │
                    │              ► EffectBridge       │
                    └──────────┬────────────────────────┘
                               │
        ┌──────────────────────┼────────────────────────┐
        ▼                      ▼                        ▼
  tool/workflow.ts     server/.../workflow.ts     app-runtime.ts
  tool/registry.ts     (workflowRef)              (defaultLayer)
```

核心通过两个窄接口被外部消费：`workflowRef`（晚绑定引用）和 `WorkflowRuntime.defaultLayer`（layer 接入）。

### 三类文件的迁移策略

| 类别 | 文件 | 策略 |
|------|------|------|
| **直接移植** | sandbox.ts, meta.ts, builtin.ts, resolve.ts, runtime-ref.ts, deep-research.js | 改 import 路径，逻辑不动 |
| **适配移植** | persistence.ts, events.ts, workspace.ts, workflow.sql.ts | 换 API 调用，结构保留 |
| **重写** | runtime.ts 的 spawn 函数 | `spawnShared` 改用 Session+Task API；其余 1000+ 行保留 |

## Spawn 重写（核心改动）

### 目标库的子智能体派生机制

目标库通过 Session + SessionPrompt API 派生子智能体：

1. `sessions.create({ parentID, agent, permission })` — 创建子 session
2. `prompts.prompt({ sessionID, model, parts, format })` — 运行 prompt，返回最终 assistant 消息
3. `msg.info.structured` — 提取结构化输出
4. `msg.parts.findLast(p => p.type === "text")?.text` — 提取文本输出

### spawnShared 重写

> 注：`awaitWithTimeout`、`publishAgentFailed`、`reason` 变量追踪、`scheduleFlush`、`entry` 计数器等均来自原始 runtime.ts 的 1000+ 行保留部分，此处只展示 spawn 函数体的改动。

```ts
const spawnShared = async (prompt, opts, resolvedModel) => {
  entry.running++
  scheduleFlush(entry)

  const value = await bridge.promise(
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const prompts = yield* SessionPrompt.Service
      const agents = yield* Agent.Service

      const subagent = yield* agents.get(opts.agentType ?? "general")
      const parent = yield* sessions.get(input.sessionID)
      const permission = deriveSubagentSessionPermission({
        parentSessionPermission: parent.permission ?? [],
        subagent,
      })

      const child = yield* sessions.create({
        parentID: input.sessionID,
        title: opts.label ?? "workflow agent",
        agent: subagent.name,
        permission,
      })

      const parts = yield* prompts.resolvePromptParts(prompt)

      const result = yield* awaitWithTimeout(
        child.id, opts,
        prompts.prompt({
          sessionID: child.id,
          agent: subagent.name,
          model: resolvedModel,
          parts,
          ...(opts.schema
            ? { format: { type: "json_schema" as const, schema: opts.schema } }
            : {}),
        }).pipe(
          Effect.map((msg) => {
            if (opts.schema) return msg.info.structured ?? null
            return msg.parts.findLast(p => p.type === "text")?.text ?? null
          }),
          Effect.catchCause(() => Effect.succeed(null)),
        ),
      )
      return result
    }),
  ).catch(() => null)

  entry.running--
  if (value !== null) entry.succeeded++
  else { entry.failed++; publishAgentFailed(opts, reason) }
  scheduleFlush(entry)
  return value
}
```

### 映射表

| MiMo-Code | 目标库 | 说明 |
|-----------|--------|------|
| `actor.spawn({ mode: "subagent" })` | `sessions.create({ parentID }) + prompts.prompt(...)` | 核心替换 |
| `spawned.outcome` (Deferred) | `prompts.prompt(...)` 返回值 | 直接 await |
| `outcome.structured` | `msg.info.structured` | 结构化输出 |
| `outcome.finalText` | `msg.parts.findLast(p => p.type === "text")?.text` | 文本输出 |
| `actor.cancel(sessionID, actorID)` | `prompts.cancel(sessionID)` | 取消 |
| `context: "none"` | 不需要（子 session 天然隔离） | 简化 |
| `tools: "INHERIT"` | `deriveSubagentSessionPermission` | 权限模型 |
| `onActorID` 回调 | 不需要（session ID 同步可用） | 简化 |

### Model ref 解析（首版简化）

```ts
const resolveAgentModel = (ref: string | undefined, fallback) => {
  if (!ref) return fallback
  if (ref.includes("/")) {
    return Provider.parseModel(ref)
  }
  return fallback // tier 名（如 "lite"）首版不支持，fallback 到默认
}
```

### 不变的部分

- 全局 + per-run 信号量（并发控制）
- Journal 机制（同步追加、resume 重放）
- 嵌套 workflow()（cycle 检测、maxDepth、lineage）
- 超时 race（`awaitWithTimeout`），取消改为 `prompts.cancel`
- Lifecycle cap（1000 agent 上限）
- Phase/log 上报
- Counter flush（debounce 250ms）

### 首版不实现的

- `spawnIsolated`（worktree 隔离）—— `o.isolation === "worktree"` 分支跳过，直接走 spawnShared
- `Instance.provide`（ALS 上下文切换）—— 不需要
- Model tier ref 解析 —— fallback 到默认模型

## 适配移植模块

### Persistence

```ts
// MiMo-Code: Database.use((db) => ...)
// 目标库:   const { db } = yield* Database.Service
```

- 数据目录：目标库的 `InstanceStore`/`Project` 提供 per-directory 数据路径。实现时确认具体 API（可能是 `InstanceState.context` 的某个字段，或 `process.env.XDG_DATA_HOME` + project hash）
- Journal 路径：`<data>/workflow/<runID>.jsonl` 保持不变
- 所有 DB 操作从 `Database.use` 改为 `const { db } = yield* Database.Service` 解构
- Migration：在 `packages/core/src/` 下新建 migration，用 `bun run db generate --name workflow` 生成

### Events

```ts
// MiMo-Code: BusEvent.define("workflow.started", { ... })
// 目标库:   EventV2.define({ type: "workflow.started", schema: Schema.Struct({ ... }) })

// 发布: bus.publish(Event, payload) → EventV2.publish(Event, payload)
```

6 个事件全部转换：started / phase / log / finished / agent_failed / child_failed。

### Workspace

文件 jail 的 Glob 调用换成目标库的 glob 实现（目标库有 `tool/glob.ts`，底层用相同的 `@anthropic/glob` 或等价物）。`resolveInWorkspace` 的 lexical jail 逻辑保留，`Filesystem.contains/readText/write/exists` 换成目标库的等价文件系统工具。

### Resolve

workflow 脚本查找路径：
- `.opencode/workflows/`（目标库原生）
- `.claude/workflows/`（兼容）

### workflow.sql.ts

```ts
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Timestamps } from "@opencode-ai/core/database/schema.sql"

export const WorkflowRunTable = sqliteTable("workflow_run", {
  id: text().primaryKey(),
  session_id: text().$type<SessionID>().notNull()
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
}, (table) => [
  index("workflow_run_session_idx").on(table.session_id),
  index("workflow_run_status_idx").on(table.status),
])
```

## 外部接入

### Workflow 工具

直接移植 `tool/workflow.ts` + `workflow.txt`。`workflowRef` 晚绑定模式保留。

门控注册：
```ts
if (flags.experimentalDynamicWorkflow) {
  builtin.push(WorkflowTool)
}
```

### HTTP API

`server/routes/instance/httpapi/groups/workflow.ts`：

- `GET /workflows?session_id=xxx` — 列出 session 的 runs（session_id 必填）
- `POST /workflows/:runID/resume` — 恢复一个 run

### TUI

三个改动点（`packages/tui/src/`）：

1. `context/sync.tsx` — workflow 状态 slice + 事件订阅 + HTTP 轮询
2. `component/dialog-workflows.tsx` — /workflows 对话框（列表 + resume）
3. `app.tsx` — 注册 `/workflows` 命令（flag 门控）

### Config

```ts
workflow: Schema.optional(Schema.Struct({
  maxConcurrentAgents: Schema.Number.optional(),
  maxDepth: Schema.Number.optional(),
  maxLifecycleAgents: Schema.Number.optional(),
  scriptDeadlineMs: Schema.Number.optional(),
})).annotate({ description: "Dynamic workflow runtime settings." })
```

默认值：并发 `min(16, 2×cores)`、maxDepth 8、lifecycle 1000、deadline 12h。

### Flag

```ts
// packages/opencode/src/effect/runtime-flags.ts
experimentalDynamicWorkflow:
  Config.boolean("OPENCODE_EXPERIMENTAL_DYNAMIC_WORKFLOW").pipe(
    Config.withDefault(false),
  )
```

### Command

```ts
if (flags.experimentalDynamicWorkflow) {
  commands["deep-research"] = {
    name: "deep-research",
    description: "deep multi-source, fact-checked research report",
    template: deepResearchTemplate(),
  }
}
```

### Layer 接入

```ts
// packages/opencode/src/effect/app-runtime.ts
export const AppLayer = Layer.mergeAll(
  // ...现有 layers
  WorkflowRuntime.defaultLayer,
)
```

### Inbox 替代（合成消息注入）

```ts
// runtime.ts work fiber 完成时
yield* prompts.prompt({
  sessionID: input.sessionID,
  parts: [{
    type: "text",
    synthetic: true,
    text: `Workflow completed. run_id: ${runID}\n` + JSON.stringify(result).slice(0, 4000),
  }],
})
```

## 实施阶段

| 阶段 | 内容 | 验证方式 |
|------|------|---------|
| **P1: 直接移植** | sandbox.ts + meta.ts + builtin.ts + deep-research.js + runtime-ref.ts | 单元测试：meta 解析、sandbox 执行 |
| **P2: 数据层** | workflow.sql.ts + persistence.ts + migration | 能创建/查询 workflow_run 行 |
| **P3: 基础 runtime** | runtime.ts 骨架（信号量、journal、phase/log hooks），spawn 先用 mock | sandbox 能跑通不调 agent() 的脚本 |
| **P4: Spawn 重写** | spawnShared 重写 + EventV2 事件 + 合成消息注入 | **关键验证点**：简单脚本调 agent()，能拿到结果 |
| **P5: 嵌套 workflow** | workflowHook（cycle 检测、maxDepth） | 跑通嵌套调用 |
| **P6: 外部接入** | workflow 工具 + HTTP API + config + flag + layer + command | LLM 能调用 workflow 工具 |
| **P7: TUI** | /workflows 对话框 + sync 事件订阅 | TUI 里看到运行状态 |
| **P8: deep-research 端到端（门禁）** | 跑通 `/deep-research` 命令 | **迁移完成的硬性验收标准**（见测试策略） |

## 测试策略

### 单元测试（`packages/opencode/test/workflow/`）

- `meta.test.ts` — meta 解析器各种输入（合法/非法/边界）
- `sandbox.test.ts` — QuickJS 执行、hook 注入、确定性约束（Date/Math.random 被 strip）
- `persistence.test.ts` — journal 读写、sha 检测、resume 重放

### 集成测试

- `runtime.test.ts` — 启动 workflow → agent() spawn → 返回结果
- `runtime-nested.test.ts` — 嵌套 workflow()、cycle 检测
- `runtime-resume.test.ts` — journal 重放、脚本变更检测

### 端到端验证：/deep-research（门禁测试）

**`/deep-research` 必须跑通，这是迁移完成的硬性验收标准。** 它是内置的 `deep-research.js` 工作流，覆盖了 workflow 的所有核心功能路径：

| deep-research 阶段 | 覆盖的 workflow 功能 |
|---|---|
| Plan（`agent` + `schema`） | 结构化输出、agent() spawn、null 处理 |
| Search（`pipeline`） | pipeline 流水线、无 barrier stage 切换 |
| Extract（嵌套 `parallel`） | parallel 扇出、URL 去重逻辑、agent().catch |
| Group（`agent` + `schema`） | 结构化对象操作、防御性访问 |
| Crosscheck（`parallel` × `parallel`） | **两层嵌套并行**、model ref 传递（`"lite"` 走 fallback） |
| Report（`agent` + `schema`） | 大 schema 结构化输出、降级 fallback（report 失败返回 upheld 原始数据） |

**前置条件**（目标库已有）：
- `websearch` 工具（`packages/opencode/src/tool/websearch.ts`）— deep-research agent 用它搜索
- `webfetch` 工具（`packages/opencode/src/tool/webfetch.ts`）— agent 用它抓取页面
- 配置好的 LLM provider（需要能实际调用模型）

**验收命令**：
```bash
OPENCODE_EXPERIMENTAL_DYNAMIC_WORKFLOW=1 opencode
# 在 TUI 里：
/deep-research What are the performance differences between Bun and Node.js?
```

**验收标准**：
1. workflow 启动，`/workflows` 对话框显示 running 状态和实时计数器
2. 跑完不崩溃（无未捕获异常）
3. 返回包含 `answer`、`findings`、`sources`、`stats` 字段的结构化报告
4. `stats.agentRuns` > 0（证明 agent 确实被 spawn 了）
5. journal 文件 `~/.local/share/opencode/workflow/<runID>.jsonl` 存在且非空

**为什么选 deep-research 做门禁**：
- 它是唯一一个现成的、生产级的 workflow 脚本
- 它同时用了 `agent()`、`parallel()`、`pipeline()`、嵌套 `parallel()`、`schema` 结构化输出、`phase()`、`log()`、null 降级处理——覆盖面最广
- 如果它能跑通，说明 spawn 重写、journal、事件、DSL 注入全部正确

## 风险与缓解

| 风险 | 概率 | 缓解 |
|------|------|------|
| Session 创建比 Actor spawn 慢 | 中 | 信号量已节流；Session 创建是 DB 写入（毫秒级），不是瓶颈 |
| `prompts.prompt()` 消息提取与预期不符 | 中 | 先写集成测试验证提取逻辑，再跑 deep-research |
| quickjs-emscripten 与 Bun 不兼容 | 低 | quickjs-emscripten 是纯 WASM，不依赖 Node API |
| EventV2 与 BusEvent 行为差异 | 低 | 事件是单向通知，语义简单 |
| 全局数据目录/Glob/Filesystem API | 低 | 实现时确认，标准基础设施 |
| deep-research agent 需要 websearch/webfetch 权限 | 低 | 目标库已有这两个工具；`deriveSubagentSessionPermission` 默认继承 |
| deep-research 用了 `model: "lite"`（tier ref） | 低 | 首版 fallback 到默认模型，功能不受影响（只是不省钱） |

## 不在首版范围内

- worktree 隔离（`isolation: "worktree"`）—— 后续增量添加
- model tier ref 解析（`"lite"` 等）—— 后续接 provider tier 配置
- DWS（GitLab Duo Workflow Service）集成—— 独立概念，与 Dynamic Workflow 无关

## 新增依赖

- `quickjs-emscripten` — QuickJS WASM 运行时（需加到 `packages/opencode/package.json`）

## 文档引用（迁移产出）

迁移时将以下两份文档从 MiMo-Code 复制到目标仓库 `docs/workflow/`，并修正路径引用（`.mimocode` → `.opencode`）：

### 1. 语法规则参考 — `docs/workflow/workflow-rules.md`

workflow 脚本的**完整语法与语义规则**。涵盖：

- **meta 阶段**：`export const meta = {...}` 必须开头；纯数据字面量子集（对象/数组/字符串/数字/布尔/null）；禁止的写法（函数调用、运算符、模板字符串等）；必填字段（name、description）
- **body 阶段**：标准 ES2020（QuickJS 子集）；合法语法（await、箭头函数、解构、模板字符串等）；禁止的 API（import、Node API、Web API、Date、原始 Math.random）；确定性约束（Date 删除、Math.random 替换为 seeded PRNG）
- **注入 DSL**：`agent(prompt, opts?)`、`parallel(thunks)`、`pipeline(items, ...stages)`、`workflow(nameOrScript, args?, opts?)`、文件原语、`phase()`、`log()`、`args` 的完整签名
- **安装与使用**：`.opencode/workflows/<name>.js` 安装位置；slash command 绑定；查询执行情况（TUI /workflows、HTTP API、journal）
- **嵌套与安全**：maxDepth、maxLifecycleAgents、并发控制、结构性 vs 运行时错误
- **持久化与 Resume**：journal 机制、脚本变更检测
- **配置参考**：`workflow.maxConcurrentAgents`、`maxDepth`、`maxLifecycleAgents`、`scriptDeadlineMs`
- **HTTP API**：GET /workflows、POST /workflows/:runID/resume
- **事件清单**：6 个 EventV2 事件的触发时机
- **完整骨架**：可直接复制使用的脚本模板

### 2. 最佳实践 — `docs/workflow/workflow-best-practices.md`

编写健壮 workflow 脚本的**13 条实践 + 反模式速查**。涵盖：

- 写收敛的脚本（resume 友好）、用 workspace 文件做 checkpoint
- 始终处理 null（agent/workflow 永不抛异常）
- 用 schema 强制结构化输出
- parallel vs pipeline 的选择
- phase()/log() 可观测性
- 并发意识（信号量节流、lifecycle cap）
- worktree 隔离使用时机
- 子工作流的使用与环检测
- 数据流设计（返回值 vs workspace 文件）
- 模型选择（tier 分层）
- 超时防御
- 脚本可读性（提取 prompt 模板）
- 测试与调试（本地试跑、检查 journal、常见失败模式）
- 反模式速查表（8 条 ❌ 模式）

这两份文档是 spec 的**规范性引用**——实现完成后必须验证文档描述的行为与目标库实际行为一致。

- workflow 源码：`/Users/gandazhi/code/agent/MiMo-Code/packages/opencode/src/workflow/`
- 规则文档：`/Users/gandazhi/code/agent/MiMo-Code/docs/workflow-rules.md`
- 最佳实践：`/Users/gandazhi/code/agent/MiMo-Code/docs/workflow-best-practices.md`
- 目标库 Task 工具：`packages/opencode/src/tool/task.ts`
- 目标库 Session API：`packages/opencode/src/session/session.ts` + `prompt.ts`
- 目标库 BackgroundJob：`packages/core/src/background-job.ts`
