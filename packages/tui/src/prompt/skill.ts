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
  const shadowed = new Set<string>()
  const sorted = skills
    .map((skill) => skill.name)
    .filter((name) => name.length > 0)
    .toSorted((a, b) => b.length - a.length || a.localeCompare(b))

  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "$") continue

    for (const name of sorted) {
      if (shadowed.has(name)) continue
      if (!text.startsWith(name, index + 1)) continue
      if (isSkillNameChar(text[index + 1 + name.length])) {
        // Suppress a shorter skill prefix after a longer unknown token shadows it.
        shadowed.add(name)
        continue
      }
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
