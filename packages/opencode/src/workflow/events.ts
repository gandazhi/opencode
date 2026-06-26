import { Schema } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionID } from "@/session/schema"

const syncOptions = { sync: { aggregate: "runID", version: 1 } } as const

export const WorkflowStarted = EventV2.define({
  type: "workflow.started",
  ...syncOptions,
  schema: {
    sessionID: SessionID,
    runID: Schema.String,
    name: Schema.String,
  },
})

export const WorkflowPhase = EventV2.define({
  type: "workflow.phase",
  ...syncOptions,
  schema: {
    sessionID: SessionID,
    runID: Schema.String,
    title: Schema.String,
  },
})

export const WorkflowLog = EventV2.define({
  type: "workflow.log",
  ...syncOptions,
  schema: {
    sessionID: SessionID,
    runID: Schema.String,
    message: Schema.String,
  },
})

export const WorkflowProgress = EventV2.define({
  type: "workflow.progress",
  ...syncOptions,
  schema: {
    sessionID: SessionID,
    runID: Schema.String,
    running: Schema.Number,
    succeeded: Schema.Number,
    failed: Schema.Number,
  },
})

export const WorkflowFinished = EventV2.define({
  type: "workflow.finished",
  ...syncOptions,
  schema: {
    sessionID: SessionID,
    runID: Schema.String,
    status: Schema.Literals(["completed", "failed", "cancelled"]),
    error: Schema.optional(Schema.String),
  },
})

export const WorkflowAgentFailed = EventV2.define({
  type: "workflow.agent_failed",
  schema: {
    sessionID: SessionID,
    runID: Schema.String,
    actorID: Schema.optional(Schema.String),
    agentType: Schema.String,
    label: Schema.optional(Schema.String),
    phase: Schema.optional(Schema.String),
    reason: Schema.Literals(["over-cap", "spawn-reject", "timeout", "actor-error", "no-deliverable"]),
    errorMessage: Schema.optional(Schema.String),
  },
})

export const WorkflowChildFailed = EventV2.define({
  type: "workflow.child_failed",
  schema: {
    sessionID: SessionID,
    runID: Schema.String,
    childRunID: Schema.String,
    name: Schema.String,
    status: Schema.Literals(["failed", "cancelled"]),
    error: Schema.optional(Schema.String),
  },
})

export const WorkflowAgentStarted = EventV2.define({
  type: "workflow.agent_started",
  ...syncOptions,
  schema: {
    sessionID: SessionID,
    runID: Schema.String,
    key: Schema.String,
    agentID: Schema.optional(Schema.String),
    agentType: Schema.String,
    label: Schema.optional(Schema.String),
    phase: Schema.optional(Schema.String),
  },
})

export const WorkflowAgentEnded = EventV2.define({
  type: "workflow.agent_ended",
  ...syncOptions,
  schema: {
    sessionID: SessionID,
    runID: Schema.String,
    key: Schema.String,
    status: Schema.Literals(["succeeded", "failed"]),
    reason: Schema.optional(Schema.String),
    errorMessage: Schema.optional(Schema.String),
    retry: Schema.optional(Schema.Number),
    cost: Schema.optional(Schema.Number),
    tokens: Schema.optional(
      Schema.Struct({
        input: Schema.Number,
        output: Schema.Number,
        reasoning: Schema.Number,
        cache: Schema.Struct({ read: Schema.Number, write: Schema.Number }),
      }),
    ),
  },
})
