# TUI Skill Mention 实现计划

> **给 agentic worker：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 按任务逐个实现本计划。步骤使用 checkbox（`- [ ]`）语法跟踪进度。

**目标：** 在 opencode TUI prompt 中实现 Codex 风格的 `$skill` 补全、可见 mention、手写 `$skill-name` 解析，以及提交后自动加载 skill。

**架构：** TUI 侧新增本地 `SkillPromptPart` 和 `$` autocomplete，提交时把补全选择与手写 `$skill-name` 合并成 `skills: string[]`。后端在 `SessionPrompt.PromptInput` 接收 `skills`，创建用户消息时把指定 skill 内容写入该用户消息的 `system` 字段，使当前 provider turn 自动携带完整 skill instructions。

**技术栈：** TypeScript、SolidJS、OpenTUI extmarks、Effect、Bun test、opencode v2 SDK generator。

---

## 文件结构

- 新建 `packages/tui/src/prompt/skill.ts`
  - 定义 TUI 本地的 `SkillPromptPart` 形状。
  - 按已知 skill 名精确提取手写 `$skill-name` token。
  - 把补全选择的 skill part 与手写 token 合并去重。
- 修改 `packages/tui/src/prompt/history.tsx`
  - 让 `PromptInfo.parts` 在 draft 和 history 中保留本地 `SkillPromptPart` 条目。
- 新建 `packages/tui/test/prompt/skill.test.ts`
  - 覆盖手写提取、去重、未知 dollar token、以及补全选择的 skill parts。
- 修改 `packages/tui/src/context/sync.tsx`
  - 新增 `sync.data.skill`。
  - 通过 `sdk.client.skill.skills({ workspace })` 拉取 skill 列表。
- 修改 `packages/tui/test/fixture/tui-sdk.ts`
  - 为 TUI sync 测试新增默认的 `/skill` 响应。
- 新建 `packages/tui/test/context/sync-skill.test.tsx`
  - 验证 TUI sync 会拉取 skill 元数据。
- 修改 `packages/tui/src/component/prompt/autocomplete.tsx`
  - 把 `$` 加为 autocomplete trigger。
  - 展示 skill 候选项，并插入由 extmark 支撑的 skill mention。
- 修改 `packages/tui/src/component/prompt/index.tsx`
  - 新增 skill extmark 样式，并在 restore/sync 中持久化。
  - 把 skill part 从发给后端的 `parts` 中排除。
  - 普通 prompt 提交时发送 `skills`。
- 修改 `packages/tui/src/theme/index.ts`
  - 新增 `extmark.skill` 语法样式。
- 修改 `packages/opencode/src/session/prompt.ts`
  - 给 `PromptInput` 新增 `skills`。
  - 把显式 skill 内容加载进用户消息的 `system` 字段。
  - 新增 `Skill.defaultLayer` 与 `Skill.node` 依赖。
- 修改 `packages/opencode/test/session/prompt.test.ts`
  - 覆盖显式 skill 加载、缺失 skill 失败、权限拒绝。
- 重新生成 `packages/sdk/js/src/v2/gen/*`
  - 拾取新增的 `skills?: string[]` prompt payload 字段。

---

### 任务 1：TUI Skill Prompt 工具模块

**文件：**
- 新建：`packages/tui/src/prompt/skill.ts`
- 修改：`packages/tui/src/prompt/history.tsx`
- 测试：`packages/tui/test/prompt/skill.test.ts`

- [ ] **步骤 1：编写失败测试**

新建 `packages/tui/test/prompt/skill.test.ts`：

