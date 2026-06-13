# Dynamic Workflow 规则参考

Dynamic Workflow 是一个确定性的多智能体编排引擎。编排逻辑由一段普通 JavaScript 脚本描述，在隔离的 QuickJS 沙箱中执行，通过 host 注入的原语（`agent()` / `parallel()` / `pipeline()` / `workflow()`）fan-out 子智能体。

本文档列出脚本必须遵守的全部语法与语义规则。

---

## 启用方式

Workflow 工具受实验开关门控（`packages/opencode/src/flag/flag.ts:118`）：

```bash
MIMOCODE_EXPERIMENTAL_WORKFLOW_TOOL=1
```

启用后，LLM 可调用 `workflow` 工具；TUI 中出现 `/workflows` 视图。

---

## 脚本结构

每个脚本由两部分组成，按顺序拼接：

```
┌─────────────────────────────┐
│  export const meta = { ... } │  ← 阶段一：数据字面量（静态解析）
├─────────────────────────────┤
│  phase("...")                │
│  const x = await agent(...)  │  ← 阶段二：body（QuickJS 执行）
│  return { ... }              │
└─────────────────────────────┘
```

---

## 阶段一：meta 规则

### 1.1 强制开头

脚本**必须**以 `export const meta = { ... }` 开头（允许前面有空白/注释）。否则启动即失败（`runtime.ts:1100`，`Effect.die`）。

### 1.2 纯数据字面量

meta 由一个手写递归下降解析器解析（`meta.ts`），**只接受纯数据**，绝不 eval。合法 token：

| 类型 | 语法 | 示例 |
|------|------|------|
| 对象 | `{ key: value }` | key 可不带引号（标识符）或带引号 |
| 数组 | `[a, b]` | 支持尾逗号 |
| 字符串 | `"..."` 或 `'...'` | 支持转义 `\n \t \r \b \f \v \0 \uXXXX`，`\\` `\"` `\'` `\/` |
| 数字 | `42` `-3.14` `1e9` | 含负号、小数、科学计数 |
| 布尔 | `true` / `false` | — |
| null | `null` | — |
| 注释 | `// ...` / `/* ... */` | 解析时跳过 |

### 1.3 禁止的写法（全部 parse error）

| 禁止 | 原因 |
|------|------|
| `foo()` 函数调用 | 非数据 |
| `a.b` 成员访问 | 非数据 |
| `1 + 2` 运算符 | 非数据 |
| `` `template` `` 模板字符串 | 非数据（仅 meta 内禁止，body 可用） |
| `...x` spread | 非数据 |
| `[expr]:` computed key | 非数据 |
| `function` / `=>` | 非数据 |
| 嵌套超过 100 层 | 深度上限（防栈溢出） |

> **为什么不 eval**：`new Function` / `eval` 会在宿主 realm 执行，`meta: { name: (require('child_process').execSync('id'), 'x') }` 就能 RCE。
> **为什么不用 JSONC**：真实 meta 用了不带引号的 key 和单引号字符串，严格 JSON 不接受。

### 1.4 必填 / 可选字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | 非空 string | 是 | 工作流标识 |
| `description` | 非空 string | 是 | 用于 LLM 选择是否调用 |
| `whenToUse` | string | 否 | 使用时机提示 |
| `phases` | `[{title, detail?}]` | 否 | 阶段声明，用于 UI 展示 |
| `model` | string | 否 | 默认模型引用 |

### 1.5 meta 被替换为空白

解析后，meta 语句被等长空白替换（`meta.ts:58`），保留行号，剩余部分即 body。

---

## 阶段二：body 规则

### 2.1 执行模型

body 被包进 async IIFE 后在 QuickJS 中执行（`sandbox.ts:144`）：

```js
(async () => {
  /* your body here */
})()
```

因此 body 的语法就是**标准 ECMAScript（QuickJS 实现的 ES2020 子集）**。

### 2.2 合法语法

