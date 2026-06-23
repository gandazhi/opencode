# TUI Skill Mentions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 opencode TUI prompt 中实现 Codex 风格的 `$skill` 补全、可见 mention、手动 `$skill-name` 解析，以及提交后自动加载 skill。

**Architecture:** TUI 侧新增本地 `SkillPromptPart` 和 `$` autocomplete，提交时把补全选择与手写 `$skill-name` 合并成 `skills: string[]`。后端在 `SessionPrompt.PromptInput` 接收 `skills`，创建用户消息时把指定 skill 内容写入该用户消息的 `system` 字段，使当前 provider turn 自动携带完整 skill instructions。

**Tech Stack:** TypeScript, SolidJS, OpenTUI extmarks, Effect, Bun test, opencode v2 SDK generator.

---

## File Structure

- Create `packages/tui/src/prompt/skill.ts`
  - Defines the local TUI `SkillPromptPart` shape.
  - Extracts manually typed `$skill-name` tokens by exact known-skill names.
  - Combines selected skill parts and manual tokens into a deduped list.
- Modify `packages/tui/src/prompt/history.tsx`
  - Allows `PromptInfo.parts` to retain local `SkillPromptPart` entries in drafts and history.
- Create `packages/tui/test/prompt/skill.test.ts`
  - Covers manual extraction, dedupe, unknown dollar tokens, and selected skill parts.
- Modify `packages/tui/src/context/sync.tsx`
  - Adds `sync.data.skill`.
  - Bootstraps skills via `sdk.client.skill.skills({ workspace })`.
- Modify `packages/tui/test/fixture/tui-sdk.ts`
  - Adds default `/skill` response for TUI sync tests.
- Create `packages/tui/test/context/sync-skill.test.tsx`
  - Proves TUI sync bootstraps skill metadata.
- Modify `packages/tui/src/component/prompt/autocomplete.tsx`
  - Adds `$` as an autocomplete trigger.
  - Displays skill candidates and inserts extmark-backed skill mentions.
- Modify `packages/tui/src/component/prompt/index.tsx`
  - Adds skill extmark styling and persistence through restore/sync.
  - Excludes skill parts from backend `parts`.
  - Sends `skills` on normal prompt submission.
- Modify `packages/tui/src/theme/index.ts`
  - Adds `extmark.skill` syntax style.
- Modify `packages/opencode/src/session/prompt.ts`
  - Adds `skills` to `PromptInput`.
  - Loads explicit skill contents into the user message `system` field.
  - Adds `Skill.defaultLayer` and `Skill.node` dependencies.
- Modify `packages/opencode/test/session/prompt.test.ts`
  - Covers explicit skill loading, missing skill failure, and permission denial.
- Regenerate `packages/sdk/js/src/v2/gen/*`
  - Picks up the new `skills?: string[]` prompt payload field.

---

### Task 1: TUI Skill Prompt Utilities

**Files:**
- Create: `packages/tui/src/prompt/skill.ts`
- Modify: `packages/tui/src/prompt/history.tsx`
- Test: `packages/tui/test/prompt/skill.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/tui/test/prompt/skill.test.ts`:

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

- [ ] **Step 2: Run the new test and verify it fails**

Run:

```bash
cd packages/tui
bun test test/prompt/skill.test.ts --timeout 30000
```

Expected: FAIL because `../../src/prompt/skill` does not exist.

- [ ] **Step 3: Add the TUI skill utility module**

Create `packages/tui/src/prompt/skill.ts`:

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

- [ ] **Step 4: Allow skill parts in prompt history**

Modify `packages/tui/src/prompt/history.tsx`.

Add the import:

```ts
import type { SkillPromptPart } from "./skill"
```

Add `SkillPromptPart` to the `PromptInfo.parts` union:

```ts
    | SkillPromptPart
```

The resulting `parts` union includes file parts, agent parts, text parts with pasted-text source, and `SkillPromptPart`.

- [ ] **Step 5: Run the prompt skill tests**

Run:

```bash
cd packages/tui
bun test test/prompt/skill.test.ts --timeout 30000
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add packages/tui/src/prompt/skill.ts packages/tui/src/prompt/history.tsx packages/tui/test/prompt/skill.test.ts
git commit -m "feat(tui): add skill mention parsing"
```

