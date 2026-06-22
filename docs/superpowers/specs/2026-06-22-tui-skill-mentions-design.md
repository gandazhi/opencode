# TUI 使用 `$` 自动补全 Skill - 设计

**日期：** 2026-06-22
**状态：** 已批准（brainstorm 完成）

## 目标

在 opencode 的 TUI prompt 中加入类似 Codex 的 `$` skill 选择器。用户可以在普通 prompt 的任意位置输入 `$`，选择一个或多个 skill，在输入框中看到可见的 `$skill-name` mention，并让这些 skill 在下一次模型执行前自动加载。

第一版只实现 TUI。它需要把 skill 选择和 slash command 明确分开，同时支持通过补全菜单选择的 skill，以及用户手动输入的 `$skill-name`。

## 非目标

- 本轮不实现 Web 或 desktop composer 支持。
- 不在 shell mode 中支持 skill mention。
- 不把 `$skill` 转换成 slash command。
- 不把 skill 内容粘贴进可见的用户 prompt。
- 本轮不把 skill mention 持久化为新的后端历史 message part 类型。

## 当前状态

- Skill 由 `packages/opencode/src/skill/index.ts` 发现，并通过 `Skill.Service` 暴露。
- Instance HTTP API 已经提供 `GET /skill`，可返回可用 skill 元数据。
- `Command.Service` 目前会在没有命令名冲突时，把 skill 包装成 `source: "skill"` 的 command entry。
- Web composer 会把 `source: "skill"` 的 command entry 放进 slash autocomplete。
- TUI slash autocomplete 会显式跳过 `serverCommand.source === "skill"`，所以 TUI 里 skill 不会通过 `/` 出现。
- TUI prompt parts 目前建模了 text、file 和 agent reference。`@` autocomplete 使用 extmark 把 file 和 agent mention 显示成可见装饰。
- `SessionPrompt.PromptInput` 接受 text、file、agent 和 subtask parts，但没有用于显式加载 skill 的结构化字段。

## 决策

| 决策点 | 选择 |
|---|---|
| 实现入口 | 只做 TUI。 |
| 触发方式 | 普通 prompt mode 中任意位置的 `$`。 |
| 选择结果 | 可见的 `$skill-name` mention，并由 TUI 本地 skill prompt part 追踪。 |
| 手动输入 | 只要 `$skill-name` 精确匹配已知 skill，就自动加载。 |
| 多 skill | 支持；提交前去重。 |
| 模型行为 | 选中的 skill 在 provider turn 前自动加载。 |
| Slash command | 第一版不让 slash command 参与 skill 自动加载。 |

## 架构

### TUI 输入层

扩展现有 prompt autocomplete 组件，支持第三种触发器：

```ts
type AutocompleteTrigger = "@" | "/" | "$"
```

`$` 触发器读取独立的 `sync.data.skill` 列表。候选项显示为 `$name` 加 skill description。筛选逻辑复用现有非文件候选项的 fuzzy search 行为，但只匹配 skill name 和 description。

用户选择 skill 后，textarea 中插入 `$skill-name `，同时创建一个由 extmark 支撑的 TUI 本地 prompt part：

```ts
type SkillPromptPart = {
  type: "skill"
  name: string
  source: {
    start: number
    end: number
    value: string
  }
}
```

这个 part 只存在于 TUI prompt state 和 prompt history 中。它不会作为普通后端 message part 发送。可见 prompt 文本仍然包含 `$skill-name`，所以用户可以自然地阅读和编辑。

### 同步层

在 TUI sync store 中加入 `skill`：

```ts
skill: Skill[]
```

启动同步时从现有 skill list endpoint 填充它。这样 skill autocomplete 不依赖 `sync.data.command`，避免被 command 名称冲突隐藏，也避免和 command、MCP prompt 混在一起。

### 提交层

提交普通 prompt 时，TUI 从两类来源构造显式 skill 列表：

1. `store.prompt.parts` 中 `type === "skill"` 的条目。
2. 最终可见 prompt 文本里手动输入的 `$skill-name` token。

手动解析基于 `sync.data.skill` 做精确名称匹配。为了避免部分匹配，skill 名称按长度从长到短匹配，并要求名称后面的字符不存在，或不是 skill-name 字符集的一部分。未知 dollar token，例如 `$PATH`、`$1` 和 `$FOO`，会被忽略。

最终 prompt payload 包含：

```ts
{
  // existing fields
  parts: [...],
  skills: ["brainstorming", "test-driven-development"]
}
```

Text part 仍然包含可见的 `$skill-name` token。`skills` 字段才是执行层面的权威信号。