| 可用 | 说明 |
|------|------|
| `await` | 顶层可用（被 async 包裹） |
| `const` / `let` / `var` | 变量声明 |
| 箭头函数、`function` | 函数定义 |
| 解构、扩展运算符 `...` | 在 body 里完全合法（仅 meta 禁止） |
| 模板字符串 `` `...` `` | body 里可用 |
| `if/else`、`for`、`while`、`try/catch` | 控制流 |
| `return` | 顶层 return = 整个 workflow 的返回值 |
| `Promise` / `async/await` | 异步组合 |
| `JSON`、`Math`（除 `Math.random`）| 内置对象 |
| `Array` / `Object` / `String` / `Number` / `Map` / `Set` | 内置类型 |
| `Error` | 可 throw / catch |

### 2.3 禁止的 API / 行为

| 禁止 | 原因 |
|------|------|
| `import` / `export`（除开头的 meta） | QuickJS 不处理 ESM |
| `require` / Node API | 沙箱无 Node realm |
| `fetch` / `XMLHttpRequest` / Web API | 沙箱无 Web 环境 |
| `new Date()` | `Date` 被 `delete`（确定性约束） |
| `Math.random()`（原始） | 被替换为 seeded PRNG，可用但结果确定性 |
| `WeakRef` / `FinalizationRegistry` | 被 `delete`（确定性约束） |
| `process` / `global` / `crypto` / `performance` | 未定义 |
| `setTimeout` / `setInterval` | 未定义（并发由 host 信号量管理） |

### 2.4 确定性约束（自动 strip）

`sandbox.ts:112` 在执行前自动处理，保证 resume 重放可重现：

| 操作 | 处理 |
|------|------|
| `globalThis.Date` | `delete` |
| `Math.random` | 替换为 mulberry32 PRNG，seed = `sha1(runID)` 前 4 字节 |
| `WeakRef` / `FinalizationRegistry` | `delete` |

> **重放不变量**：同一个 runID 的 resume 得到相同的 PRNG 序列；两个不同的 runID 得到不同的序列。

### 2.5 资源上限

| 限制 | 默认值 | 来源 |
|------|--------|------|
| 内存 | 64 MiB | `sandbox.ts` DEFAULT_MEMORY |
| 脚本总时限 | 12 小时 | config `workflow.scriptDeadlineMs` |
| 全局并发 agent | `min(16, 2×cores)` | config `workflow.maxConcurrentAgents` |
| 嵌套深度 | 8 | config `workflow.maxDepth` |
| 单 run 总 agent 数 | 1000 | config `workflow.maxLifecycleAgents` |

---

## 注入的全局变量（DSL）

host 在执行前将以下函数/值注入为 guest 全局变量：

### agent(prompt, opts?) → Promise\<value | null\>

派生一个子智能体执行任务。

| 参数 | 类型 | 说明 |
|------|------|------|
| `prompt` | string | 任务描述 |
| `opts.agentType` | string | 智能体类型，默认 `"general"` |
| `opts.tools` | `string[]` | 限制可用工具；省略 = 继承 |
| `opts.model` | string | 模型引用（`"provider/model"` 或 tier 名如 `"lite"`），未知则回退默认 |
| `opts.schema` | object | JSON Schema，要求结构化输出；给出则返回验证后的对象 |
| `opts.isolation` | `"worktree"` | 独立 git worktree 隔离 |
| `opts.label` | string | 可观测性标签 |
| `opts.phase` | string | 阶段标签 |
| `opts.timeoutMs` | number | 单 agent 超时（ms），超时返回 null |

**永不抛异常**：失败一律返回 `null`。原因可能是 over-cap / spawn-reject / timeout / actor-error / no-deliverable。

### parallel(thunks) → Promise\<any[]\>

并发执行 thunk 数组。一个 thunk 抛异常 → 该槽为 `null`（不阻塞其他）。

```js
const results = await parallel([
  () => agent("task A"),
  () => agent("task B"),
])
```

### pipeline(items, ...stages) → Promise\<any[]\>

每个 item 依次穿过所有 stage，**无 barrier**（stage 间流水推进）。

```js
const out = await pipeline(
  urls,
  url => agent(`search ${url}`),  // stage 1
  r => agent(`summarize ${r}`),   // stage 2
)
```

### workflow(nameOrScript, args?, opts?) → Promise\<value | null\>

启动子工作流（独立 sub-run，await 其结果）。

