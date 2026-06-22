# TUI Skill Mentions With `$` Autocomplete - Design

**Date:** 2026-06-22
**Status:** Approved (brainstorm complete)

## Goal

Add a Codex-like `$` skill picker to the opencode TUI prompt. Users can type `$` anywhere in a normal prompt, select one or more skills, see them as visible `$skill-name` mentions, and have those skills automatically loaded for the next model turn.

The first implementation is TUI-only. It should keep skill selection separate from slash commands and should work both for autocomplete-selected skills and manually typed `$skill-name` tokens.

## Non-Goals

- Do not implement Web or desktop composer support in this cycle.
- Do not support skill mentions in shell mode.
- Do not convert `$skill` into a slash command.
- Do not paste skill content into the visible user prompt.
- Do not persist skill mentions as a new historical message part on the backend in this cycle.

## Current State

- Skills are discovered by `packages/opencode/src/skill/index.ts` and exposed through `Skill.Service`.
- `GET /skill` already exists in the instance HTTP API and returns available skill metadata.
- `Command.Service` currently wraps skills as command entries with `source: "skill"` when there is no command name conflict.
- The Web composer includes command entries with `source: "skill"` in slash autocomplete.
- The TUI slash autocomplete explicitly skips `serverCommand.source === "skill"`, so skills are not presented through `/` in TUI.
- TUI prompt parts currently model text, file, and agent references. `@` autocomplete uses extmarks to show file and agent mentions as visible prompt decorations.
- `SessionPrompt.PromptInput` accepts text, file, agent, and subtask parts, but has no structured field for explicit skill loading.

## Decisions

| Decision | Choice |
|---|---|
| Surface | TUI only. |
| Trigger | `$` in normal prompt mode, at any cursor position. |
| Selection result | Visible `$skill-name` mention backed by a local TUI skill prompt part. |
| Manual typing | Manually typed `$skill-name` loads if it exactly matches a known skill. |
| Multiple skills | Supported. Skills are deduplicated before submit. |
| Model behavior | Selected skills are automatically loaded before the provider turn. |
| Slash commands | Out of scope for skill auto-loading in this first pass. |

## Architecture

### TUI input layer

Extend the existing prompt autocomplete component to support a third trigger:

```ts
type AutocompleteTrigger = "@" | "/" | "$"
```

The `$` trigger reads from a dedicated `sync.data.skill` list. It shows options as `$name` plus the skill description. Filtering uses the existing fuzzy search behavior for non-file autocomplete results, but only skill names and descriptions participate.

Selecting a skill inserts `$skill-name ` into the textarea and creates an extmark-backed local prompt part:

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

This part is local to the TUI prompt state and prompt history. It is not sent as a normal backend message part. The visible prompt text still contains `$skill-name`, so the user can read and edit the prompt naturally.

### Sync layer

Add `skill` to the TUI sync store:

```ts
skill: Skill[]
```

Bootstrap fills it from the existing skill list endpoint. This keeps skill autocomplete independent from `sync.data.command`, where skills can be hidden by name conflicts or mixed with commands and MCP prompts.

### Submit layer

When submitting a normal prompt, TUI builds the explicit skill list from two sources:

1. `store.prompt.parts` entries with `type === "skill"`.
2. Manual `$skill-name` tokens in the final visible prompt text.

Manual parsing is exact-name based against `sync.data.skill`. To avoid partial matches, names are matched longest-first and require the character after the name to be absent or not part of the skill-name character set. Unknown dollar tokens such as `$PATH`, `$1`, and `$FOO` are ignored.

The final prompt payload includes:

```ts
{
  // existing fields
  parts: [...],
  skills: ["brainstorming", "test-driven-development"]
}
```

The text part still includes the visible `$skill-name` tokens. The `skills` field is the authoritative execution signal.

### Backend execution layer

Extend `SessionPrompt.PromptInput`:

```ts
skills: Schema.optional(Schema.Array(Schema.String))
```

Before the provider turn, the backend resolves the requested names through `Skill.Service.require`. It evaluates the active agent's skill permission rules and fails clearly if a requested skill is denied or missing.

Resolved skills are appended to the current provider-turn system context as loaded skill content. This is equivalent to the user explicitly loading the skill for this turn, without requiring the model to decide whether to call the `skill` tool.

The loaded skill content is turn-scoped:

- It affects the current model execution.
- It does not mutate the agent.
- It does not rewrite the user message body.
- It does not save loaded skill content into the user message body or agent definition.

## Data Flow

```text
User types "$bra" in TUI prompt
  -> Autocomplete trigger "$" opens
  -> TUI filters sync.data.skill
  -> User selects "brainstorming"
  -> Textarea inserts "$brainstorming "
  -> Prompt state stores { type: "skill", name: "brainstorming", source }

User submits prompt
  -> TUI syncs extmarks
  -> TUI expands visible input text
  -> TUI collects selected skill parts
  -> TUI scans text for manually typed known $skills
  -> TUI dedupes skill names
  -> session.prompt payload includes skills: [...]

Backend receives prompt
  -> PromptInput schema accepts skills
  -> Skill.Service.require resolves each skill
  -> Permission rules are checked
  -> Loaded skill sections are added to this provider turn
  -> llm.stream(request) runs once with skill instructions present
```

## UI Behavior

- `$` autocomplete is enabled only in normal prompt mode.
- `$` can trigger anywhere in the prompt as long as the cursor is after the current `$query` token.
- `Tab`, `Enter`, arrow keys, and `ctrl+n` / `ctrl+p` follow the existing autocomplete behavior.
- Skill mentions use their own style id so they can be visually distinct from file, agent, and paste extmarks.
- Deleting the visible mention removes or invalidates the corresponding local skill prompt part through the existing extmark sync path.
- Prompt history preserves selected skill mentions so restored drafts keep the same visual affordance.

## Error Handling

- Unknown manually typed `$token` values are ignored client-side.
- If a selected skill is stale by submit time, backend returns the existing `Skill.NotFoundError` shape with available skill hints.
- If permission denies the skill, backend fails the prompt with a clear session error.
- If skill list bootstrap fails, TUI still works normally; `$` autocomplete shows no skill results and prompt submission remains available.
- Shell mode never opens `$` autocomplete and never sends `skills`.

## Testing

### TUI unit tests

- `$` trigger opens skill autocomplete in normal mode.
- `$` does not open skill autocomplete in shell mode.
- Skill options filter by name and description.
- Selecting a skill inserts `$skill-name ` and creates a skill prompt part.
- Restoring prompt history recreates skill extmarks.
- Submit combines selected skill parts and manually typed `$skill-name` tokens.
- Submit dedupes multiple references to the same skill.
- Submit ignores unknown dollar tokens such as `$PATH` and `$1`.

### Backend tests

- `SessionPrompt.PromptInput` accepts `skills`.
- Prompt execution loads requested skill content into the provider-turn context.
- Missing requested skills fail clearly.
- Denied skills fail clearly.
- Empty or omitted `skills` preserves existing prompt behavior.

### SDK and type checks

- Regenerate the JavaScript SDK after schema changes with `./packages/sdk/js/script/build.ts`.
- Run `bun typecheck` from `packages/opencode`.
- Run `bun typecheck` from `packages/tui`.

## Implementation Notes

- Keep the first pass scoped to TUI and backend prompt execution.
- Reuse existing extmark sync patterns for file, agent, and pasted text parts.
- Prefer a local TUI `SkillPromptPart` type over adding a backend message part type.
- Keep skill matching exact and name-based rather than regex-only, because valid skill names come from discovery.
- Do not change command registration or TUI slash behavior for skills in this pass.