```ts
import { describe, expect, test } from "bun:test"
import { collectPromptSkillNames, extractSkillNamesFromPrompt, type SkillPromptPart } from "../../src/prompt/skill"

const skills = [
  { name: "brainstorming", description: "Design before implementation." },
  { name: "test-driven-development", description: "Write tests first." },
  { name: "test", description: "Short skill name." },
]

describe("prompt skill mentions", () => {
  test("extracts manually typed skill names anywhere in prompt text", () => {
    expect(extractSkillNamesFromPrompt("please use $brainstorming here", skills)).toEqual(["brainstorming"])
    expect(extractSkillNamesFromPrompt("$brainstorming then $test-driven-development", skills)).toEqual([
      "brainstorming",
      "test-driven-development",
    ])
  })

  test("ignores unknown dollar tokens and partial skill-name matches", () => {
    expect(extractSkillNamesFromPrompt("keep $PATH and $1 untouched", skills)).toEqual([])
    expect(extractSkillNamesFromPrompt("do not treat $test-driven as $test", skills)).toEqual([])
  })

  test("dedupes manual and selected skill mentions while preserving first-seen order", () => {
    const selected: SkillPromptPart = {
      type: "skill",
      name: "test-driven-development",
      source: {
        start: 0,
        end: "$test-driven-development".length,
        value: "$test-driven-development",
      },
    }

    expect(
      collectPromptSkillNames({
        parts: [selected],
        text: "$brainstorming $test-driven-development $brainstorming",
        skills,
      }),
    ).toEqual(["test-driven-development", "brainstorming"])
  })
})
```

- [ ] **步骤 2：运行新测试并确认失败**

运行：

```bash
cd packages/tui
bun test test/prompt/skill.test.ts --timeout 30000
```

预期：FAIL，因为 `../../src/prompt/skill` 不存在。

- [ ] **步骤 3：新增 TUI skill 工具模块**

新建 `packages/tui/src/prompt/skill.ts`：

```ts
export type SkillInfo = {
  name: string
  description?: string
}

export type SkillPromptPart = {
  type: "skill"
  name: string
  source: {
    start: number
    end: number
    value: string
  }
}

function isSkillNameChar(value: string | undefined) {
  return value !== undefined && /[A-Za-z0-9_-]/.test(value)
}

function uniquePush(result: string[], seen: Set<string>, name: string) {
  if (seen.has(name)) return
  seen.add(name)
  result.push(name)
}

export function extractSkillNamesFromPrompt(text: string, skills: readonly SkillInfo[]) {
  const result: string[] = []
  const seen = new Set<string>()
  const sorted = skills
    .map((skill) => skill.name)
    .filter((name) => name.length > 0)
    .toSorted((a, b) => b.length - a.length || a.localeCompare(b))

  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "$") continue

    for (const name of sorted) {
      if (!text.startsWith(name, index + 1)) continue
      if (isSkillNameChar(text[index + 1 + name.length])) continue
      uniquePush(result, seen, name)
      break
    }
  }

  return result
}

export function collectPromptSkillNames(input: {
  parts: readonly { type: string; name?: string }[]
  text: string
  skills: readonly SkillInfo[]
}) {
  const result: string[] = []
  const seen = new Set<string>()
  const known = new Set(input.skills.map((skill) => skill.name))

  for (const part of input.parts) {
    if (part.type !== "skill") continue
    if (!part.name || !known.has(part.name)) continue
    uniquePush(result, seen, part.name)
  }

  for (const name of extractSkillNamesFromPrompt(input.text, input.skills)) {
    uniquePush(result, seen, name)
  }

  return result
}
```

- [ ] **步骤 4：允许 history 中出现 skill part**

修改 `packages/tui/src/prompt/history.tsx`。

新增 import：

```ts
import type { SkillPromptPart } from "./skill"
```

把 `SkillPromptPart` 加入 `PromptInfo.parts` 联合类型：

```ts
    | SkillPromptPart
```

最终的 `parts` 联合类型包含 file part、agent part、带 pasted-text source 的 text part，以及 `SkillPromptPart`。

- [ ] **步骤 5：运行 prompt skill 测试**

运行：

```bash
cd packages/tui
bun test test/prompt/skill.test.ts --timeout 30000
```

预期：PASS。

- [ ] **步骤 6：提交**

运行：

```bash
git add packages/tui/src/prompt/skill.ts packages/tui/src/prompt/history.tsx packages/tui/test/prompt/skill.test.ts
git commit -m "feat(tui): add skill mention parsing"
```

---

### 任务 2：把 Skill 元数据同步进 TUI

**文件：**
- 修改：`packages/tui/src/context/sync.tsx`
- 修改：`packages/tui/test/fixture/tui-sdk.ts`
- 测试：`packages/tui/test/context/sync-skill.test.tsx`