| 参数 | 类型 | 说明 |
|------|------|------|
| `nameOrScript` | string | 内联脚本（含 `export const meta`）或保存的名字 |
| `args` | any | 传给子工作流的 `args` |
| `opts.workspace` | string | 子工作流 workspace（不得超出父 root） |
| `opts.maxConcurrentAgents` | number | 子 run 并发上限（≤ 全局） |

**永不抛**：子失败返回 `null`。但**结构性错误**（cycle / over-depth / unknown-name）会**抛异常**，导致整个 run 失败。

**环检测规则**：
- 保存的名字：按名字检测（A 调 A 即 cycle，不论 args）
- 内联脚本：按 content+args hash 检测（同脚本不同 args 不算 cycle）

### 文件原语（jail 到 workspace）

| 函数 | 签名 | 说明 |
|------|------|------|
| `readFile(path)` | → `Promise<string \| null>` | 不存在返回 null |
| `writeFile(path, content)` | → `Promise<void>` | 自动创建父目录 |
| `glob(pattern)` | → `Promise<string[]>` | 排序后返回相对路径 |
| `exists(path)` | → `Promise<boolean>` | — |

> **jail 是 lexical 的**：拒绝 `..` 和绝对路径逃逸，但**不 resolve symlink**。视为作用域限制，不是硬安全边界。

### 进度上报

| 函数 | 说明 |
|------|------|
| `phase(title)` | 声明当前阶段，触发 `WorkflowPhase` 事件 + 持久化 |
| `log(message)` | 日志，触发 `WorkflowLog` 事件 + journal 追加 |

### args

`run` 操作时传入的任意 JSON 值，作为全局变量 `args` 暴露给脚本。

---

## workflow 工具操作

LLM 通过 `workflow` 工具调用（`tool/workflow.ts`）：

| operation | 参数 | 说明 |
|-----------|------|------|
| `run` | `name` 或 `script`（二选一）、`args?`、`workspace?` | 启动，立即返回 run_id |
| `status` | `run_id` | 查询状态 |
| `wait` | `run_id`、`timeout_ms?` | 阻塞等待完成 |
| `cancel` | `run_id` | 取消（graceful） |
| `resume` | `run_id` | 恢复持久化的 run |

### 内置工作流

通过 `name` 引用（`builtin.ts`）：

| name | 说明 |
|------|------|
| `deep-research` | 多源研究 + 对抗式交叉验证 + 引用报告 |

### 保存的工作流

从 `.mimocode/workflows/<name>.js` 或 `.claude/workflows/<name>.js` 解析（`resolve.ts`），nearest-first，项目目录覆盖上层。

名字约束：`/^[A-Za-z0-9._-]+$/`（单段，不能含路径分隔符）。

---

## 持久化与 Resume

### journal 机制

每个成功的 `agent()` 结果**同步追加**到 `<data>/workflow/<runID>.jsonl`（`appendFileSync`）。key = `sha256(prompt + agentType + model + schema + phase) + ":" + occ`。

Resume 时：
1. 读回脚本 + journal
2. journal 命中的 `agent()` 直接返回缓存，不重新 spawn
3. 未命中的正常 spawn + 追加

### 脚本变更检测

持久化时记录 `script_sha`。Resume 时比对当前脚本 sha：
- **匹配** → 正常重放
- **不匹配** → **清空 journal**，从头跑（避免旧结果套到新代码路径上）

### 不会被 journal 缓存的

- 失败的 `agent()`（返回 null）→ 重跑
- `isolation: "worktree"` 的 agent → 其产物是 worktree，journal 无法重建

---

## 嵌套与安全

### 嵌套限制

| 维度 | 默认 | 行为 |
|------|------|------|
| `maxDepth` | 8 | 超出 → `workflow()` 抛异常，run 失败 |
| `maxLifecycleAgents` | 1000（per run） | 超出 → `agent()` 返回 null（graceful） |
| `maxConcurrentAgents` | `min(16, 2×cores)`（全局） | 超出 → 排队 |

子工作流有自己的 lifecycle cap 和 timeout，不从父继承。并发由全局信号量统一节流。

### 结构性 vs 运行时错误

| 类型 | 例子 | 行为 |
|------|------|------|
| 结构性（wiring bug） | cycle / over-depth / unknown-name | `Effect.die`，**fail loud**，向根传播 |
| 运行时（条件失败） | agent 挂了 / deadline / cancel | 返回 `null`，**降级**，脚本继续 |

