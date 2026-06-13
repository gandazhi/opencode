import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { SessionID } from "./schema"
import { Effect, Layer, Context, Schema } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { Auth } from "@/auth"
import { MessageV2 } from "./message-v2"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { generateObject, streamObject, type ModelMessage } from "ai"
import z from "zod"

const JUDGE_SYSTEM = `You are evaluating a stop-condition hook. Read the conversation transcript carefully, then judge whether the user-provided condition is satisfied.

Your response must be a JSON object with one of these shapes:
- {"ok": true, "reason": "<quote evidence from the transcript that satisfies the condition>"}
- {"ok": false, "reason": "<quote what is missing or what blocks the condition>"}
- {"ok": false, "impossible": true, "reason": "<explain why the condition can never be satisfied>"}

Always include a "reason" field, quoting specific text from the transcript whenever possible. If the transcript does not contain clear evidence that the condition is satisfied, return {"ok": false, "reason": "insufficient evidence in transcript"}.

Only use {"ok": false, "impossible": true} when the condition is genuinely unachievable in this session — for example: the condition is self-contradictory, it depends on a resource or capability that is unavailable, or the assistant has explicitly tried, exhausted reasonable approaches, and stated it cannot be done. Apply your own judgment when deciding this — the assistant claiming the goal is impossible is evidence, not proof; independently confirm the condition is genuinely unachievable rather than deferring to the assistant's self-assessment. Do not use it just because the goal has not been reached yet or because progress is slow. When in doubt, return {"ok": false} without "impossible".`

const judgeUser = (condition: string) =>
  `Based on the conversation transcript above, has the following stopping condition been satisfied? Answer based on transcript evidence only.

Condition: ${condition}`

export type Goal = {
  condition: string
  react: number
}

export const Verdict = z.object({
  ok: z.boolean(),
  impossible: z.boolean().optional(),
  reason: z.string(),
})
export type Verdict = z.infer<typeof Verdict>

export const GoalInfo = Schema.Struct({
  condition: Schema.String,
}).annotate({ identifier: "SessionGoal" })

export const LastVerdict = Schema.Struct({
  ok: Schema.Boolean,
  impossible: Schema.optional(Schema.Boolean),
  reason: Schema.String,
  attempt: Schema.Number,
  messageID: Schema.optional(Schema.String),
  error: Schema.optional(Schema.Boolean),
})

export const Event = {
  Updated: EventV2.define({
    type: "session.goal",
    schema: {
      sessionID: SessionID,
      goal: Schema.optional(GoalInfo),
      lastVerdict: Schema.optional(LastVerdict),
    },
  }),
}

export interface Interface {
  readonly set: (sessionID: SessionID, condition: string) => Effect.Effect<void>
  readonly get: (sessionID: SessionID) => Effect.Effect<Goal | undefined>
  readonly clear: (sessionID: SessionID) => Effect.Effect<void>
  readonly bumpReact: (sessionID: SessionID) => Effect.Effect<number>
  readonly evaluate: (input: {
    condition: string
    msgs: SessionV1.WithParts[]
    model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
  }) => Effect.Effect<Verdict>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionGoal") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const provider = yield* Provider.Service
    const auth = yield* Auth.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionGoal.state")(() => Effect.succeed(new Map<SessionID, Goal>())),
    )

    const set = Effect.fn("SessionGoal.set")(function* (sessionID: SessionID, condition: string) {
      const data = yield* InstanceState.get(state)
      const goal: Goal = { condition, react: 0 }
      data.set(sessionID, goal)
      yield* events.publish(Event.Updated, { sessionID, goal: { condition } })
    })

    const get = Effect.fn("SessionGoal.get")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      return data.get(sessionID)
    })

    const clear = Effect.fn("SessionGoal.clear")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      data.delete(sessionID)
      yield* events.publish(Event.Updated, { sessionID, goal: undefined })
    })

    const bumpReact = Effect.fn("SessionGoal.bumpReact")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const current = data.get(sessionID)
      if (!current) return 0
      current.react += 1
      return current.react
    })

    const evaluate = Effect.fn("SessionGoal.evaluate")(function* (input: {
      condition: string
      msgs: SessionV1.WithParts[]
      model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
    }) {
      const resolved = yield* provider.getModel(input.model.providerID, input.model.modelID).pipe(Effect.orDie)
      const language = yield* provider.getLanguage(resolved).pipe(Effect.orDie)
      const authInfo = yield* auth.get(input.model.providerID).pipe(Effect.orDie)
      const isOpenaiOauth = input.model.providerID === "openai" && authInfo?.type === "oauth"

      const system = [JUDGE_SYSTEM]
      const transcript = yield* MessageV2.toModelMessagesEffect(input.msgs, resolved)

      const messages: ModelMessage[] = [
        ...(isOpenaiOauth
          ? []
          : system.map((item): ModelMessage => ({ role: "system", content: item }))),
        ...transcript,
        { role: "user", content: judgeUser(input.condition) },
      ]

      const params = {
        temperature: 0,
        messages,
        model: language,
        schema: Verdict,
      } satisfies Parameters<typeof generateObject>[0]

      if (isOpenaiOauth) {
        return yield* Effect.promise(async () => {
          const result = streamObject({
            ...params,
            providerOptions: ProviderTransform.providerOptions(resolved, {
              instructions: system.join("\n"),
              store: false,
            }),
            onError: () => {},
          })
          for await (const part of result.fullStream) {
            if (part.type === "error") throw part.error
          }
          return result.object as unknown as Verdict
        })
      }

      return yield* Effect.promise(() => generateObject(params).then((r) => r.object as Verdict))
    })

    return Service.of({ set, get, clear, bumpReact, evaluate })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
)

export const node = LayerNode.make(layer, [Provider.node, Auth.node, EventV2Bridge.node])

export * as Goal from "./goal"
