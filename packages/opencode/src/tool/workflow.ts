import * as Tool from "./tool"
import DESCRIPTION from "./workflow.txt"
import { Effect, Schema } from "effect"
import { PositiveInt } from "@opencode-ai/core/schema"
import { Config } from "@/config/config"
import { workflowRef } from "@/workflow/runtime-ref"
import { BuiltinWorkflow } from "@/workflow/builtin"
import type { SessionID } from "@/session/schema"

const id = "workflow"

export const parameters = Schema.Struct({
  operation: Schema.Literals(["run", "status", "wait", "cancel", "resume"]).annotate({
    description: "The operation to perform.",
  }),
  name: Schema.optional(Schema.String).annotate({
    description:
      '(operation "run" only) Name of a built-in workflow to run (e.g. "deep-research"). Provide EITHER name OR script, not both.',
  }),
  script: Schema.optional(Schema.String).annotate({
    description:
      '(operation "run" only) Inline JS workflow script; must begin with `export const meta = {...}`. Provide EITHER name OR script, not both.',
  }),
  args: Schema.optional(Schema.Unknown).annotate({
    description: '(operation "run" only) JSON value exposed to the script as `args`.',
  }),
  workspace: Schema.optional(Schema.String).annotate({
    description:
      '(operation "run" only) Absolute dir the script\'s file primitives are jailed to. Defaults to the project worktree.',
  }),
  run_id: Schema.optional(Schema.String).annotate({
    description: '(operations "status", "wait", "cancel", "resume") The workflow run ID.',
  }),
  timeout_ms: Schema.optional(PositiveInt).annotate({
    description: '(operation "wait" only) Timeout in milliseconds.',
  }),
})

type Parameters = Schema.Schema.Type<typeof parameters>
type Metadata = { runID?: string; status?: string }

export const WorkflowTool = Tool.define<typeof parameters, Metadata, Config.Service>(
  id,
  Effect.gen(function* () {
    const config = yield* Config.Service

    const requireRuntime = () => {
      const runtime = workflowRef.current
      if (!runtime) {
        return Effect.fail(
          new Error(
            "Workflow runtime unavailable — WorkflowRuntime.defaultLayer must be running for the workflow tool",
          ),
        )
      }
      return Effect.succeed(runtime)
    }

    const run = Effect.fn("WorkflowTool.execute")(function* (input: Parameters, ctx: Tool.Context<Metadata>) {
      const runtime = yield* requireRuntime()

      if (input.operation === "run") {
        const cfg = yield* config.get()
        if (input.name && input.script) {
          return yield* Effect.fail(
            new Error("workflow run: provide either `name` (a built-in) or `script` (inline), not both."),
          )
        }
        const script = input.name ? BuiltinWorkflow.get(input.name)?.script : input.script
        if (!script) {
          const known = BuiltinWorkflow.list()
            .map((w) => w.name)
            .join(", ")
          return yield* Effect.fail(
            new Error(
              input.name
                ? `Unknown built-in workflow "${input.name}". Known: ${known || "(none)"}.`
                : "workflow run requires either `name` (a built-in) or `script` (inline).",
            ),
          )
        }
        const started = yield* runtime.start({
          script,
          sessionID: ctx.sessionID as SessionID,
          parentActorID: ctx.agent ?? "main",
          args: input.args,
          workspace: input.workspace,
          maxConcurrentAgents: cfg.workflow?.maxConcurrentAgents,
          scriptDeadlineMs: cfg.workflow?.scriptDeadlineMs,
          agentTimeoutMs: cfg.workflow?.agentTimeoutMs,
        })
        return {
          title: "workflow started",
          output: `Workflow started. run_id: ${started.runID}\nThe result will be delivered as a notification when complete.`,
          metadata: { runID: started.runID } satisfies Metadata,
        }
      }
      const runID = input.run_id ?? ""
      if (input.operation === "status") {
        const snapshot = yield* runtime.status({ runID })
        return {
          title: `workflow ${snapshot.status}`,
          output: JSON.stringify(snapshot),
          metadata: { runID, status: snapshot.status } satisfies Metadata,
        }
      }
      if (input.operation === "wait") {
        const outcome = yield* runtime.wait({ runID, timeoutMs: input.timeout_ms })
        return {
          title: `workflow ${outcome.status}`,
          output: JSON.stringify(outcome),
          metadata: { runID, status: outcome.status } satisfies Metadata,
        }
      }
      if (input.operation === "cancel") {
        yield* runtime.cancel({ runID })
        return {
          title: "workflow cancelled",
          output: `Cancelled ${runID}`,
          metadata: { runID, status: "cancelled" } satisfies Metadata,
        }
      }
      if (input.operation === "resume") {
        const resumed = yield* runtime.resume({ runID })
        return {
          title: resumed.resumed ? "workflow resumed" : "workflow not resumable",
          output: JSON.stringify(resumed),
          metadata: { runID } satisfies Metadata,
        }
      }
      throw new Error(`unhandled workflow operation: ${input.operation}`)
    })

    return {
      description: DESCRIPTION,
      parameters,
      execute: (input: Parameters, ctx: Tool.Context<Metadata>) => run(input, ctx).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof parameters, Metadata>
  }),
)
