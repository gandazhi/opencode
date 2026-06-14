/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { onMount } from "solid-js"
import { testRender } from "@opentui/solid"
import { tmpdir } from "../../fixture/fixture"
import type { GlobalEvent, Session } from "@opencode-ai/sdk/v2"
import { ArgsProvider } from "../../../src/context/args"
import { ExitProvider } from "../../../src/context/exit"
import { KVProvider } from "../../../src/context/kv"
import { SDKProvider } from "../../../src/context/sdk"
import { ProjectProvider } from "../../../src/context/project"
import { SyncProvider, useSync } from "../../../src/context/sync"
import { ThemeProvider } from "../../../src/context/theme"
import { TuiConfigProvider } from "../../../src/config"
import { SidebarWorkflows } from "../../../src/routes/session/sidebar-workflows"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { wait, createEventSource, createFetch, directory } from "../../cli/cmd/tui/sync-fixture"

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

async function mountSidebar(sessionID: string, state: string) {
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
                      <SidebarWorkflows sessionID={sessionID} />
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

describe("SidebarWorkflows", () => {
  test("shows workflows that run in a descendant session", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const viewedID = "ses_parent"
    const { app, emit, sync } = await mountSidebar(viewedID, tmp.path)
    try {
      emit(sessionUpdated(makeSession(viewedID)))
      emit(sessionUpdated(makeSession("ses_child", viewedID)))
      emit(sessionUpdated(makeSession("ses_unrelated")))
      await wait(() => sync.data.session.length === 3)

      emit(workflowStarted("ses_child", "run_visible", "Visible Workflow"))
      emit(workflowStarted("ses_unrelated", "run_hidden", "Hidden Workflow"))
      await wait(() => Object.keys(sync.data.workflow).length === 2)

      await app.renderOnce()
      const frame = app.captureCharFrame()
      expect(frame).toContain("Visible Workflow")
      expect(frame).not.toContain("Hidden Workflow")
    } finally {
      app.renderer.destroy()
    }
  })
})
