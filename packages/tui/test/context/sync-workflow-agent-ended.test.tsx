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
function workflowAgentStarted(sessionID: string, runID: string, key: string): GlobalEvent {
  return { directory, project: "proj_test", payload: { id: `evt_was_${key}`, type: "workflow.agent_started", properties: { sessionID, runID, key, agentType: "general" } } as unknown as GlobalEvent["payload"] }
}
function workflowAgentEnded(sessionID: string, runID: string, key: string, cost: unknown): GlobalEvent {
  return { directory, project: "proj_test", payload: { id: `evt_wae_${key}`, type: "workflow.agent_ended", properties: { sessionID, runID, key, status: "succeeded", cost } } as unknown as GlobalEvent["payload"] }
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

describe("Sync workflow.agent_ended", () => {
  // Regression: a live workflow.agent_ended event carrying cost:null crashed the
  // WorkflowDetail render (formatCost(null) -> "null is not an object (evaluating
  // .toFixed)"). The agent_ended handler must reject non-number cost instead of
  // spreading null into the store.
  test("cost:null from agent_ended does not propagate as null into the store", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync } = await mountSync(tmp.path)
    try {
      emit(sessionUpdated(makeSession("ses_a")))
      await wait(() => sync.data.session.length === 1)
      emit(workflowStarted("ses_a", "run_a", "deep-research"))
      await wait(() => Object.keys(sync.data.workflow).length === 1)
      emit(workflowAgentStarted("ses_a", "run_a", "agent_0"))
      await wait(() => (sync.data.workflow["run_a"].agents?.length ?? 0) === 1)
      emit(workflowAgentEnded("ses_a", "run_a", "agent_0", null))
      await wait(() => (sync.data.workflow["run_a"].agents![0] as { status?: string }).status === "succeeded")

      const agent = sync.data.workflow["run_a"].agents![0] as { cost?: number | null }
      expect(agent.cost).not.toBeNull()
    } finally {
      app.renderer.destroy()
    }
  })

  test("numeric cost from agent_ended is stored", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync } = await mountSync(tmp.path)
    try {
      emit(sessionUpdated(makeSession("ses_b")))
      await wait(() => sync.data.session.length === 1)
      emit(workflowStarted("ses_b", "run_b", "deep-research"))
      await wait(() => Object.keys(sync.data.workflow).length === 1)
      emit(workflowAgentStarted("ses_b", "run_b", "agent_0"))
      await wait(() => (sync.data.workflow["run_b"].agents?.length ?? 0) === 1)
      emit(workflowAgentEnded("ses_b", "run_b", "agent_0", 0.0123))
      await wait(() => (sync.data.workflow["run_b"].agents![0] as { cost?: number }).cost === 0.0123)

      const agent = sync.data.workflow["run_b"].agents![0] as { cost?: number }
      expect(agent.cost).toBe(0.0123)
    } finally {
      app.renderer.destroy()
    }
  })
})
