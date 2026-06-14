import { describe, expect, it } from "bun:test"
import {
  WorkflowAgentFailed,
  WorkflowChildFailed,
  WorkflowFinished,
  WorkflowLog,
  WorkflowPhase,
  WorkflowStarted,
} from "@/workflow/events"

describe("workflow events", () => {
  it("WorkflowStarted has correct type", () => {
    expect(WorkflowStarted.type).toBe("workflow.started")
  })

  it("WorkflowPhase has correct type", () => {
    expect(WorkflowPhase.type).toBe("workflow.phase")
  })

  it("WorkflowLog has correct type", () => {
    expect(WorkflowLog.type).toBe("workflow.log")
  })

  it("WorkflowFinished has correct type", () => {
    expect(WorkflowFinished.type).toBe("workflow.finished")
  })

  it("WorkflowAgentFailed has correct type", () => {
    expect(WorkflowAgentFailed.type).toBe("workflow.agent_failed")
  })

  it("WorkflowChildFailed has correct type", () => {
    expect(WorkflowChildFailed.type).toBe("workflow.child_failed")
  })

  it("all six events are registered", () => {
    const types = [
      WorkflowStarted.type,
      WorkflowPhase.type,
      WorkflowLog.type,
      WorkflowFinished.type,
      WorkflowAgentFailed.type,
      WorkflowChildFailed.type,
    ]
    expect(new Set(types).size).toBe(6)
  })
})
