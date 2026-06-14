import { describe, expect, it } from "bun:test"
import { evalScript } from "@/workflow/sandbox"

describe("evalScript", () => {
  it("returns a plain value from the script body", async () => {
    const result = await evalScript("return { ok: true, value: 42 }", {})
    expect(result).toEqual({ ok: true, value: 42 })
  })

  it("returns primitive values", async () => {
    expect(await evalScript("return 7", {})).toBe(7)
    expect(await evalScript("return 'hello'", {})).toBe("hello")
    expect(await evalScript("return true", {})).toBe(true)
    expect(await evalScript("return null", {})).toBe(null)
  })

  it("can await an injected sync host function", async () => {
    const hooks = { agent: (...args: unknown[]) => `echoed:${args.join(",")}` }
    const result = await evalScript("const out = await agent('a', 'b'); return out", hooks)
    expect(result).toBe("echoed:a,b")
  })

  it("can await an injected async host function", async () => {
    const hooks = { agent: async (prompt: unknown) => ({ reply: String(prompt).toUpperCase() }) }
    const result = await evalScript("return await agent('hi')", hooks)
    expect(result).toEqual({ reply: "HI" })
  })

  it("exposes the parallel() prelude helper backed by host hooks", async () => {
    const hooks = { agent: (prompt: unknown) => `got:${prompt}` }
    const result = await evalScript(
      "const r = await parallel([() => agent('x'), () => agent('y')]); return r",
      hooks,
    )
    expect(result).toEqual(["got:x", "got:y"])
  })

  it("exposes the pipeline() prelude helper", async () => {
    const result = await evalScript(
      "const r = await pipeline([1, 2], (n) => n * 10, (n) => n + 1); return r",
      {},
    )
    expect(result).toEqual([11, 21])
  })

  it("injects the args global from SandboxOptions", async () => {
    const result = await evalScript("return args", {}, { args: { who: "world", n: 3 } })
    expect(result).toEqual({ who: "world", n: 3 })
  })

  it("defaults args to undefined when not provided", async () => {
    expect(await evalScript("return typeof args", {})).toBe("undefined")
  })

  it("exposes a minimal URL polyfill", async () => {
    const result = await evalScript(
      "const u = new URL('https://host.example/path?q=1#h'); return { protocol: u.protocol, hostname: u.hostname, pathname: u.pathname, search: u.search, hash: u.hash }",
      {},
    )
    expect(result).toEqual({
      protocol: "https:",
      hostname: "host.example",
      pathname: "/path",
      search: "?q=1",
      hash: "#h",
    })
  })

  it("throws when the script body rejects", async () => {
    await expect(evalScript("throw new Error('boom')", {})).rejects.toThrow(/boom/)
  })

  it("throws on syntax errors", async () => {
    await expect(evalScript("this is not valid js", {})).rejects.toThrow()
  })
})

describe("evalScript determinism", () => {
  it("strips Date from the guest global", async () => {
    expect(await evalScript("return typeof Date", {})).toBe("undefined")
  })

  it("strips WeakRef from the guest global", async () => {
    expect(await evalScript("return typeof WeakRef", {})).toBe("undefined")
  })

  it("strips FinalizationRegistry from the guest global", async () => {
    expect(await evalScript("return typeof FinalizationRegistry", {})).toBe("undefined")
  })

  it("produces the same Math.random sequence for the same seed", async () => {
    const body = "return [Math.random(), Math.random(), Math.random()]"
    const a = await evalScript(body, {}, { seed: 42 })
    const b = await evalScript(body, {}, { seed: 42 })
    expect(a).toEqual(b)
  })

  it("produces different Math.random sequences for different seeds", async () => {
    const a = await evalScript("return Math.random()", {}, { seed: 1 })
    const b = await evalScript("return Math.random()", {}, { seed: 2 })
    expect(a).not.toBe(b)
  })

  it("uses a stable default seed when none is provided", async () => {
    const body = "return Math.random()"
    const a = await evalScript(body, {})
    const b = await evalScript(body, {})
    expect(a).toBe(b)
  })

  it("returns numbers in [0, 1) from the seeded PRNG", async () => {
    const vals = (await evalScript("return [Math.random(), Math.random(), Math.random()]", {})) as number[]
    for (const v of vals) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})
