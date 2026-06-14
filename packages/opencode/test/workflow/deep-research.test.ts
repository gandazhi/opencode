import { describe, expect, it } from "bun:test"
// @ts-expect-error TS1192 — import-attribute text loader, resolved by Bun not tsgo
import DEEP_RESEARCH from "@/workflow/builtin/deep-research.js" with { type: "text" }
import { parseMeta } from "@/workflow/meta"
import { evalScript, type HostFn } from "@/workflow/sandbox"

describe("deep-research meta", () => {
  it("parses correctly", () => {
    const result = parseMeta(DEEP_RESEARCH)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.meta.name).toBe("deep-research")
    expect(result.meta.description).toBeTruthy()
    expect(result.meta.whenToUse).toBeTruthy()
    expect(result.meta.phases).toHaveLength(6)
    expect(result.meta.phases?.map((p) => p.title)).toEqual([
      "Plan",
      "Search",
      "Extract",
      "Group",
      "Crosscheck",
      "Report",
    ])
  })

  it("strips meta from body while preserving line count", () => {
    const result = parseMeta(DEEP_RESEARCH)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.body).not.toContain("export const meta")
    expect(result.body.split("\n")).toHaveLength(DEEP_RESEARCH.split("\n").length)
  })
})

describe("deep-research sandbox execution", () => {
  it("completes the full pipeline with mocked host functions", async () => {
    const parsed = parseMeta(DEEP_RESEARCH)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    const agent: HostFn = async (...args) => {
      const label = ((args[1] as { label?: string } | undefined)?.label) ?? ""
      if (label === "plan")
        return {
          question: "test question",
          lines: [
            { topic: "general", query: "q1", why: "overview" },
            { topic: "depth", query: "q2", why: "detail" },
            { topic: "latest", query: "q3", why: "recency" },
          ],
        }
      if (label.startsWith("search:")) {
        const topic = label.slice("search:".length)
        return {
          hits: [
            { url: "https://" + topic + ".example/1", title: "T1", fit: "high" },
            { url: "https://" + topic + ".example/2", title: "T2", fit: "medium" },
          ],
        }
      }
      if (label.startsWith("read:"))
        return {
          facts: [{ statement: "A checkable fact", excerpt: "A verbatim quote", weight: "key" }],
          tier: "primary",
        }
      if (label === "group") return { groups: [{ canonical: "Unified fact", members: [0] }] }
      if (label.startsWith("j"))
        return { reject: false, reason: "Well supported by primary source", certainty: "high" }
      if (label === "report")
        return {
          answer: "Mock research answer",
          findings: [
            {
              point: "Key finding",
              certainty: "high",
              sources: ["https://general.example/1"],
              basis: "Primary source",
            },
          ],
          limits: "Mock limitations",
        }
      return null
    }

    const hooks: Record<string, HostFn> = {
      agent,
      phase: () => {},
      log: () => {},
    }

    const result = (await evalScript(parsed.body, hooks, {
      args: "What is the state of workflow orchestration?",
      deadlineMs: 30_000,
    })) as {
      answer?: string
      stats?: { agentRuns?: number }
    }

    expect(result).toBeTruthy()
    expect(typeof result).toBe("object")
    expect(result.answer).toBeTruthy()
    expect(result.stats?.agentRuns).toBeGreaterThan(0)
  }, 60_000)
})