### 后端执行层

扩展 `SessionPrompt.PromptInput`：

```ts
skills: Schema.optional(Schema.Array(Schema.String))
```

Provider turn 开始前，后端通过 `Skill.Service.require` 解析请求的 skill name。它会按当前 agent 的 skill permission rules 进行检查；如果请求的 skill 被拒绝或不存在，本轮 prompt 会清晰失败。

解析成功的 skill 会作为已加载 skill 内容追加到当前 provider turn 的 system context 中。这等价于用户为本轮显式加载 skill，但不要求模型自己决定是否调用 `skill` tool。

加载后的 skill 内容是本轮作用域：

- 它影响当前模型执行。
- 它不修改 agent。
- 它不改写用户 message body。
- 它不把已加载 skill 内容保存进用户 message body 或 agent definition。

## 数据流

```text
用户在 TUI prompt 中输入 "$bra"
  -> "$" autocomplete 打开
  -> TUI 筛选 sync.data.skill
  -> 用户选择 "brainstorming"
  -> Textarea 插入 "$brainstorming "
  -> Prompt state 存储 { type: "skill", name: "brainstorming", source }

用户提交 prompt
  -> TUI 同步 extmark 状态
  -> TUI 展开可见输入文本
  -> TUI 收集通过补全选择的 skill parts
  -> TUI 扫描文本中手动输入的已知 $skills
  -> TUI 对 skill names 去重
  -> session.prompt payload 包含 skills: [...]

后端接收 prompt
  -> PromptInput schema 接受 skills
  -> Skill.Service.require 解析每个 skill
  -> 检查 permission rules
  -> 已加载 skill sections 加入本轮 provider turn
  -> llm.stream(request) 只调用一次，并且 request 中已有 skill instructions
```

## UI 行为

- `$` autocomplete 只在普通 prompt mode 中启用。
- `$` 可以在 prompt 任意位置触发，只要光标位于当前 `$query` token 后。
- `Tab`、`Enter`、方向键，以及 `ctrl+n` / `ctrl+p` 遵循现有 autocomplete 行为。
- Skill mention 使用独立 style id，视觉上可区别于 file、agent 和 paste extmark。
- 删除可见 mention 时，现有 extmark sync 路径会移除或失效对应的本地 skill prompt part。
- Prompt history 会保留已选择的 skill mention；恢复 draft 时保持相同的视觉 affordance。

## 错误处理

- 未知的手动 `$token` 在客户端忽略。
- 如果已选择的 skill 在提交时已经失效，后端返回现有 `Skill.NotFoundError` 形态，并带 available skill 提示。
- 如果 permission 拒绝该 skill，后端让 prompt 清晰失败并发布 session error。
- 如果 skill list bootstrap 失败，TUI 仍可正常使用；`$` autocomplete 显示空结果，prompt submit 不受影响。
- Shell mode 不打开 `$` autocomplete，也不发送 `skills`。

## 测试

### TUI 单元测试

- `$` trigger 在普通 mode 中打开 skill autocomplete。
- `$` trigger 在 shell mode 中不会打开 skill autocomplete。
- Skill 候选项可按 name 和 description 筛选。
- 选择 skill 会插入 `$skill-name ` 并创建 skill prompt part。
- 恢复 prompt history 会重建 skill extmarks。
- Submit 会合并补全选择的 skill parts 和手动输入的 `$skill-name` tokens。
- Submit 会对同一个 skill 的多个引用去重。
- Submit 会忽略 `$PATH` 和 `$1` 这类未知 dollar tokens。

### 后端测试

- `SessionPrompt.PromptInput` 接受 `skills`。
- Prompt execution 会把请求的 skill 内容加载进 provider-turn context。
- 缺失的 skill 会清晰失败。
- 被拒绝的 skill 会清晰失败。
- `skills` 为空或省略时，保持现有 prompt 行为不变。

### SDK 和类型检查

- Schema 变更后，运行 `./packages/sdk/js/script/build.ts` 重新生成 JavaScript SDK。
- 从 `packages/opencode` 运行 `bun typecheck`。
- 从 `packages/tui` 运行 `bun typecheck`。

## 实现备注

- 第一版保持在 TUI 和后端 prompt execution 范围内。
- 复用 file、agent 和 pasted text parts 现有的 extmark sync 模式。
- 优先使用 TUI 本地 `SkillPromptPart` 类型，而不是新增后端 message part 类型。
- Skill 匹配保持精确、基于名称，而不是只靠正则，因为有效 skill name 来自 discovery。
- 本轮不改变 command registration 或 TUI slash behavior 中的 skill 处理。
