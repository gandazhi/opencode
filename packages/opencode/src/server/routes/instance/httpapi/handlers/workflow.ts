import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { workflowRef } from "@/workflow/runtime-ref"
import type { SessionID } from "@/session/schema"
import { ListQuery, WorkflowNotFoundError } from "../groups/workflow"

export const workflowHandlers = HttpApiBuilder.group(InstanceHttpApi, "workflow", (handlers) =>
  Effect.gen(function* () {
    const list = Effect.fn("WorkflowHttpApi.list")(function* (ctx: { query: typeof ListQuery.Type }) {
      const runtime = workflowRef.current
      if (!runtime) return []
      return yield* runtime.list(ctx.query.session_id ? { sessionID: ctx.query.session_id as SessionID } : undefined)
    })

    const detail = Effect.fn("WorkflowHttpApi.detail")(function* (ctx: { params: { runID: string } }) {
      const runtime = workflowRef.current
      if (!runtime) return yield* Effect.fail(new WorkflowNotFoundError({ name: "WorkflowNotFound", data: { runID: ctx.params.runID } }))
      const result = yield* runtime.detail({ runID: ctx.params.runID })
      if ("status" in result) return yield* Effect.fail(new WorkflowNotFoundError({ name: "WorkflowNotFound", data: { runID: ctx.params.runID } }))
      return result
    })

    const cancel = Effect.fn("WorkflowHttpApi.cancel")(function* (ctx: { params: { runID: string } }) {
      const runtime = workflowRef.current
      if (!runtime) return { ok: false }
      yield* runtime.cancel({ runID: ctx.params.runID })
      return { ok: true }
    })

    const remove = Effect.fn("WorkflowHttpApi.delete")(function* (ctx: { params: { runID: string } }) {
      const runtime = workflowRef.current
      if (!runtime) return { ok: false }
      yield* runtime.remove({ runID: ctx.params.runID })
      return { ok: true }
    })

    const resume = Effect.fn("WorkflowHttpApi.resume")(function* (ctx: { params: { runID: string } }) {
      const runtime = workflowRef.current
      if (!runtime) return { runID: ctx.params.runID, resumed: false }
      return yield* runtime.resume({ runID: ctx.params.runID })
    })

    return handlers
      .handle("list", list)
      .handle("detail", detail)
      .handle("cancel", cancel)
      .handle("delete", remove)
      .handle("resume", resume)
  }),
)
