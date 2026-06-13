# Dynamic Workflow 最佳实践

本文档总结编写健壮、可恢复、高效的 workflow 脚本的实践要点。规则定义见 [workflow-rules.md](./workflow-rules.md)。

---

## 1. 写收敛的脚本（resume 友好）

**核心原则**：脚本应当是幂等的——给定相同的 `args` 和 journal，重跑应当做更少的事而非更多。

### 为什么

进程可能在任意时刻被 kill（OOM、SIGKILL、deadline）。Resume 会重放 journal 里已成功的 `agent()`，跳过未完成的。如果脚本依赖**副作用累积**（如全局计数器递增），重放会出错。

### 怎么做

```js
// GOOD — 从 args/workspace 派生工作单元，不依赖运行时累积
const files = await glob("src/**/*.ts")
const pending = files.filter(f => !(await exists(`.cache/${f}.done`)))

const results = await parallel(
  pending.map(f => () =>
    agent(`process ${f}`).then(r => {
      if (r) writeFile(`.cache/${f}.done`, JSON.stringify(r))
      return r
    })
  )
)

// BAD — 计数器在重放时会重复递增
let count = 0
// ... count++ 散落各处
```

### 用 workspace 文件做 checkpoint

```js
// 用 writeFile 标记进度，resume 时跳过已完成的
const done = await exists(".wf/phase1.done")
if (!done) {
  await phase1Work()
  await writeFile(".wf/phase1.done", "1")
}
```

---

## 2. 始终处理 null

`agent()` 和 `workflow()` **永不抛异常**，失败返回 `null`。不处理 null 会在后续 `.map` / 解构时炸掉。

```js
// GOOD — 显式过滤
const results = (await parallel(thunks)).filter(Boolean)

// GOOD — 防御性访问
const plan = await agent("...", { schema: PLAN_SHAPE })
if (!plan) return { error: "planning failed" }
const lines = plan.lines ?? []

// BAD — null 会传播并最终在解构时崩溃
const { lines } = await agent("...")  // null 解构 → throw → run 失败
```

### 在 parallel 里隔离失败

```js
// GOOD — 一个 thunk 失败不影响其他
const results = await parallel(
  items.map(item => () =>
    agent(work(item))
      .then(r => r ?? { error: "null", item })
      .catch(e => { error: e.message, item })  // parallel 已隔离，但显式 catch 更清晰
  )
)
```

---

## 3. 用 schema 强制结构化输出

当 agent 的结果需要被脚本进一步处理时，**总是**提供 `opts.schema`。这把"模型可能返回任意 prose"变成"可编程的确定结构"。

```js
const EXTRACT_SHAPE = {
  type: "object",
  required: ["facts"],
  properties: {
    facts: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        required: ["statement", "weight"],
        properties: {
          statement: { type: "string" },
          weight: { enum: ["key", "support", "aside"] },
        },
      },
    },
  },
}

const result = await agent("...", { schema: EXTRACT_SHAPE })
// result.facts 是确定的数组，可以安全 .map / .filter
```

**注意**：给了 schema，返回的是验证后的结构化对象，**不是** prose `finalText`。即使模型失败了，返回的也是 `null` 而非 prose。

---

## 4. parallel vs pipeline 的选择

| 场景 | 用什么 | 原因 |
|------|--------|------|
| 一批独立任务，等全部完成 | `parallel` | 简单 |
| 每个 item 要经过相同的多个阶段 | `pipeline` | 无 barrier，更快 |
| 需要在所有结果到齐后排序/去重再进入下一阶段 | `parallel` + 手动处理 | pipeline 无法在中间插 barrier |

```js
// pipeline — item 流水穿过多阶段，快
const results = await pipeline(
  urls,
  url => agent(`fetch ${url}`),
  resp => agent(`extract ${resp}`),
)

// parallel + barrier — 需要全部到齐后再决策
const fetched = await parallel(urls.map(u => () => agent(`fetch ${u}`)))
const ranked = fetched.filter(Boolean).sort(byRelevance)  // barrier 后再处理
const verified = await parallel(ranked.map(r => () => agent(`verify ${r}`)))
```

---

## 5. 用 phase() 和 log() 让运行可观测

