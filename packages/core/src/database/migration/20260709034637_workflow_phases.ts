import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260709034637_workflow_phases",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`workflow_run\` ADD \`phases\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