- [ ] **步骤 1：编写失败的 sync 测试**

新建 `packages/tui/test/context/sync-skill.test.tsx`：

```tsx
/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { json } from "../fixture/tui-sdk"
import { mount, wait } from "../cli/cmd/tui/sync-fixture"

describe("Sync skills", () => {
  test("bootstraps skill metadata from /skill", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const { app, sync } = await mount((url) => {
      if (url.pathname !== "/skill") return
      return json([
        {
          name: "brainstorming",
          description: "Design before implementation.",
          location: "/skills/brainstorming/SKILL.md",
          content: "# Brainstorming",
        },
      ])
    }, tmp.path)

    try {
      await wait(() => sync.data.skill.length === 1)
      expect(sync.data.skill[0]?.name).toBe("brainstorming")
      expect(sync.data.skill[0]?.description).toBe("Design before implementation.")
    } finally {
      app.renderer.destroy()
    }
  })
})
```

- [ ] **步骤 2：运行 sync 测试并确认失败**

运行：

```bash
cd packages/tui
bun test test/context/sync-skill.test.tsx --timeout 30000
```

预期：FAIL，因为 `sync.data.skill` 未定义。

- [ ] **步骤 3：给 TUI sync store 新增 `skill`**

修改 `packages/tui/src/context/sync.tsx` 中的类型 import：

```ts
  AppSkillsResponse,
```

在 store 类型中、`command: Command[]` 旁边新增字段：

```ts
      skill: AppSkillsResponse
```

在初始 state 中、`command: []` 旁边新增：

```ts
      skill: [],
```

在现有 `sdk.client.command.list({ workspace })` 请求旁新增非阻塞的 bootstrap 请求：

```ts
            sdk.client.skill.skills({ workspace }).then((x) => setStore("skill", reconcile(x.data ?? []))),
```

- [ ] **步骤 4：更新 TUI SDK 测试 fixture**

修改 `packages/tui/test/fixture/tui-sdk.ts`，让 `/skill` 默认返回空数组。

修改路由数组：

```ts
      [
        "/agent",
        "/command",
        "/experimental/workspace",
        "/experimental/workspace/status",
        "/formatter",
        "/lsp",
        "/skill",
      ].includes(url.pathname)
```

- [ ] **步骤 5：运行 sync 测试**

运行：

```bash
cd packages/tui
bun test test/context/sync-skill.test.tsx --timeout 30000
```

预期：PASS。

- [ ] **步骤 6：提交**

运行：

```bash
git add packages/tui/src/context/sync.tsx packages/tui/test/fixture/tui-sdk.ts packages/tui/test/context/sync-skill.test.tsx
git commit -m "feat(tui): sync skill metadata"
```

---

### 任务 3：新增 `$` Autocomplete 与 Skill Extmark

**文件：**
- 修改：`packages/tui/src/component/prompt/autocomplete.tsx`
- 修改：`packages/tui/src/component/prompt/index.tsx`
- 修改：`packages/tui/src/theme/index.ts`
- 测试：`packages/tui/test/prompt/skill.test.ts`

- [ ] **步骤 1：扩展工具模块测试，覆盖 skill mention 的 source 区间**

在 `packages/tui/test/prompt/skill.test.ts` 末尾追加：

```ts
  test("keeps selected skill prompt part source as visible dollar text", () => {
    const selected: SkillPromptPart = {
      type: "skill",
      name: "brainstorming",
      source: {
        start: 4,
        end: 4 + "$brainstorming".length,
        value: "$brainstorming",
      },
    }

    expect(selected.source.value).toBe("$brainstorming")
    expect(selected.source.end - selected.source.start).toBe("$brainstorming".length)
  })
```

- [ ] **步骤 2：运行工具模块测试**

运行：

```bash
cd packages/tui
bun test test/prompt/skill.test.ts --timeout 30000
```

预期：PASS。这把本地 part 形状锁住，再接入 UI。

- [ ] **步骤 3：新增 skill extmark 样式**

修改 `packages/tui/src/theme/index.ts`，在现有 `extmark.file`、`extmark.agent`、`extmark.paste` scope 旁新增：

```ts
    {
      scope: ["extmark.skill"],
      style: {
        foreground: theme.accent,
        bold: true,
      },
    },
```

