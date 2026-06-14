import { describe, expect, it } from "bun:test"
import { journalKeyBase, journalKey } from "@/workflow/persistence"

describe("journalKeyBase", () => {
  it("is deterministic for identical input", () => {
    const a = journalKeyBase("summarize this", { agentType: "writer" })
    const b = journalKeyBase("summarize this", { agentType: "writer" })
    expect(a).toBe(b)
  })

  it("returns a 64-char sha256 hex string", () => {
    const key = journalKeyBase("prompt", {})
    expect(key).toMatch(/^[0-9a-f]{64}$/)
  })

  it("produces different hashes for different prompts", () => {
    const a = journalKeyBase("prompt one", { agentType: "x" })
    const b = journalKeyBase("prompt two", { agentType: "x" })
    expect(a).not.toBe(b)
  })

  it("produces different hashes for different agent types", () => {
    const a = journalKeyBase("same prompt", { agentType: "writer" })
    const b = journalKeyBase("same prompt", { agentType: "reviewer" })
    expect(a).not.toBe(b)
  })

  it("produces different hashes for different models", () => {
    const a = journalKeyBase("same prompt", { agentType: "x", model: "gpt-4" })
    const b = journalKeyBase("same prompt", { agentType: "x", model: "claude-3" })
    expect(a).not.toBe(b)
  })

  it("produces different hashes for different phases", () => {
    const a = journalKeyBase("same prompt", { agentType: "x", phase: "draft" })
    const b = journalKeyBase("same prompt", { agentType: "x", phase: "review" })
    expect(a).not.toBe(b)
  })

  it("produces different hashes for different schemas", () => {
    const a = journalKeyBase("same prompt", { agentType: "x", schema: { a: 1 } })
    const b = journalKeyBase("same prompt", { agentType: "x", schema: { a: 2 } })
    expect(a).not.toBe(b)
  })

  it("treats missing agentType the same as explicit undefined", () => {
    const a = journalKeyBase("prompt", {})
    const b = journalKeyBase("prompt", { agentType: undefined })
    expect(a).toBe(b)
  })

  it("is insensitive to option key ordering (canonicalized)", () => {
    const a = journalKeyBase("prompt", { agentType: "x", model: "m" })
    const b = journalKeyBase("prompt", { model: "m", agentType: "x" })
    expect(a).toBe(b)
  })

  it("ignores extra unknown option keys", () => {
    const a = journalKeyBase("prompt", { agentType: "x" })
    const b = journalKeyBase("prompt", { agentType: "x", extraUnused: "ignored" })
    expect(a).toBe(b)
  })
})

describe("journalKey", () => {
  it("appends occurrence after a colon", () => {
    const base = journalKeyBase("prompt", { agentType: "x" })
    expect(journalKey("prompt", { agentType: "x" }, 1)).toBe(`${base}:1`)
    expect(journalKey("prompt", { agentType: "x" }, 2)).toBe(`${base}:2`)
  })

  it("distinguishes occurrences of the same prompt", () => {
    const a = journalKey("prompt", { agentType: "x" }, 1)
    const b = journalKey("prompt", { agentType: "x" }, 2)
    expect(a).not.toBe(b)
  })

  it("supports occurrence zero", () => {
    const base = journalKeyBase("prompt", {})
    expect(journalKey("prompt", {}, 0)).toBe(`${base}:0`)
  })
})
