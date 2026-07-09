import { describe, expect, it } from "bun:test"
import { derivePhaseStates } from "../../src/util/workflow-phases"

describe("derivePhaseStates", () => {
  const phases = [
    { title: "research" },
    { title: "draft" },
    { title: "verify" },
  ]

  it("marks all done when completed", () => {
    const out = derivePhaseStates({ phases, currentPhase: "draft", status: "completed" })
    expect(out.map((p) => p.state)).toEqual(["done", "done", "done"])
  })

  it("marks done/now/pending for a running run with a matching currentPhase", () => {
    const out = derivePhaseStates({ phases, currentPhase: "draft", status: "running" })
    expect(out.map((p) => p.state)).toEqual(["done", "now", "pending"])
  })

  it("marks the current phase failed for a failed run", () => {
    const out = derivePhaseStates({ phases, currentPhase: "verify", status: "failed" })
    expect(out.map((p) => p.state)).toEqual(["done", "done", "failed"])
  })

  it("marks the current phase cancelled for a cancelled run", () => {
    const out = derivePhaseStates({ phases, currentPhase: "draft", status: "cancelled" })
    expect(out.map((p) => p.state)).toEqual(["done", "cancelled", "pending"])
  })

  it("marks all pending when currentPhase does not match any declared phase", () => {
    const out = derivePhaseStates({ phases, currentPhase: "unknown", status: "running" })
    expect(out.map((p) => p.state)).toEqual(["pending", "pending", "pending"])
  })

  it("marks all pending when currentPhase is undefined", () => {
    const out = derivePhaseStates({ phases, status: "running" })
    expect(out.map((p) => p.state)).toEqual(["pending", "pending", "pending"])
  })

  it("returns empty when phases is undefined", () => {
    expect(derivePhaseStates({ currentPhase: "x", status: "running" })).toEqual([])
  })

  it("returns empty when phases is empty", () => {
    expect(derivePhaseStates({ phases: [], currentPhase: "x", status: "running" })).toEqual([])
  })

  it("preserves the phase title and detail in each entry", () => {
    const out = derivePhaseStates({
      phases: [{ title: "research", detail: "gather sources" }],
      currentPhase: "research",
      status: "running",
    })
    expect(out[0].phase).toEqual({ title: "research", detail: "gather sources" })
    expect(out[0].state).toBe("now")
  })

  it("completed overrides even when currentPhase is missing", () => {
    const out = derivePhaseStates({ phases, status: "completed" })
    expect(out.map((p) => p.state)).toEqual(["done", "done", "done"])
  })
})