---

## 配置参考（`opencode.json`）

```json
{
  "workflow": {
    "maxConcurrentAgents": 16,
    "maxDepth": 8,
    "maxLifecycleAgents": 1000,
    "scriptDeadlineMs": 43200000
  }
}
```

| 字段 | 默认 | 说明 |
|------|------|------|
| `maxConcurrentAgents` | `min(16, 2×cores)` | 进程级全局并发上限（所有 run 共享） |
| `maxDepth` | 8 | workflow 调 workflow 的最大嵌套深度 |
| `maxLifecycleAgents` | 1000 | 单个 run 终生可 spawn 的 agent 总数 |
| `scriptDeadlineMs` | 43200000（12h） | 单次脚本执行的 wall-clock 预算 |

---

## HTTP API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/workflows?session_id=...` | 列出某 session 的 run（session_id 必填） |
| POST | `/workflows/:runID/resume` | 恢复一个 run |

---

## 事件（Bus）

| 事件 | 触发时机 |
|------|---------|
| `workflow.started` | run 启动 |
| `workflow.phase` | `phase()` 调用 |
| `workflow.log` | `log()` 调用 |
| `workflow.finished` | run 终止（completed/failed/cancelled） |
| `workflow.agent_failed` | agent() 返回 null（附 reason） |
| `workflow.child_failed` | 子 workflow 非成功终止（附 status） |

---

## 完整骨架

```js
export const meta = {
  name: "my-workflow",
  description: "一句话说明做什么",
  whenToUse: "何时调用",
  phases: [
    { title: "Plan", detail: "分解任务" },
    { title: "Execute", detail: "并行执行" },
  ],
}

phase("Plan")
const plan = await agent("...", { schema: { type: "object", required: ["items"], properties: { items: { type: "array", items: { type: "string" } } } } })
if (!plan) return { error: "plan failed" }

phase("Execute")
const results = await parallel(
  plan.items.map(item => () => agent(`process: ${item}`, { label: item }))
)

return {
  plan,
  results: results.filter(Boolean),
}
```

## 安装与使用

### 安装位置

自定义 workflow 放到以下任一位置（nearest-first，项目目录覆盖上层）：

```
<project>/.opencode/workflows/<name>.js     ← 推荐
<project>/.claude/workflows/<name>.js
```

**命名约束**：`/^[A-Za-z0-9._-]+$/`（单段，不能含路径分隔符）。文件名（不含 `.js`）即为 workflow 名字，`meta.name` 应与之保持一致。

**无需重启**：workflow 按名字运行时解析，每次 `workflow()` 调用时读盘，改完即生效。

### 使用方式

#### 方式 A：LLM 自动调用（最直接）

启用实验开关后在对话里描述任务，LLM 会调用 `workflow` 工具：

```bash
MIMOCODE_EXPERIMENTAL_WORKFLOW_TOOL=1 mimocode
```

应为：

#### 方式 B：绑定 slash command（推荐，体验等同 `/deep-research`）

在 `.mimocode/commands/` 下建一个 markdown 文件（`config/command.ts`）：

`.mimocode/commands/<name>.md`:
```markdown
---
description: Run the <name> workflow
---
workflow({ operation: "run", name: "<name>", args: "$ARGUMENTS" })
Relay the workflow's result to the user.
```

然后在 TUI 里：`/<name> <参数>`

### 查询执行情况

#### TUI

```
/workflows
```

列表每行格式：`<name>  <status>  <phase>  <succeeded>✓ <failed>✗ <running>⟳`

选中 `running`/`failed`/`cancelled` 的 run → 确认 → resume。

#### HTTP API

```bash
# 列出某 session 的 runs（session_id 必填）
curl "http://localhost:<port>/workflows?session_id=<sessionID>"

# Resume
curl -X POST "http://localhost:<port>/workflows/<runID>/resume"
```

#### Journal（最底层细节）

每个 agent 结果同步落盘：

```bash
cat ~/.local/share/mimocode/workflow/<runID>.jsonl
```

每行一条 `{ t: "agent", key, result, pass }`。

> 完整生产级范例见 `packages/opencode/src/workflow/builtin/deep-research.js`。
