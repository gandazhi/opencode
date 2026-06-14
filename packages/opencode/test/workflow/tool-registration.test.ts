import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { WorkflowTool, parameters } from "@/tool/workflow"

describe("workflow tool", () => {
  it("has id 'workflow'", () => {
    expect(WorkflowTool.id).toBe("workflow")
  })

  it("parameters schema is a union of the expected operations", () => {
    const decode = Schema.decodeUnknownSync(parameters)

    expect(decode({ operation: "run", name: "deep-research" })).toMatchObject({ operation: "run" })
    expect(decode({ operation: "status", run_id: "r1" })).toMatchObject({ operation: "status" })
    expect(decode({ operation: "cancel", run_id: "r1" })).toMatchObject({ operation: "cancel" })
    expect(decode({ operation: "resume", run_id: "r1" })).toMatchObject({ operation: "resume" })
  })

  it("rejects unknown operations", () => {
    const decode = Schema.decodeUnknownSync(parameters)
    expect(() => decode({ operation: "bogus" })).toThrow()
  })
})