- [ ] **步骤 4：扩展 autocomplete 的类型与 props**

修改 `packages/tui/src/component/prompt/autocomplete.tsx`。

修改 `AutocompleteRef`：

```ts
export type AutocompleteRef = {
  onInput: (value: string) => void
  visible: false | "@" | "/" | "$"
}
```

新增 import：

```ts
import type { SkillPromptPart } from "../../prompt/skill"
```

新增 prop：

```ts
  skillStyleId: number
```

修改 `show`：

```ts
  function show(mode: "@" | "/" | "$") {
    setStore({
      visible: mode,
      index: props.input().cursorOffset,
    })
  }
```

- [ ] **步骤 5：在 autocomplete 中加入 skill 插入逻辑**

在 `packages/tui/src/component/prompt/autocomplete.tsx` 的 `insertPart` 下方新增函数：

```ts
  function insertSkill(name: string) {
    const input = props.input()
    const currentCursorOffset = input.cursorOffset
    const charAfterCursor = displayCharAt(props.value, currentCursorOffset)
    const needsSpace = charAfterCursor !== " "
    const append = "$" + name + (needsSpace ? " " : "")

    input.cursorOffset = store.index
    const startCursor = input.logicalCursor
    input.cursorOffset = currentCursorOffset
    const endCursor = input.logicalCursor

    input.deleteRange(startCursor.row, startCursor.col, endCursor.row, endCursor.col)
    input.insertText(append)

    const virtualText = "$" + name
    const extmarkStart = store.index
    const extmarkEnd = extmarkStart + Bun.stringWidth(virtualText)
    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: props.skillStyleId,
      typeId: props.promptPartTypeId(),
    })

    props.setPrompt((draft) => {
      const partIndex = draft.parts.length
      draft.parts.push({
        type: "skill",
        name,
        source: {
          start: extmarkStart,
          end: extmarkEnd,
          value: virtualText,
        },
      } satisfies SkillPromptPart)
      props.setExtmark(partIndex, extmarkId)
    })
  }
```

- [ ] **步骤 6：新增 skill autocomplete 候选项**

在 `packages/tui/src/component/prompt/autocomplete.tsx` 的 `commands` 旁新增 memo：

```ts
  const skills = createMemo((): AutocompleteOption[] =>
    sync.data.skill
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((skill) => ({
        display: "$" + skill.name,
        value: skill.name,
        description: skill.description,
        onSelect: () => insertSkill(skill.name),
      })),
  )
```

修改 `options`，让非文件候选项按 trigger 选择：

```ts
    const nonFileOptions: AutocompleteOption[] =
      store.visible === "@"
        ? [...referenceAliasesValue, ...agentsValue, ...mcpResources()]
        : store.visible === "$"
          ? skills()
          : [...commandsValue]
```

保留现有只在 `/` 下启用 `description` fuzzy key 的行为：

```ts
          ...(store.visible === "/" ? ["description" as const] : []),
```

- [ ] **步骤 7：新增 `$` trigger 检测**

在传给 `props.ref` 的 `onInput(value)` 函数中，slash 检测之后、`@` 检测之前，新增：

```ts
        const dollarIndex = value.slice(0, offset).search(/\$[^\s$]*$/)
        if (dollarIndex !== -1) {
          show("$")
          setStore("index", dollarIndex)
          return
        }
```

这里不改 shell mode；`Prompt` 只在普通 prompt 特性允许时才调用 autocomplete。

- [ ] **步骤 8：把 skill extmark 接入 prompt index**

修改 `packages/tui/src/component/prompt/index.tsx`。

在现有 extmark 样式旁新增 style id：

```ts
  const skillStyleId = syntax().getStyleId("extmark.skill") ?? agentStyleId
```

在 `restoreExtmarksFromParts` 中新增：

```ts
      } else if (part.type === "skill") {
        start = part.source.start
        end = part.source.end
        virtualText = part.source.value
        styleId = skillStyleId
```

在 `syncExtmarksWithPromptParts` 中新增：

```ts
              } else if (part.type === "skill") {
                part.source.start = extmark.start
                part.source.end = extmark.end
```

