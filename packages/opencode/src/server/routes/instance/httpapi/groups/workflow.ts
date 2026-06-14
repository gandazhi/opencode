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

export const ListQuery = Schema.Struct({
  ...WorkspaceRoutingQuery.fields,
  session_id: Schema.optional(Schema.String),
})

export const WorkflowPaths = {
  list: root,
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
