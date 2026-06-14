/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { onMount } from "solid-js"
import { testRender } from "@opentui/solid"
import { tmpdir } from "../fixture/fixture"
import type { GlobalEvent, Session } from "@opencode-ai/sdk/v2"
import { ArgsProvider } from "../../src/context/args"
import { ExitProvider } from "../../src/context/exit"
import { KVProvider } from "../../src/context/kv"
import { SDKProvider } from "../../src/context/sdk"
import { ProjectProvider } from "../../src/context/project"
import { SyncProvider, useSync } from "../../src/context/sync"
import { ThemeProvider } from "../../src/context/theme"
import { TuiConfigProvider } from "../../src/config"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { TestTuiContexts } from "../fixture/tui-environment"
import { wait, createEventSource, createFetch, directory } from "../cli/cmd/tui/sync-fixture"

function makeSession(id: string, parentID?: string): Session {
  return {
    id,
    slug: id,
    projectID: "proj_test",
    directory,
    title: id,
    version: "test",
    parentID,
    time: { created: 0, updated: 0 },
  }
}

function sessionUpdated(info: Session): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload: { id: `evt_sess_${info.id}`, type: "session.updated", properties: { sessionID: info.id, info } },
  }
}

function workflowStarted(sessionID: string, runID: string, name: string): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload: {
      id: `evt_wf_${runID}`,
      type: "workflow.started",
      properties: { sessionID, runID, name },
    } as unknown as GlobalEvent["payload"],
  }
}

function workflowLog(sessionID: string, runID: string, message: string): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload: {
      id: `evt_wflog_${runID}_${message.slice(0, 8)}`,
      type: "workflow.log",
      properties: { sessionID, runID, message },
    } as unknown as GlobalEvent["payload"],
  }
}

async function mountSync(sessionID: string, state: string) {
  const calls = createFetch()
  const events = createEventSource()
  let sync!: ReturnType<typeof useSync>
  let done!: () => void
  const ready = new Promise<void>((resolve) => {
    done = resolve
  })

  function Probe() {
    sync = useSync()
    onMount(() => done())
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts paths={{ state }}>
      <ArgsProvider>
        <ExitProvider exit={() => {}}>
          <KVProvider>
            <TuiConfigProvider config={createTuiResolvedConfig()}>
              <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
                <ProjectProvider>
                  <SyncProvider>
                    <ThemeProvider mode="dark">
                      <Probe />
                    </ThemeProvider>
                  </SyncProvider>
                </ProjectProvider>
              </SDKProvider>
            </TuiConfigProvider>
          </KVProvider>
        </ExitProvider>
      </ArgsProvider>
    </TestTuiContexts>
  ))

  await ready
  await wait(() => sync.status === "complete")
  return { app, emit: events.emit, sync }
}

describe("Sync workflow.log", () => {
  test("collects workflow.log events into run.logs, most-recent-last", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const sessionID = "ses_parent"
    const { app, emit, sync } = await mountSync(sessionID, tmp.path)
    try {
      emit(sessionUpdated(makeSession(sessionID)))
      await wait(() => sync.data.session.length === 1)

      emit(workflowStarted(sessionID, "run_a", "Deep Research"))
      await wait(() => Object.keys(sync.data.workflow).length === 1)

      emit(workflowLog(sessionID, "run_a", "Q: what is x"))
      emit(workflowLog(sessionID, "run_a", "Split into 5 lines"))
      emit(workflowLog(sessionID, "run_a", "Read 22 sources"))
      await wait(() => (sync.data.workflow["run_a"] as { logs?: string[] }).logs?.length === 3)

      const logs = (sync.data.workflow["run_a"] as { logs: string[] }).logs
      expect(logs).toEqual(["Q: what is x", "Split into 5 lines", "Read 22 sources"])
    } finally {
      app.renderer.destroy()
    }
  })

  test("caps logs at 10 entries", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const sessionID = "ses_parent"
    const { app, emit, sync } = await mountSync(sessionID, tmp.path)
    try {
      emit(sessionUpdated(makeSession(sessionID)))
      await wait(() => sync.data.session.length === 1)

      emit(workflowStarted(sessionID, "run_b", "Deep Research"))
      await wait(() => Object.keys(sync.data.workflow).length === 1)

      for (let i = 0; i < 12; i++) emit(workflowLog(sessionID, "run_b", `log ${i}`))
      await wait(() => (sync.data.workflow["run_b"] as { logs?: string[] }).logs?.length === 10)

      const logs = (sync.data.workflow["run_b"] as { logs: string[] }).logs
      expect(logs[0]).toBe("log 2")
      expect(logs[9]).toBe("log 11")
      expect(logs.length).toBe(10)
    } finally {
      app.renderer.destroy()
    }
  })

  test("workflow.started resets logs to empty", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const sessionID = "ses_parent"
    const { app, emit, sync } = await mountSync(sessionID, tmp.path)
    try {
      emit(sessionUpdated(makeSession(sessionID)))
      await wait(() => sync.data.session.length === 1)

      emit(workflowStarted(sessionID, "run_c", "Deep Research"))
      await wait(() => Object.keys(sync.data.workflow).length === 1)
      emit(workflowLog(sessionID, "run_c", "first log"))
      await wait(() => (sync.data.workflow["run_c"] as { logs?: string[] }).logs?.length === 1)

      emit(workflowStarted(sessionID, "run_c", "Deep Research"))
      await wait(() => (sync.data.workflow["run_c"] as { logs?: string[] }).logs === undefined || (sync.data.workflow["run_c"] as { logs?: string[] }).logs?.length === 0)

      const logs = (sync.data.workflow["run_c"] as { logs?: string[] }).logs
      expect(logs ?? []).toEqual([])
    } finally {
      app.renderer.destroy()
    }
  })
})
