import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Goal } from "@/session/goal"
import { SessionID } from "@/session/schema"
import { Provider } from "@/provider/provider"
import { Auth } from "@/auth"
import { EventV2Bridge } from "@/event-v2-bridge"
import { testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect, awaitWithTimeout } from "../lib/effect"

const stubProvider = Layer.mock(Provider.Service)({})
const stubAuth = Layer.mock(Auth.Service)({})

const it = testEffect(
  Layer.mergeAll(
    Goal.layer.pipe(
      Layer.provideMerge(EventV2Bridge.defaultLayer),
      Layer.provide(stubProvider),
      Layer.provide(stubAuth),
    ),
    testInstanceStoreLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

describe("Goal service", () => {
  it.instance("set creates goal with react=0", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const id = SessionID.make("ses_test-1")
      yield* goal.set(id, "all tests pass")
      const result = yield* goal.get(id)
      expect(result).toEqual({ condition: "all tests pass", react: 0 })
    }),
  )

  it.instance("clear removes goal", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const id = SessionID.make("ses_test-2")
      yield* goal.set(id, "finish the feature")
      yield* goal.clear(id)
      const result = yield* goal.get(id)
      expect(result).toBeUndefined()
    }),
  )

  it.instance("bumpReact increments counter", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const id = SessionID.make("ses_test-3")
      yield* goal.set(id, "ship it")
      const first = yield* goal.bumpReact(id)
      const second = yield* goal.bumpReact(id)
      expect(first).toBe(1)
      expect(second).toBe(2)
    }),
  )

  it.instance("set resets react to 0 on overwrite", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const id = SessionID.make("ses_test-4")
      yield* goal.set(id, "first goal")
      yield* goal.bumpReact(id)
      yield* goal.bumpReact(id)
      yield* goal.set(id, "second goal")
      const result = yield* goal.get(id)
      expect(result).toEqual({ condition: "second goal", react: 0 })
    }),
  )

  it.instance("bumpReact returns 0 when no goal", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const id = SessionID.make("ses_test-5")
      const result = yield* goal.bumpReact(id)
      expect(result).toBe(0)
    }),
  )

  it.instance("set publishes session.goal event", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const id = SessionID.make("ses_test-6")
      const received = yield* Deferred.make<{ sessionID: string; condition: string }>()

      const unsub = yield* events.listen((event) => {
        if (event.type === Goal.Event.Updated.type) {
          const data = event.data as typeof Goal.Event.Updated.data.Type
          if (data.sessionID === id && data.goal)
            Deferred.doneUnsafe(received, Effect.succeed({ sessionID: data.sessionID, condition: data.goal.condition }))
        }
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)

      yield* goal.set(id, "event driven goal")
      const result = yield* awaitWithTimeout(
        Deferred.await(received),
        "timed out waiting for session.goal event",
      )

      expect(result.sessionID).toBe(id)
      expect(result.condition).toBe("event driven goal")
    }),
  )

  it.instance("clear publishes goal:undefined event", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const id = SessionID.make("ses_test-7")
      const received = yield* Deferred.make<string>()

      const unsub = yield* events.listen((event) => {
        if (event.type === Goal.Event.Updated.type) {
          const data = event.data as typeof Goal.Event.Updated.data.Type
          if (data.sessionID === id && data.goal === undefined) Deferred.doneUnsafe(received, Effect.succeed(data.sessionID))
        }
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)

      yield* goal.set(id, "to be cleared")
      yield* goal.clear(id)
      const result = yield* awaitWithTimeout(
        Deferred.await(received),
        "timed out waiting for goal:undefined event",
      )

      expect(result).toBe(id)
    }),
  )
})