把 prop 传入 `<Autocomplete />`：

```tsx
        skillStyleId={skillStyleId}
```

- [ ] **步骤 9：运行 TUI typecheck**

运行：

```bash
cd packages/tui
bun typecheck
```

预期：PASS。

- [ ] **步骤 10：提交**

运行：

```bash
git add packages/tui/src/component/prompt/autocomplete.tsx packages/tui/src/component/prompt/index.tsx packages/tui/src/theme/index.ts packages/tui/test/prompt/skill.test.ts
git commit -m "feat(tui): add skill mention autocomplete"
```

---

### 任务 4：提交 prompt 时发送显式 skills

**文件：**
- 修改：`packages/tui/src/component/prompt/index.tsx`
- 测试：`packages/tui/test/prompt/skill.test.ts`

- [ ] **步骤 1：扩展工具模块测试，覆盖后端请求过滤**

在 `packages/tui/test/prompt/skill.test.ts` 末尾追加：

```ts
  test("collects only known skill names for backend payload", () => {
    expect(
      collectPromptSkillNames({
        parts: [
          {
            type: "skill",
            name: "brainstorming",
            source: { start: 0, end: "$brainstorming".length, value: "$brainstorming" },
          },
          { type: "agent", name: "build" },
        ],
        text: "$unknown $test",
        skills,
      }),
    ).toEqual(["brainstorming", "test"])
  })
```

- [ ] **步骤 2：运行工具模块测试**

运行：

```bash
cd packages/tui
bun test test/prompt/skill.test.ts --timeout 30000
```

预期：PASS。

- [ ] **步骤 3：在 prompt index 中 import skill 收集函数**

修改 `packages/tui/src/component/prompt/index.tsx`：

```ts
import { collectPromptSkillNames } from "../../prompt/skill"
```

- [ ] **步骤 4：收集 skills，并把本地 skill part 从后端 parts 中排除**

在 `submitInner` 中、`nonTextParts` 定义之后，新增：

```ts
    const promptSkills = collectPromptSkillNames({
      parts: nonTextParts,
      text: inputText,
      skills: sync.data.skill,
    })
    const requestParts = nonTextParts.filter((part) => part.type !== "skill")
```

在 command 分支中，仍只发送 file part：

```ts
        parts: requestParts.filter((x) => x.type === "file"),
```

在普通 prompt 分支中，把 `...nonTextParts` 替换成 `...requestParts`，并新增 `skills`：

```ts
            skills: promptSkills,
            parts: [
              ...editorParts,
              {
                type: "text",
                text: inputText,
              },
              ...requestParts,
            ],
```

- [ ] **步骤 5：运行聚焦测试与 typecheck**

运行：

```bash
cd packages/tui
bun test test/prompt/skill.test.ts --timeout 30000
bun typecheck
```

预期：两者都 PASS。

- [ ] **步骤 6：提交**

运行：

```bash
git add packages/tui/src/component/prompt/index.tsx packages/tui/test/prompt/skill.test.ts
git commit -m "feat(tui): send selected skills with prompts"
```

---

### 任务 5：后端 Prompt 自动加载显式 skills

**文件：**
- 修改：`packages/opencode/src/session/prompt.ts`
- 测试：`packages/opencode/test/session/prompt.test.ts`

- [ ] **步骤 1：编写后端测试**

在 `packages/opencode/test/session/prompt.test.ts` 中、其它 prompt/loop provider request 测试旁追加：

