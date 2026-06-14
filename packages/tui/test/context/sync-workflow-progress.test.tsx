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

function makeSession(id: string): Session {
  return { id, slug: id, projectID: "proj_test", directory, title: id, version: "test", parentID: undefined, time: { created: 0, updated: 0 } }
}
function sessionUpdated(info: Session): GlobalEvent {
  return { directory, project: "proj_test", payload: { id: `evt_${info.id}`, type: "session.updated", properties: { sessionID: info.id, info } } }
}
function workflowStarted(sessionID: string, runID: string, name: string): GlobalEvent {
  return { directory, project: "proj_test", payload: { id: `evt_wf_${runID}`, type: "workflow.started", properties: { sessionID, runID, name } } as unknown as GlobalEvent["payload"] }
}
function workflowProgress(sessionID: string, runID: string, running: number, succeeded: number, failed: number): GlobalEvent {
  return { directory, project: "proj_test", payload: { id: `evt_wfp_${runID}_${succeeded}`, type: "workflow.progress", properties: { sessionID, runID, running, succeeded, failed } } as unknown as GlobalEvent["payload"] }
}

async function mountSync(state: string) {
  const calls = createFetch()
  const events = createEventSource()
  let sync!: ReturnType<typeof useSync>
  let done!: () => void
  const ready = new Promise<void>((r) => (done = r))
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
                    <ThemeProvider mode="dark"><Probe /></ThemeProvider>
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

describe("Sync workflow.progress", () => {
  // Regression: counters showed 0+0/0 during a live run because no event
  // carried running/succeeded/failed. workflow.started seeded 0/0/0 and
  // nothing updated them until the run finished.
  test("workflow.progress updates running/succeeded/failed counters", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync } = await mountSync(tmp.path)
    try {
      emit(sessionUpdated(makeSession("ses_a")))
      await wait(() => sync.data.session.length === 1)

      emit(workflowStarted("ses_a", "run_a", "deep-research"))
      await wait(() => Object.keys(sync.data.workflow).length === 1)
      const initial = sync.data.workflow["run_a"] as { running: number; succeeded: number; failed: number }
      expect(initial.running).toBe(0)
      expect(initial.succeeded).toBe(0)
      expect(initial.failed).toBe(0)

      emit(workflowProgress("ses_a", "run_a", 3, 5, 1))
      await wait(() => (sync.data.workflow["run_a"] as { succeeded: number }).succeeded === 5)

      const after = sync.data.workflow["run_a"] as { running: number; succeeded: number; failed: number }
      expect(after.running).toBe(3)
      expect(after.succeeded).toBe(5)
      expect(after.failed).toBe(1)
    } finally {
      app.renderer.destroy()
    }
  })

  test("workflow.progress preserves other fields (name, status, phase, logs)", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync } = await mountSync(tmp.path)
    try {
      emit(sessionUpdated(makeSession("ses_b")))
      await wait(() => sync.data.session.length === 1)
      emit(workflowStarted("ses_b", "run_b", "deep-research"))
      await wait(() => Object.keys(sync.data.workflow).length === 1)
      emit({ directory, project: "proj_test", payload: { id: "p1", type: "workflow.phase", properties: { sessionID: "ses_b", runID: "run_b", title: "Search" } } as unknown as GlobalEvent["payload"] })
      await wait(() => (sync.data.workflow["run_b"] as { currentPhase?: string }).currentPhase === "Search")

      emit(workflowProgress("ses_b", "run_b", 2, 4, 0))
      await wait(() => (sync.data.workflow["run_b"] as { succeeded: number }).succeeded === 4)

      const run = sync.data.workflow["run_b"]
      expect(run.name).toBe("deep-research")
      expect(run.status).toBe("running")
      expect(run.currentPhase).toBe("Search")
      expect(run.running).toBe(2)
      expect(run.succeeded).toBe(4)
      expect(run.failed).toBe(0)
    } finally {
      app.renderer.destroy()
    }
  })
})
