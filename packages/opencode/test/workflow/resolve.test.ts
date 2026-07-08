import { describe, expect, it } from "bun:test"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { isInlineScript, listSavedWorkflows, resolveName, resolveWorkflowScript } from "@/workflow/resolve"

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

describe("resolveName", () => {
  it("resolves a built-in workflow by name without touching the filesystem", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "wf-resolve-"))
    const result = await resolveName("deep-research", dir, dir)
    expect(result).toContain("export const meta")
  })

  it("falls back to a saved workflow on disk when the name is not a built-in", async () => {
    const dir = await withWorkflow("mytask", "export const meta = { name: 'mytask' }\nreturn 1")
    const result = await resolveName("mytask", dir, dir)
    expect(result).toContain("mytask")
  })

  it("prefers the built-in when a disk file shares the name", async () => {
    const dir = await withWorkflow("deep-research", "export const meta = { name: 'deep-research' }\nreturn 'disk'")
    const result = await resolveName("deep-research", dir, dir)
    expect(result).toContain("fact-checked")
  })

  it("returns null when the name is neither built-in nor on disk", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "wf-resolve-"))
    const result = await resolveName("nonexistent", dir, dir)
    expect(result).toBeNull()
  })
})

describe("listSavedWorkflows", () => {
  it("lists workflows from .opencode/workflows with parsed meta", async () => {
    const dir = await withWorkflow("alpha", "export const meta = { name: 'alpha', description: 'does alpha' }\nreturn 1")
    const list = await listSavedWorkflows(dir)
    expect(list).toContainEqual({ name: "alpha", description: "does alpha" })
  })

  it("lists workflows from .claude/workflows", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "wf-resolve-"))
    await mkdir(path.join(dir, ".claude", "workflows"), { recursive: true })
    await writeFile(
      path.join(dir, ".claude", "workflows", "legacy.js"),
      "export const meta = { name: 'legacy', description: 'legacy wf' }\nreturn true",
    )
    const list = await listSavedWorkflows(dir)
    expect(list).toContainEqual({ name: "legacy", description: "legacy wf" })
  })

  it("skips files whose meta fails to parse", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "wf-resolve-"))
    await mkdir(path.join(dir, ".opencode", "workflows"), { recursive: true })
    await writeFile(path.join(dir, ".opencode", "workflows", "broken.js"), "this is not a workflow")
    await writeFile(
      path.join(dir, ".opencode", "workflows", "good.js"),
      "export const meta = { name: 'good', description: 'g' }\nreturn 1",
    )
    const list = await listSavedWorkflows(dir)
    expect(list.map((w) => w.name)).toEqual(["good"])
  })

  it("returns an empty array when no workflow dirs exist", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "wf-resolve-"))
    expect(await listSavedWorkflows(dir)).toEqual([])
  })

  it("gives .opencode precedence over .claude for a shared name", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "wf-resolve-"))
    await mkdir(path.join(dir, ".opencode", "workflows"), { recursive: true })
    await mkdir(path.join(dir, ".claude", "workflows"), { recursive: true })
    await writeFile(
      path.join(dir, ".opencode", "workflows", "dup.js"),
      "export const meta = { name: 'dup', description: 'from-opencode' }\nreturn 1",
    )
    await writeFile(
      path.join(dir, ".claude", "workflows", "dup.js"),
      "export const meta = { name: 'dup', description: 'from-claude' }\nreturn 1",
    )
    const list = await listSavedWorkflows(dir)
    expect(list.filter((w) => w.name === "dup")).toEqual([{ name: "dup", description: "from-opencode" }])
  })
})

async function withWorkflow(name: string, body: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "wf-resolve-"))
  await mkdir(path.join(dir, ".opencode", "workflows"), { recursive: true })
  await writeFile(path.join(dir, ".opencode", "workflows", `${name}.js`), body)
  return dir
}