```ts
it.instance("prompt loads explicit skills into the next provider request", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig(providerCfg)
    yield* writeText(
      path.join(dir, ".opencode", "skill", "selected-skill", "SKILL.md"),
      [
        "---",
        "name: selected-skill",
        "description: Selected skill.",
        "---",
        "",
        "# Selected Skill",
        "",
        "Always say selected skill instructions are loaded.",
      ].join("\n"),
    )

    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Skill prompt",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* llm.text("done")
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      model: ref,
      parts: [{ type: "text", text: "Use $selected-skill for this task" }],
      skills: ["selected-skill"],
    })

    const hit = (yield* llm.hits)[0]
    const messages = hit?.body.messages as Array<{ role: string; content: string }>
    const system = messages.find((message) => message.role === "system")?.content ?? ""

    expect(system).toContain('<loaded_skill name="selected-skill">')
    expect(system).toContain("# Selected Skill")
    expect(system).toContain("Always say selected skill instructions are loaded.")
  }),
)

noLLMServer.instance("prompt fails clearly when an explicit skill is missing", () =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Missing skill" })

    const exit = yield* prompt
      .prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        noReply: true,
        parts: [{ type: "text", text: "Use $missing-skill" }],
        skills: ["missing-skill"],
      })
      .pipe(Effect.exit)

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).toContain('Skill "missing-skill" not found.')
    }
  }),
)

noLLMServer.instance("prompt fails clearly when an explicit skill is denied", () =>
  Effect.gen(function* () {
    const { directory: dir } = yield* TestInstance
    yield* writeText(
      path.join(dir, ".opencode", "skill", "denied-skill", "SKILL.md"),
      ["---", "name: denied-skill", "description: Denied skill.", "---", "", "# Denied Skill"].join("\n"),
    )
    yield* writeConfig(dir, {
      agent: {
        build: {
          permission: {
            skill: {
              "denied-skill": "deny",
            },
          },
        },
      },
    })

    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Denied skill" })

    const exit = yield* prompt
      .prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        noReply: true,
        parts: [{ type: "text", text: "Use $denied-skill" }],
        skills: ["denied-skill"],
      })
      .pipe(Effect.exit)

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).toContain('Skill "denied-skill" is denied by permissions.')
    }
  }),
)
```

- [ ] **步骤 2：运行后端测试并确认失败**

运行：

```bash
cd packages/opencode
bun test test/session/prompt.test.ts --timeout 30000
```

预期：FAIL，因为 `PromptInput` 不接受 `skills`，且显式 skills 未被加载。

- [ ] **步骤 3：新增 Skill 服务依赖**

修改 `packages/opencode/src/session/prompt.ts`。

新增 import：

```ts
import { Skill } from "../skill"
```

在 `Layer.effect` body 内新增：

```ts
    const skillSvc = yield* Skill.Service
```

在 `defaultLayer` 中、`Command.defaultLayer` 旁新增 `Layer.provide(Skill.defaultLayer)`。

在 `node` 依赖数组中、`Command.node` 旁新增 `Skill.node`。

- [ ] **步骤 4：新增已加载 skill 的格式化与权限检查**

在 `export const layer = Layer.effect` 声明上方新增这些 helper：

```ts
function explicitSkillSystem(info: Skill.Info) {
  const dir = path.dirname(info.location)
  const base = pathToFileURL(dir).href
  return [
    `<loaded_skill name="${info.name}">`,
    `# Skill: ${info.name}`,
    "",
    info.content.trim(),
    "",
    `Base directory for this skill: ${base}`,
    "Relative paths in this skill are relative to this base directory.",
    "</loaded_skill>",
  ].join("\n")
}

function mergeSystemParts(parts: Array<string | undefined>) {
  const system = parts.filter((part): part is string => !!part?.trim()).join("\n\n")
  return system.length > 0 ? system : undefined
}
```

在 layer 内、`createUserMessage` 之前新增这个 effect helper：

```ts
    const loadExplicitSkills = Effect.fn("SessionPrompt.loadExplicitSkills")(function* (input: {
      sessionID: SessionID
      agent: Agent.Info
      names?: readonly string[]
    }) {
      const names = [...new Set(input.names ?? [])]
      const sections: string[] = []

      for (const name of names) {
        if (Permission.evaluate("skill", name, input.agent.permission).action === "deny") {
          const error = new NamedError.Unknown({ message: `Skill "${name}" is denied by permissions.` })
          yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
          throw error
        }

        const info = yield* skillSvc.require(name).pipe(
          Effect.catchTag("Skill.NotFoundError", (err) =>
            Effect.gen(function* () {
              const error = new NamedError.Unknown({ message: err.message })
              yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
              throw error
            }),
          ),
        )
        sections.push(explicitSkillSystem(info))
      }

      return sections.length > 0 ? sections.join("\n\n") : undefined
    })
