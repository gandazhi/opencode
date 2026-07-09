import { afterEach, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionID } from "@/session/schema"
import { WorkflowPersistence } from "@/workflow/persistence"

const dbLayer = Database.layerFromPath(":memory:")
const runDb = (effect: Effect.Effect<unknown, unknown, unknown>) =>
  (effect as Effect.Effect<unknown, unknown, never>).pipe(Effect.provide(dbLayer), Effect.scoped, Effect.runPromise) as Promise<unknown>

const RUN_ID = "wf_phases_1"
const projectID = ProjectV2.ID.make("proj_workflow_phases_test")
const sessionID = SessionID.make("ses_workflow_phases_test")

describe("workflow phases persistence", () => {
  afterEach(async () => {
    await runDb(WorkflowPersistence.remove(RUN_ID).pipe(Effect.ignore)).catch(() => {})
  })

  it("round-trips planned phases through recordStart and list", async () => {
    const planned = [{ title: "research" }, { title: "draft", detail: "write it" }]

    await runDb(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db
          .insert(ProjectTable)
          .values({ id: projectID, worktree: "/tmp/workflow-phases" as never, sandboxes: [] as never })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.ignore)
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: projectID,
            slug: "workflow-phases",
            directory: "/tmp/workflow-phases",
            title: "Workflow phases",
            version: "1",
          })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.ignore)

        yield* WorkflowPersistence.recordStart({
          runID: RUN_ID,
          sessionID,
          name: "phased-run",
          parentActorID: "main",
          args: { q: "x" },
          phases: planned,
        }).pipe(Effect.ignore)
        const rows = yield* WorkflowPersistence.list({ sessionID })
        const row = rows.find((r) => r.runID === RUN_ID)
        expect(row?.phases).toEqual(planned)
      }),
    )
  })
})
