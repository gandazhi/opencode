import { describe, expect, it } from "bun:test"
import { parseMeta } from "@/workflow/meta"

describe("parseMeta", () => {
  it("parses a valid meta", () => {
    const script = `export const meta = {
  name: "test",
  description: "A test workflow",
  phases: [{ title: "Step1" }],
}
const x = 1`
    const result = parseMeta(script)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.meta.name).toBe("test")
      expect(result.meta.description).toBe("A test workflow")
      expect(result.meta.phases).toEqual([{ title: "Step1" }])
      expect(result.body.split("\n").length).toBe(script.split("\n").length)
    }
  })

  it("fails without meta", () => {
    const result = parseMeta("const x = 1")
    expect(result.ok).toBe(false)
  })

  it("rejects function calls in meta", () => {
    const script = `export const meta = { name: foo() }`
    const result = parseMeta(script)
    expect(result.ok).toBe(false)
  })

  it("handles single-quoted strings and unquoted keys", () => {
    const script = `export const meta = { name: 'test', description: "desc" }`
    const result = parseMeta(script)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.meta.name).toBe("test")
  })
})
