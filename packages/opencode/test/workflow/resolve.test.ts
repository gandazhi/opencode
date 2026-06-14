import { describe, expect, it } from "bun:test"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { isInlineScript, resolveWorkflowScript } from "@/workflow/resolve"

describe("isInlineScript", () => {
  it("detects an inline script containing export const meta", () => {
    expect(isInlineScript('export const meta = { name: "x" }\nconst body = 1')).toBe(true)
  })

  it("detects inline meta with extra whitespace", () => {
    expect(isInlineScript("export   const   meta   =   {}")).toBe(true)
  })

  it("rejects a plain workflow name", () => {
    expect(isInlineScript("summarize")).toBe(false)
  })

  it("rejects an empty string", () => {
    expect(isInlineScript("")).toBe(false)
  })

  it("rejects code without the meta export", () => {
    expect(isInlineScript("const result = await agent('hi')")).toBe(false)
  })

  it("does not match 'meta' as a plain identifier assignment", () => {
    expect(isInlineScript("const meta = {}")).toBe(false)
  })
})

describe("resolveWorkflowScript", () => {
  it("resolves a script from .opencode/workflows/", async () => {
    const dir = await withWorkflow("mytask", "export const meta = { name: 'mytask' }\nreturn 1")
    const result = await resolveWorkflowScript("mytask", dir, dir)
    expect(result).toContain("export const meta =")
  })

  it("resolves a script from .claude/workflows/", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "wf-resolve-"))
    await mkdir(path.join(dir, ".claude", "workflows"), { recursive: true })
    await writeFile(
      path.join(dir, ".claude", "workflows", "legacy.js"),
      "export const meta = { name: 'legacy' }\nreturn true",
    )
    const result = await resolveWorkflowScript("legacy", dir, dir)
    expect(result).toContain("legacy")
  })

  it("returns null when the script does not exist", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "wf-resolve-"))
    const result = await resolveWorkflowScript("nonexistent", dir, dir)
    expect(result).toBeNull()
  })

  it("walks up from a nested start directory to the stop directory", async () => {
    const dir = await withWorkflow("ancestor", "export const meta = { name: 'ancestor' }\nreturn 1")
    const nested = path.join(dir, "deep", "nested", "path")
    await mkdir(nested, { recursive: true })
    const result = await resolveWorkflowScript("ancestor", nested, dir)
    expect(result).toContain("export const meta =")
  })

  it("throws on an invalid name with path separators", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "wf-resolve-"))
    await expect(resolveWorkflowScript("../escape", dir, dir)).rejects.toThrow(/invalid workflow name/)
  })

  it("throws on a name with shell metacharacters", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "wf-resolve-"))
    await expect(resolveWorkflowScript("name;rm", dir, dir)).rejects.toThrow(/invalid workflow name/)
  })
})

async function withWorkflow(name: string, body: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "wf-resolve-"))
  await mkdir(path.join(dir, ".opencode", "workflows"), { recursive: true })
  await writeFile(path.join(dir, ".opencode", "workflows", `${name}.js`), body)
  return dir
}