Workflow 可能跑几分钟到几小时。phase/log 是唯一的外部可观测手段（通过 Bus 事件 + TUI `/workflows` 视图）。

```js
phase("Search")  // 触发 WorkflowPhase 事件，UI 显示当前阶段
log(`Querying: ${query}`)  // 写入 journal + 触发 WorkflowLog

const hits = await agent(...)
log(`Got ${hits?.results?.length ?? 0} hits`)
```

**实践**：
- 每个 phase 标题简短（`"Search"` 而非 `"Searching the web for relevant results"`）
- log 记录关键决策点和数量（`"Folded 12 facts → 5 groups"`）
- 不要在每个 agent 调用前后都 log（太吵）

---

## 6. 并发意识

并发由全局信号量管理（默认 `min(16, 2×cores)`），不需要手动节流。但要知道：

- `parallel([100 个 thunk])` **不会**同时跑 100 个 agent——超过上限的会排队
- 嵌套的 `workflow()` 子 run **共享**全局信号量
- 单个 run 终生 agent 上限是 1000（`maxLifecycleAgents`），超出返回 null

```js
// GOOD — 让 parallel 自然节流，不要手动分批
const results = await parallel(
  allItems.map(item => () => agent(work(item)))
)

// 不需要这样手动分批
// const batch1 = await parallel(allItems.slice(0, 16).map(...))
// const batch2 = await parallel(allItems.slice(16, 32).map(...))
```

### lifecycle cap 意识

如果工作单元可能超过 1000，提前截断：

```js
const WORK_CAP = 800  // 留余量给 plan/report 等固定 agent
const items = (await glob("...")).slice(0, WORK_CAP)
log(`Capped to ${items.length} items (lifecycle budget)`)
```

---

## 7. 何时用 worktree 隔离

默认 `agent()` 共享父 session（`context: "none"` 隔离历史，但文件操作在同一目录树）。用 `isolation: "worktree"` 当且仅当：

- 多个 agent 可能**同时修改相同的文件**（并行 PR 风格工作）
- 需要 agent 的变更**可独立接受或丢弃**

```js
const results = await parallel(
  tasks.map(t => () => agent(`Implement: ${t}`, {
    isolation: "worktree",
    label: t,
  }))
)
// 成功且有改动的 worktree 保留，其 branch 可后续 integrate
// 其余（pristine / 失败）自动回收

const branches = results
  .filter(Boolean)
  .filter(r => r._worktree)
  .map(r => r._worktree.branch)
```

**注意**：
- worktree agent 不被 journal 缓存（产物是文件树，无法重建）
- 成功但 pristine（无改动）的 worktree 会被回收

---

## 8. 子工作流的使用

用 `workflow()` 当任务可以分解为**独立的、可复用的子流程**：

```js
// 内联子工作流
const verified = await workflow(`
  export const meta = { name: "verify", description: "..." }
  const fact = args
  const checks = await parallel([
    () => agent("check source reliability", { model: "lite" }),
    () => agent("check date freshness", { model: "lite" }),
  ])
  return { fact, checks: checks.filter(Boolean) }
`, fact)

// 保存的子工作流（.mimocode/workflows/verify.js）
const result = await workflow("verify", { topic: "..." })
```

**注意**：
- 子工作流有自己的 lifecycle cap（不继承父的）
- 环检测：保存的名字按名字检测（A→A 是 cycle），内联脚本按 content+args 检测
- 子失败返回 null，不抛异常——除非结构性错误（cycle/depth/unknown-name）

---

## 9. 数据流设计

工作流之间**不直接通信**。数据流通过：

1. **返回值**（首选）：子工作流 return → 父 await 得到
2. **workspace 文件**：`writeFile` 写共享状态，后续 phase 读

```js
// 用文件做跨 phase 的大数据传递（避免 args 过大）
phase("Collect")
const data = await parallel(...)
await writeFile(".wf/collected.json", JSON.stringify(data))

phase("Process")
const loaded = JSON.parse(await readFile(".wf/collected.json") ?? "{}")
```

---

## 10. 模型选择

用 `opts.model` 为不同任务选合适的 tier，省成本省时间：

