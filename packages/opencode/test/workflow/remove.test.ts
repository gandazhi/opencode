import { afterEach, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { Database } from "@opencode-ai/core/database/database"
import { WorkflowPersistence } from "@/workflow/persistence"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"

const dbLayer = Database.defaultLayer
const runDb = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(dbLayer), Effect.scoped, Effect.runPromise)

const RUN_ID = "wf_remove001"
const SESS_ID = "sess_remove_test"
const PROJ_ID = "proj_remove_test"
const workflowDir = () => path.join(Global.Path.data, "workflow")

describe("WorkflowPersistence.remove", () => {
  afterEach(async () => {
    await runDb(WorkflowPersistence.remove(RUN_ID).pipe(Effect.ignore)).catch(() => {})
  })

  it("deletes the DB row, journal file, and script file", async () => {
    await runDb(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        // Insert parent rows to satisfy FK constraints
        yield* db
          .insert(ProjectTable)
          .values({ id: PROJ_ID, worktree: "/tmp/test", sandboxes: [] })
          .run()
          .pipe(Effect.ignore)
        yield* db
          .insert(SessionTable)
          .values({ id: SESS_ID, project_id: PROJ_ID, slug: "test", directory: "/tmp/test", title: "test", version: "1" })
          .run()
          .pipe(Effect.ignore)

        yield* WorkflowPersistence.recordStart({
          runID: RUN_ID,
          sessionID: SESS_ID as never,
          name: "test",
        }).pipe(Effect.ignore)
        yield* WorkflowPersistence.writeScript(RUN_ID, "export const meta = {name:'test',description:'d'}").pipe(Effect.ignore)
        yield* WorkflowPersistence.appendJournalSync(RUN_ID, [{ t: "log", msg: "x", pass: 1 }]).pipe(Effect.ignore)

        yield* WorkflowPersistence.remove(RUN_ID)

        const row = yield* WorkflowPersistence.load(RUN_ID).pipe(Effect.orElseSucceed(() => undefined))
        expect(row).toBeUndefined()
      }),
    )

    const journalExists = await Bun.file(path.join(workflowDir(), `${RUN_ID}.jsonl`)).exists()
    expect(journalExists).toBe(false)
    const scriptExists = await Bun.file(path.join(workflowDir(), `${RUN_ID}.js`)).exists()
    expect(scriptExists).toBe(false)
  })

  it("is a no-op for an unknown runID", async () => {
    await runDb(WorkflowPersistence.remove("wf_nonexistent999"))
  })
})
