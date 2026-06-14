import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { workflowRef } from "@/workflow/runtime-ref"
import type { SessionID } from "@/session/schema"
import { ListQuery } from "../groups/workflow"

export const workflowHandlers = HttpApiBuilder.group(InstanceHttpApi, "workflow", (handlers) =>
  Effect.gen(function* () {
    const list = Effect.fn("WorkflowHttpApi.list")(function* (ctx: { query: typeof ListQuery.Type }) {
      const runtime = workflowRef.current
      if (!runtime) return []
      return yield* runtime.list(ctx.query.session_id ? { sessionID: ctx.query.session_id as SessionID } : undefined)
    })

    const resume = Effect.fn("WorkflowHttpApi.resume")(function* (ctx: { params: { runID: string } }) {
      const runtime = workflowRef.current
      if (!runtime) return { runID: ctx.params.runID, resumed: false }
      return yield* runtime.resume({ runID: ctx.params.runID })
    })

    return handlers.handle("list", list).handle("resume", resume)
  }),
)