---

### Task 2: Sync Skill Metadata Into TUI

**Files:**
- Modify: `packages/tui/src/context/sync.tsx`
- Modify: `packages/tui/test/fixture/tui-sdk.ts`
- Test: `packages/tui/test/context/sync-skill.test.tsx`

- [ ] **Step 1: Write the failing sync test**

Create `packages/tui/test/context/sync-skill.test.tsx`:

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

- [ ] **Step 2: Run the sync test and verify it fails**

Run:

```bash
cd packages/tui
bun test test/context/sync-skill.test.tsx --timeout 30000
```

Expected: FAIL because `sync.data.skill` is not defined.

- [ ] **Step 3: Add `skill` to the TUI sync store**

Modify the type import in `packages/tui/src/context/sync.tsx`:

```ts
  AppSkillsResponse,
```

Add this field next to `command: Command[]` in the store type:

```ts
      skill: AppSkillsResponse
```

Add this initial state next to `command: []`:

```ts
      skill: [],
```

Add this non-blocking bootstrap request next to the existing `sdk.client.command.list({ workspace })` request:

```ts
            sdk.client.skill.skills({ workspace }).then((x) => setStore("skill", reconcile(x.data ?? []))),
```

- [ ] **Step 4: Update the TUI SDK test fixture**

Modify `packages/tui/test/fixture/tui-sdk.ts` so `/skill` returns an empty array by default.

Change the route array:

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

- [ ] **Step 5: Run the sync test**

Run:

```bash
cd packages/tui
bun test test/context/sync-skill.test.tsx --timeout 30000
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add packages/tui/src/context/sync.tsx packages/tui/test/fixture/tui-sdk.ts packages/tui/test/context/sync-skill.test.tsx
git commit -m "feat(tui): sync skill metadata"
```

---

### Task 3: Add `$` Autocomplete And Skill Extmarks

**Files:**
- Modify: `packages/tui/src/component/prompt/autocomplete.tsx`
- Modify: `packages/tui/src/component/prompt/index.tsx`
- Modify: `packages/tui/src/theme/index.ts`
- Test: `packages/tui/test/prompt/skill.test.ts`

- [ ] **Step 1: Extend the utility test for skill mention source ranges**

Append this test to `packages/tui/test/prompt/skill.test.ts`:

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

- [ ] **Step 2: Run the utility test**

Run:

```bash
cd packages/tui
bun test test/prompt/skill.test.ts --timeout 30000
```

Expected: PASS. This locks the local part shape before wiring it into the UI.

- [ ] **Step 3: Add the skill extmark style**

Modify `packages/tui/src/theme/index.ts` near the existing `extmark.file`, `extmark.agent`, and `extmark.paste` scopes:

```ts
    {
      scope: ["extmark.skill"],
      style: {
        foreground: theme.accent,
        bold: true,
      },
    },
```

- [ ] **Step 4: Extend autocomplete types and props**

Modify `packages/tui/src/component/prompt/autocomplete.tsx`.

Change `AutocompleteRef`:

```ts
export type AutocompleteRef = {
  onInput: (value: string) => void
  visible: false | "@" | "/" | "$"
}
```

Add this import:

```ts
import type { SkillPromptPart } from "../../prompt/skill"
```

Add this prop:

```ts
  skillStyleId: number
```

Change `show`:

```ts
  function show(mode: "@" | "/" | "$") {
    setStore({
      visible: mode,
      index: props.input().cursorOffset,
    })
  }
```

- [ ] **Step 5: Add skill insertion to autocomplete**

Add this function in `packages/tui/src/component/prompt/autocomplete.tsx` below `insertPart`:

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

- [ ] **Step 6: Add skill autocomplete options**

Add this memo in `packages/tui/src/component/prompt/autocomplete.tsx` near `commands`:

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

Modify `options` so non-file options are selected by trigger:

```ts
    const nonFileOptions: AutocompleteOption[] =
      store.visible === "@"
        ? [...referenceAliasesValue, ...agentsValue, ...mcpResources()]
        : store.visible === "$"
          ? skills()
          : [...commandsValue]
```

Keep the existing `description` fuzzy key active for `/` only:

```ts
          ...(store.visible === "/" ? ["description" as const] : []),
```

- [ ] **Step 7: Add `$` trigger detection**

