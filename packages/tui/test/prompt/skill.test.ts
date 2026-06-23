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
