import { afterEach, describe, expect, it } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Effect, Layer } from "effect"
import { TestConfig } from "../fixture/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { WorkflowPersistence } from "@/workflow/persistence"
import { WorkflowRuntime } from "@/workflow/runtime"

const projectID = ProjectV2.ID.make("proj_workflow_notify_test")
const sessionID = SessionID.make("ses_workflow_notify_test")
const cleanupRunIDs = new Set<string>()

const promptCapture = { calls: 0 }

const events = Layer.succeed(
  EventV2Bridge.Service,
  EventV2Bridge.Service.of({
    publish: () => Effect.void,
  } as never),
)

const prompts = Layer.succeed(
  SessionPrompt.Service,
  SessionPrompt.Service.of({
    cancel: () => Effect.void,
    command: () => Effect.succeed({ info: {} as never, parts: [] }),
    loop: () => Effect.succeed({ info: {} as never, parts: [] }),
    prompt: () =>
      Effect.sync(() => {
        promptCapture.calls++
        return { info: {} as never, parts: [] }
      }),
    resolvePromptParts: () => Effect.succeed([]),
    shell: () => Effect.succeed({ info: {} as never, parts: [] }),
  }),
)

const dependencies = Layer.mergeAll(Database.defaultLayer, TestConfig.layer(), events, prompts)
const layer = Layer.provideMerge(WorkflowRuntime.layer, dependencies)

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped) as Effect.Effect<A, E, never>)

async function runWorkflow(script: string) {
  return run(
    Effect.gen(function* () {
      const database = yield* Database.Service
      yield* database.db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: "/tmp/workflow-notify" as never, sandboxes: [] as never })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.ignore)
      yield* database.db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          slug: "workflow-notify",
          directory: "/tmp/workflow-notify",
          title: "Workflow notify",
          version: "1",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.ignore)
      const runtime = yield* WorkflowRuntime.Service
      const started = yield* runtime.start({
        script,
        sessionID,
        parentActorID: "build",
      })
      cleanupRunIDs.add(started.runID)
      const outcome = yield* runtime.wait({ runID: started.runID })
      yield* Effect.sleep("20 millis")
      return outcome
    }),
  )
}

afterEach(async () => {
  promptCapture.calls = 0
  await Promise.all(
    [...cleanupRunIDs].map((runID) =>
      run(WorkflowPersistence.remove(runID).pipe(Effect.ignore)),
    ),
  )
  cleanupRunIDs.clear()
})

describe("workflow runtime terminal notifications", () => {
  it("does not inject a completed workflow result into the parent session prompt", async () => {
    const outcome = await runWorkflow(
      "export const meta = { name: 'notify-complete', description: 'complete' }\nreturn { ok: true }",
    )

    expect(outcome.status).toBe("completed")
    expect(promptCapture.calls).toBe(0)
  })

  it("does not inject a failed workflow result into the parent session prompt", async () => {
    const outcome = await runWorkflow(
      "export const meta = { name: 'notify-fail', description: 'fail' }\nthrow new Error('boom')",
    )

    expect(outcome.status).toBe("failed")
    expect(promptCapture.calls).toBe(0)
  })
})
