import { afterEach, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { WorkflowPersistence, type JournalEvent } from "@/workflow/persistence"

const RUN_ID = "wf_testlc001"

describe("loadJournal lifecycle rebuild", () => {
  afterEach(async () => {
    await WorkflowPersistence.clearJournal(RUN_ID).pipe(Effect.runPromise).catch(() => {})
  })

  it("rebuilds agents[] from agent_start/agent_end events", async () => {
    const events: JournalEvent[] = [
      { t: "agent_start", key: "k1", sessionID: "sess_a", agentType: "general", label: "brief", phase: "research", ts: 1000, pass: 1 },
      { t: "agent_end", key: "k1", ok: true, ts: 2000, pass: 1 },
      { t: "agent_start", key: "k2", sessionID: "sess_b", agentType: "build", label: "impl", ts: 3000, pass: 1 },
      {
        t: "agent_end",
        key: "k2",
        ok: false,
        reason: "timeout",
        ts: 4000,
        cost: 0.05,
        tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
        pass: 1,
      },
    ]
    await WorkflowPersistence.appendJournalSync(RUN_ID, events).pipe(Effect.runPromise)

    const loaded = await WorkflowPersistence.loadJournal(RUN_ID).pipe(Effect.runPromise)

    expect(loaded.agents).toHaveLength(2)
    expect(loaded.agents[0]).toMatchObject({ key: "k1", sessionID: "sess_a", agentType: "general", status: "succeeded", startedAt: 1000, endedAt: 2000 })
    expect(loaded.agents[1]).toMatchObject({ key: "k2", status: "failed", reason: "timeout", cost: 0.05 })
    expect(loaded.agents[1].tokens?.input).toBe(100)
  })

  it("leaves a running agent (start with no end) as status running", async () => {
    await WorkflowPersistence.appendJournalSync(RUN_ID, [
      { t: "agent_start", key: "k1", sessionID: "sess_a", agentType: "general", ts: 1000, pass: 1 },
    ]).pipe(Effect.runPromise)

    const loaded = await WorkflowPersistence.loadJournal(RUN_ID).pipe(Effect.runPromise)

    expect(loaded.agents).toHaveLength(1)
    expect(loaded.agents[0].status).toBe("running")
  })

  it("collects full logs from log events", async () => {
    await WorkflowPersistence.appendJournalSync(RUN_ID, [
      { t: "log", msg: "first", pass: 1 },
      { t: "log", msg: "second", pass: 1 },
      { t: "log", msg: "third", pass: 1 },
    ]).pipe(Effect.runPromise)

    const loaded = await WorkflowPersistence.loadJournal(RUN_ID).pipe(Effect.runPromise)

    expect(loaded.logs).toEqual(["first", "second", "third"])
  })

  it("preserves existing results map and pass counter", async () => {
    await WorkflowPersistence.appendJournalSync(RUN_ID, [
      { t: "agent", key: "k1", result: "hello", pass: 1 },
      { t: "phase", title: "research", pass: 2 },
    ]).pipe(Effect.runPromise)

    const loaded = await WorkflowPersistence.loadJournal(RUN_ID).pipe(Effect.runPromise)

    expect(loaded.results.get("k1")).toBe("hello")
    expect(loaded.pass).toBe(3)
    expect(loaded.agents).toEqual([])
  })
})
