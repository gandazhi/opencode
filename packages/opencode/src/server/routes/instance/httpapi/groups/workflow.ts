import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/workflow"

export const WorkflowRunStatus = Schema.Literals(["running", "completed", "failed", "cancelled"])

export const WorkflowRunSummary = Schema.Struct({
  runID: Schema.String,
  sessionID: Schema.String,
  name: Schema.String,
  status: WorkflowRunStatus,
  running: Schema.Number,
  succeeded: Schema.Number,
  failed: Schema.Number,
  currentPhase: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})

export const ResumeResult = Schema.Struct({
  runID: Schema.String,
  resumed: Schema.Boolean,
})

export const WorkflowTokens = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  reasoning: Schema.Number,
  cache: Schema.Struct({ read: Schema.Number, write: Schema.Number }),
})

export const WorkflowAgentStatus = Schema.Literals(["running", "succeeded", "failed"])

export const WorkflowAgent = Schema.Struct({
  key: Schema.String,
  sessionID: Schema.optional(Schema.String),
  agentType: Schema.String,
  label: Schema.optional(Schema.String),
  phase: Schema.optional(Schema.String),
  status: WorkflowAgentStatus,
  reason: Schema.optional(Schema.String),
  retry: Schema.optional(Schema.Number),
  startedAt: Schema.Number,
  endedAt: Schema.optional(Schema.Number),
  cost: Schema.optional(Schema.Number),
  tokens: Schema.optional(WorkflowTokens),
})

export const WorkflowRunDetail = Schema.Struct({
  run: WorkflowRunSummary,
  agents: Schema.Array(WorkflowAgent),
  logs: Schema.Array(Schema.String),
})

export const EmptyResult = Schema.Struct({ ok: Schema.Boolean })

export class WorkflowNotFoundError extends Schema.ErrorClass<WorkflowNotFoundError>("WorkflowNotFound")(
  {
    name: Schema.Literal("WorkflowNotFound"),
    data: Schema.Struct({
      runID: Schema.String,
    }),
  },
  { httpApiStatus: 404 },
) {}

export class WorkflowRunningError extends Schema.ErrorClass<WorkflowRunningError>("WorkflowRunning")(
  {
    name: Schema.Literal("WorkflowRunning"),
    data: Schema.Struct({
      runID: Schema.String,
    }),
  },
  { httpApiStatus: 409 },
) {}

export const ListQuery = Schema.Struct({
  ...WorkspaceRoutingQuery.fields,
  session_id: Schema.optional(Schema.String),
})

export const WorkflowPaths = {
  list: root,
  detail: `${root}/:runID`,
  cancel: `${root}/:runID/cancel`,
  delete: `${root}/:runID`,
  resume: `${root}/:runID/resume`,
} as const

export const WorkflowApi = HttpApi.make("workflow")
  .add(
    HttpApiGroup.make("workflow")
      .add(
        HttpApiEndpoint.get("list", WorkflowPaths.list, {
          query: ListQuery,
          success: described(Schema.Array(WorkflowRunSummary), "List of workflow runs"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.list",
            summary: "List workflow runs",
            description: "Get a list of workflow runs, optionally filtered by session.",
          }),
        ),
        HttpApiEndpoint.get("detail", WorkflowPaths.detail, {
          params: { runID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(WorkflowRunDetail, "Run detail with agents and logs"),
          error: WorkflowNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.detail",
            summary: "Get workflow run detail",
            description: "Returns run summary, agent lifecycle records (with cost/tokens), and full logs.",
          }),
        ),
        HttpApiEndpoint.post("cancel", WorkflowPaths.cancel, {
          params: { runID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(EmptyResult, "Cancel result"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.cancel",
            summary: "Cancel workflow run",
            description: "Best-effort cancel; in-flight agents stop at their next safe point.",
          }),
        ),
        HttpApiEndpoint.delete("delete", WorkflowPaths.delete, {
          params: { runID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(EmptyResult, "Deletion result"),
          error: WorkflowRunningError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.delete",
            summary: "Delete workflow run",
            description: "Deletes the DB row, journal, and script. Running runs must be cancelled first.",
          }),
        ),
        HttpApiEndpoint.post("resume", WorkflowPaths.resume, {
          params: { runID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(ResumeResult, "Resume result"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.resume",
            summary: "Resume workflow run",
            description: "Resume a completed or failed workflow run from its persisted journal.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "workflow",
          description: "Experimental HttpApi workflow routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
