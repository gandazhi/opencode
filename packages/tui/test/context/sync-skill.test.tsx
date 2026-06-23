/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { json } from "../fixture/tui-sdk"
import { mount, wait } from "../cli/cmd/tui/sync-fixture"

describe("Sync skills", () => {
  test("bootstraps skill metadata from /skill", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const { app, sync } = await mount((url) => {
      if (url.pathname !== "/skill") return
      return json([
        {
          name: "brainstorming",
          description: "Design before implementation.",
          location: "/skills/brainstorming/SKILL.md",
          content: "# Brainstorming",
        },
      ])
    }, tmp.path)

    try {
      await wait(() => sync.data.skill.length === 1)
      expect(sync.data.skill[0]?.name).toBe("brainstorming")
      expect(sync.data.skill[0]?.description).toBe("Design before implementation.")
    } finally {
      app.renderer.destroy()
    }
  })
})
