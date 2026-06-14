import { describe, expect, it } from "bun:test"
import path from "node:path"
import { resolveInWorkspace, makeFileHooks } from "@/workflow/workspace"

describe("resolveInWorkspace", () => {
  it("resolves a simple relative path within the root", () => {
    const root = path.join("/tmp", "ws")
    expect(resolveInWorkspace(root, "file.txt")).toBe(path.join(root, "file.txt"))
  })

  it("resolves a nested relative path within the root", () => {
    const root = path.join("/tmp", "ws")
    expect(resolveInWorkspace(root, path.join("sub", "dir", "f.txt"))).toBe(
      path.join(root, "sub", "dir", "f.txt"),
    )
  })

  it("returns the root itself for an empty relative path", () => {
    const root = path.join("/tmp", "ws")
    expect(resolveInWorkspace(root, ".")).toBe(root)
  })

  it("throws when the relative path escapes via ../", () => {
    const root = path.join("/tmp", "ws")
    expect(() => resolveInWorkspace(root, path.join("..", "secret"))).toThrow(/escapes the workspace root/)
  })

  it("throws when the relative path escapes via a deep ../", () => {
    const root = path.join("/tmp", "ws", "nested")
    expect(() => resolveInWorkspace(root, path.join("..", "..", "etc"))).toThrow(/escapes the workspace root/)
  })

  it("throws for an absolute path outside the root", () => {
    const root = path.join("/tmp", "ws")
    expect(() => resolveInWorkspace(root, "/etc/passwd")).toThrow(/escapes the workspace root/)
  })

  it("allows an absolute path that resolves inside the root", () => {
    const root = path.join("/tmp", "ws")
    expect(resolveInWorkspace(root, path.join(root, "a.txt"))).toBe(path.join(root, "a.txt"))
  })

  it("includes the offending path in the error message", () => {
    const root = path.join("/tmp", "ws")
    expect(() => resolveInWorkspace(root, "../../x")).toThrow(/"\.\.\/\.\.\/x"/)
  })
})

describe("makeFileHooks", () => {
  it("reads and writes files within the root", async () => {
    const dir = await mktemp()
    const hooks = makeFileHooks(dir)
    await hooks.writeFile("note.txt", "hello world")
    expect(await hooks.readFile("note.txt")).toBe("hello world")
    expect(await hooks.exists("note.txt")).toBe(true)
    expect(await hooks.exists("missing.txt")).toBe(false)
  })

  it("readFile returns null for missing files", async () => {
    const dir = await mktemp()
    const hooks = makeFileHooks(dir)
    expect(await hooks.readFile("nope.txt")).toBeNull()
  })

  it("rejects writes that escape the workspace root", async () => {
    const dir = await mktemp()
    const hooks = makeFileHooks(dir)
    await expect(hooks.writeFile("../../escape.txt", "x")).rejects.toThrow(/escapes the workspace root/)
  })

  it("rejects reads that escape the workspace root", async () => {
    const dir = await mktemp()
    const hooks = makeFileHooks(dir)
    await expect(hooks.readFile("../../escape.txt")).rejects.toThrow(/escapes the workspace root/)
  })

  it("glob returns workspace-relative paths", async () => {
    const dir = await mktemp()
    const hooks = makeFileHooks(dir)
    await hooks.writeFile("a.txt", "1")
    await hooks.writeFile(path.join("sub", "b.txt"), "2")
    const results = await hooks.glob("**/*.txt")
    expect(results).toContain("a.txt")
    expect(results).toContain(path.join("sub", "b.txt"))
    for (const p of results) {
      expect(p).not.toMatch(/^\.\./)
    }
  })
})

async function mktemp(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  return mkdtemp(path.join(tmpdir(), "ws-test-"))
}