In the `onInput(value)` function passed to `props.ref`, after slash detection and before `@` detection, add:

```ts
        const dollarIndex = value.slice(0, offset).search(/\$[^\s$]*$/)
        if (dollarIndex !== -1) {
          show("$")
          setStore("index", dollarIndex)
          return
        }
```

Do not change shell mode here; `Prompt` only calls autocomplete while normal prompt traits allow it.

- [ ] **Step 8: Wire skill extmarks through prompt index**

Modify `packages/tui/src/component/prompt/index.tsx`.

Add the style id next to existing extmark styles:

```ts
  const skillStyleId = syntax().getStyleId("extmark.skill") ?? agentStyleId
```

In `restoreExtmarksFromParts`, add:

```ts
      } else if (part.type === "skill") {
        start = part.source.start
        end = part.source.end
        virtualText = part.source.value
        styleId = skillStyleId
```

In `syncExtmarksWithPromptParts`, add:

```ts
              } else if (part.type === "skill") {
                part.source.start = extmark.start
                part.source.end = extmark.end
```

Pass the prop into `<Autocomplete />`:

```tsx
        skillStyleId={skillStyleId}
```

- [ ] **Step 9: Run TUI typecheck**

Run:

```bash
cd packages/tui
bun typecheck
```

Expected: PASS.

- [ ] **Step 10: Commit**

Run:

```bash
git add packages/tui/src/component/prompt/autocomplete.tsx packages/tui/src/component/prompt/index.tsx packages/tui/src/theme/index.ts packages/tui/test/prompt/skill.test.ts
git commit -m "feat(tui): add skill mention autocomplete"
```

---

### Task 4: Send Explicit Skills On Prompt Submit

**Files:**
- Modify: `packages/tui/src/component/prompt/index.tsx`
- Test: `packages/tui/test/prompt/skill.test.ts`

- [ ] **Step 1: Extend utility tests for backend request filtering**

Append this test to `packages/tui/test/prompt/skill.test.ts`:

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

- [ ] **Step 2: Run utility tests**

Run:

```bash
cd packages/tui
bun test test/prompt/skill.test.ts --timeout 30000
```

Expected: PASS.

- [ ] **Step 3: Import skill collection in prompt index**

Modify `packages/tui/src/component/prompt/index.tsx`:

```ts
import { collectPromptSkillNames } from "../../prompt/skill"
```

- [ ] **Step 4: Collect skills and exclude local skill parts from backend parts**

In `submitInner`, after `nonTextParts` is defined, add:

```ts
    const promptSkills = collectPromptSkillNames({
      parts: nonTextParts,
      text: inputText,
      skills: sync.data.skill,
    })
    const requestParts = nonTextParts.filter((part) => part.type !== "skill")
```

In the command branch, keep sending only file parts:

```ts
        parts: requestParts.filter((x) => x.type === "file"),
```

In the normal prompt branch, replace `...nonTextParts` with `...requestParts` and add `skills`:

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

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
cd packages/tui
bun test test/prompt/skill.test.ts --timeout 30000
bun typecheck
```

Expected: both PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add packages/tui/src/component/prompt/index.tsx packages/tui/test/prompt/skill.test.ts
git commit -m "feat(tui): send selected skills with prompts"
```

---

### Task 5: Backend Prompt Auto-Loads Explicit Skills

**Files:**
- Modify: `packages/opencode/src/session/prompt.ts`
- Test: `packages/opencode/test/session/prompt.test.ts`

- [ ] **Step 1: Write backend tests**

Append these tests near the other prompt/loop provider request tests in `packages/opencode/test/session/prompt.test.ts`:

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

- [ ] **Step 2: Run backend tests and verify they fail**

Run:

```bash
cd packages/opencode
bun test test/session/prompt.test.ts --timeout 30000
```

Expected: FAIL because `PromptInput` does not accept `skills` and explicit skills are not loaded.

- [ ] **Step 3: Add the Skill service dependency**

Modify `packages/opencode/src/session/prompt.ts`.

Add the import:

```ts
import { Skill } from "../skill"
```

Inside the `Layer.effect` body, add:

```ts
    const skillSvc = yield* Skill.Service
```

Add `Layer.provide(Skill.defaultLayer)` to `defaultLayer` near `Command.defaultLayer`.