```js
// 简单判断用 lite
const ruling = await agent("Is this fact reliable?", {
  model: "lite",
  schema: { type: "object", required: ["reject"], properties: { reject: { type: "boolean" } } },
})

// 复杂推理用默认（强模型）
const plan = await agent("Break down this research question", {
  schema: PLAN_SHAPE,
})
```

未知 model ref 不会报错——回退到 run 默认模型，并 warn 一次。

---

## 11. 超时防御

长时间运行的 agent 可能卡住（LLM TTFT wall）。用 `opts.timeoutMs` 或 run 级 `agentTimeoutMs` 防御：

```js
// 单 agent 超时
const result = await agent("...", { timeoutMs: 60_000 })

// 超时返回 null，不会卡住 parallel barrier
```

---

## 12. 脚本可读性

workflow 脚本首先是**给人读的**。实践：

```js
// GOOD — 提取 prompt 模板为命名函数
const searchPrompt = (line) =>
  `You are searching for: ${line.topic}\nQuery: ${line.query}`

const readPrompt = (source) =>
  `Read and extract facts from: ${source.url}`

// 在使用处保持简洁
phase("Search")
const results = await pipeline(
  plan.lines,
  line => agent(searchPrompt(line), { schema: HITS_SHAPE }),
  hits => parallel(hits.map(h => () => agent(readPrompt(h), { schema: READ_SHAPE }))),
)
```

---

## 13. 测试与调试

### 本地试跑

```bash
# 启用 workflow 工具
MIMOCODE_EXPERIMENTAL_WORKFLOW_TOOL=1

# TUI 中查看运行状态
/workflows
```

### 检查 journal

```bash
# journal 在 data 目录
cat ~/.local/share/mimocode/workflow/<runID>.jsonl
# 每行一个 JSON：{ t: "agent", key: "...", result: ..., pass: N }
```

### 常见失败模式

| 现象 | 原因 | 解决 |
|------|------|------|
| run 启动即失败 | meta 解析失败 | 检查 `export const meta` 是否符合数据字面量规则 |
| agent 全返回 null | model ref 不存在 / 工具不可用 | 检查 `opts.model`、agent tool 权限 |
| resume 行为异常 | 脚本被编辑过 | resume 会检测 sha 不匹配 → 清空 journal 重跑 |
| `Date is not defined` | 脚本用了 `new Date()` | 确定性约束禁止，改用 `args` 传入时间戳 |
| parallel 槽全 null | lifecycle cap 达上限 | 检查 log 中的 cap warning，减少 agent 数 |

---

## 反模式速查

```js
// ❌ 不处理 null
const { x } = await agent("...")
// → null 解构崩溃，run 失败

// ❌ 用 Date()
const now = new Date()
// → Date 被 delete，throw

// ❌ 依赖运行时全局状态做 resume 判断
let processed = 0
// resume 时 processed 从 0 开始，但 journal 已有结果
// → 逻辑错乱

// ❌ 手动分批绕过并发控制
const batch = items.slice(0, 16)
// → parallel 已经节流，手动分批只增加复杂度

// ❌ agent 调用外层包 try/catch
try { await agent("...") } catch {}
// → agent 永不抛，catch 是死代码；用 .then(r => r ?? fallback)

// ❌ 在 workflow() 外层包 try/catch 吞掉结构性错误
try { await workflow("child") } catch {}
// → cycle/depth 错误被吞，隐藏 wiring bug；只有故意要忽略配置错误时才这样做

// ❌ glob 后用 agent 列文件
const files = await agent("list files in src/")
// → 直接用 glob("src/**/*")，不浪费一个 agent 调用

// ❌ 一个 agent 做太多事
await agent("research the topic, write code, run tests, and deploy")
// → 拆成多阶段，用 parallel/pipeline 编排
```

---

## 参考实现

`packages/opencode/src/workflow/builtin/deep-research.js` 是一个完整的生产级范例，演示了：

- 多阶段 phase 划分（Plan → Search → Extract → Group → Crosscheck → Report）
- `pipeline` 流水线（search → dedup → read 无 barrier）
- `parallel` 扇出 + `parallel` 嵌套（crosscheck 的陪审团）
- 结构化 schema 全程传递
- 对抗式验证模式（多 juror 投票）
- 错误降级（每层都有 `if (!result) return { error: ... }`）
- 统计信息收集

读这个文件是学习 workflow 编排的最佳方式。