```

- [ ] **步骤 5：把已加载 skills 写进用户消息的 system 字段**

在 `createUserMessage` 中、`variant` 计算之后、`SessionV1.User` 对象创建之前，新增：

```ts
      const explicitSkills = yield* loadExplicitSkills({
        sessionID: input.sessionID,
        agent: ag,
        names: input.skills,
      })
```

修改 `info` 中的 `system` 属性：

```ts
        system: mergeSystemParts([input.system, explicitSkills]),
```

- [ ] **步骤 6：扩展 PromptInput schema**

在 `packages/opencode/src/session/prompt.ts` 中给 `PromptInput` 新增 `skills`：

```ts
  skills: Schema.optional(Schema.Array(Schema.String)),
```

- [ ] **步骤 7：运行后端测试**

运行：

```bash
cd packages/opencode
bun test test/session/prompt.test.ts --timeout 30000
```

预期：PASS。

- [ ] **步骤 8：提交**

运行：

```bash
git add packages/opencode/src/session/prompt.ts packages/opencode/test/session/prompt.test.ts
git commit -m "feat(opencode): auto-load prompt skills"
```

---

### 任务 6：重新生成 JavaScript SDK

**文件：**
- 修改 `packages/sdk/js/src/v2/gen/` 下的生成文件

- [ ] **步骤 1：重新生成 SDK**

在 repo 根目录运行：

```bash
./packages/sdk/js/script/build.ts
```

预期：生成的 SDK 文件更新，session prompt payload 包含 `skills?: Array<string>`。

- [ ] **步骤 2：检查生成的 diff**

运行：

```bash
git diff -- packages/sdk/js/src/v2/gen/types.gen.ts packages/sdk/js/src/v2/gen/sdk.gen.ts | rg -n "skills|Prompt"
```

预期：diff 中包含 session prompt data 新增的可选 `skills` payload 字段，不应包含无关 endpoint 的变更。

- [ ] **步骤 3：提交**

运行：

```bash
git add packages/sdk/js/src/v2/gen
git commit -m "chore(sdk): regenerate prompt skill types"
```

---

### 任务 7：最终验证

**文件：**
- 验证任务 1–6 改动的全部文件。

- [ ] **步骤 1：运行 TUI 聚焦测试**

运行：

```bash
cd packages/tui
bun test test/prompt/skill.test.ts test/context/sync-skill.test.tsx --timeout 30000
```

预期：PASS。

- [ ] **步骤 2：运行后端聚焦测试**

运行：

```bash
cd packages/opencode
bun test test/session/prompt.test.ts --timeout 30000
```

预期：PASS。

- [ ] **步骤 3：TUI typecheck**

运行：

```bash
cd packages/tui
bun typecheck
```

预期：PASS。

- [ ] **步骤 4：opencode typecheck**

运行：

```bash
cd packages/opencode
bun typecheck
```

预期：PASS。

- [ ] **步骤 5：审查最终 diff**

运行：

```bash
git status --short
git diff --stat origin/dev...HEAD
```

预期：只改动 TUI prompt/sync/theme 测试、后端 prompt 测试、生成的 SDK，以及本特性的 docs/plans。

- [ ] **步骤 6：确认没有未提交的验证产物**

运行：

```bash
git status --short
```

预期：无输出。如果该命令打印出文件，用 `git diff` 检查，并按 conventional commit 提交有意的生成改动，或只还原非预期的验证产物。

---

## 自检

**Spec 覆盖：** 本计划覆盖了仅 TUI 的 `$` trigger、可见 mention、prompt history restore、多 skill、手写 `$skill-name` 提取、未知 token 忽略行为、通过普通 prompt autocomplete 行为实现的 shell mode 排除、后端 `skills` payload、自动 skill 加载、缺失 skill 报错、拒绝 skill 报错、SDK 重新生成，以及包内 typecheck。

**风险扫描：** 本计划包含具体的文件、命令、代码片段、测试名与提交命令，不使用延迟实现的描述。

**类型一致性：** TUI 本地 part 统一命名为 `SkillPromptPart`，`type: "skill"`；同步的 skill 列表统一命名为 `sync.data.skill`；后端 payload 统一命名为 `skills`；后端显式加载通过 `SessionV1.User.system` 存储格式化后的 skill 内容。