Add `Skill.node` to the `node` dependency array near `Command.node`.

- [ ] **Step 4: Add loaded skill formatting and permission checks**

Add these helpers above the `export const layer = Layer.effect` declaration:

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

Inside the layer, add this effect helper before `createUserMessage`:

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

- [ ] **Step 5: Store loaded skills on the user message system field**

In `createUserMessage`, after `variant` is computed and before the `SessionV1.User` object is created, add:

```ts
      const explicitSkills = yield* loadExplicitSkills({
        sessionID: input.sessionID,
        agent: ag,
        names: input.skills,
      })
```

Change the `system` property in `info`:

```ts
        system: mergeSystemParts([input.system, explicitSkills]),
```

- [ ] **Step 6: Extend the PromptInput schema**

In `packages/opencode/src/session/prompt.ts`, add `skills` to `PromptInput`:

```ts
  skills: Schema.optional(Schema.Array(Schema.String)),
```

- [ ] **Step 7: Run backend tests**

Run:

```bash
cd packages/opencode
bun test test/session/prompt.test.ts --timeout 30000
```

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```bash
git add packages/opencode/src/session/prompt.ts packages/opencode/test/session/prompt.test.ts
git commit -m "feat(opencode): auto-load prompt skills"
```

---

### Task 6: Regenerate JavaScript SDK

**Files:**
- Modify generated SDK files under `packages/sdk/js/src/v2/gen/`

- [ ] **Step 1: Regenerate SDK**

Run from the repo root:

```bash
./packages/sdk/js/script/build.ts
```

Expected: generated SDK files update so the session prompt payload includes `skills?: Array<string>`.

- [ ] **Step 2: Inspect generated diff**

Run:

```bash
git diff -- packages/sdk/js/src/v2/gen/types.gen.ts packages/sdk/js/src/v2/gen/sdk.gen.ts | rg -n "skills|Prompt"
```

Expected: diff contains a new optional `skills` payload field for session prompt data. It should not contain unrelated endpoint changes.

- [ ] **Step 3: Commit**

Run:

```bash
git add packages/sdk/js/src/v2/gen
git commit -m "chore(sdk): regenerate prompt skill types"
```

---

### Task 7: Final Verification

**Files:**
- Verify all files changed by Tasks 1-6.

- [ ] **Step 1: Run focused TUI tests**

Run:

```bash
cd packages/tui
bun test test/prompt/skill.test.ts test/context/sync-skill.test.tsx --timeout 30000
```

Expected: PASS.

- [ ] **Step 2: Run focused backend tests**

Run:

```bash
cd packages/opencode
bun test test/session/prompt.test.ts --timeout 30000
```

Expected: PASS.

- [ ] **Step 3: Typecheck TUI**

Run:

```bash
cd packages/tui
bun typecheck
```

Expected: PASS.

- [ ] **Step 4: Typecheck opencode**

Run:

```bash
cd packages/opencode
bun typecheck
```

Expected: PASS.

- [ ] **Step 5: Review final diff**

Run:

```bash
git status --short
git diff --stat origin/dev...HEAD
```

Expected: only TUI prompt/sync/theme tests, backend prompt tests, generated SDK, and this feature's docs/plans are changed.

- [ ] **Step 6: Confirm there is no uncommitted verification output**

Run:

```bash
git status --short
```

Expected: no output. If this command prints files, inspect them with `git diff` and either commit intentional generated changes with a conventional commit message or revert only the unintended verification output.

---

## Self-Review

**Spec coverage:** The plan covers TUI-only `$` trigger, visible mention, prompt history restore, multiple skills, manual `$skill-name` extraction, unknown token ignore behavior, shell mode exclusion through normal prompt autocomplete behavior, backend `skills` payload, automatic skill loading, missing skill errors, denied skill errors, SDK regeneration, and package-local typechecks.

**Red-flag scan:** This plan contains concrete files, commands, snippets, test names, and commit commands. It does not use deferred implementation instructions.

**Type consistency:** The local TUI part is consistently named `SkillPromptPart` with `type: "skill"`. The synced skill list is consistently named `sync.data.skill`. The backend payload is consistently named `skills`, and backend explicit loading stores formatted skill content through `SessionV1.User.system`.
