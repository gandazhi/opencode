/** @jsxImportSource @opentui/solid */
import { InputRenderable, ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, Show, onMount } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import * as fuzzysort from "fuzzysort"
import { useSync, type WorkflowRun } from "../context/sync"
import { useRoute } from "../context/route"
import { useDialog } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useToast } from "../ui/toast"
import { useTheme } from "../context/theme"
import { useBindings } from "../keymap"
import { derivePhaseStates, type PhaseState } from "../util/workflow-phases"
import { descendantSessionIDs } from "../routes/session/sidebar-workflows"

const STATUS_GLYPH: Record<WorkflowRun["status"], string> = {
  running: "●",
  completed: "✓",
  failed: "✗",
  cancelled: "⊘",
}

const STATUS_COLOR: Record<WorkflowRun["status"], "info" | "success" | "error" | "warning"> = {
  running: "info",
  completed: "success",
  failed: "error",
  cancelled: "warning",
}

const PHASE_GLYPH: Record<PhaseState, string> = {
  done: "✓",
  now: "●",
  failed: "✗",
  cancelled: "⊘",
  pending: "○",
}

function relativeTime(ts: number | undefined): string {
  if (!ts) return ""
  const seconds = Math.floor((Date.now() - ts) / 1000)
  if (seconds < 5) return "just now"
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  return `${Math.floor(seconds / 3600)}h ago`
}

export function WorkflowDetailDialog() {
  const sync = useSync()
  const route = useRoute()
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()

  const sessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))

  const dimensions = useTerminalDimensions()
  const bodyHeight = createMemo(() => Math.max(6, Math.floor(dimensions().height * 0.6)))

  const [selected, setSelected] = createSignal(0)
  const [filter, setFilter] = createSignal("")
  const [filterMode, setFilterMode] = createSignal(false)
  let input: InputRenderable | undefined
  let listScroll: ScrollBoxRenderable | undefined

  onMount(() => {
    dialog.setSize("xlarge")
    void sync.workflow.load()
  })

  const sorted = createMemo(() => {
    const all = Object.values(sync.data.workflow)
    const sid = sessionID()
    if (!sid) return all.toSorted((a, b) => b.runID.localeCompare(a.runID))
    const reachable = descendantSessionIDs(sync.data.session, sid)
    return all.filter((run) => reachable.has(run.sessionID)).toSorted((a, b) => b.runID.localeCompare(a.runID))
  })

  const filtered = createMemo(() => {
    const needle = filter().trim()
    if (!needle) return sorted()
    return fuzzysort
      .go(needle, sorted(), { key: "name" })
      .map((r) => r.obj)
  })

  const clamp = (next: number) => {
    const count = filtered().length
    if (count === 0) return 0
    return (((next % count) + count) % count)
  }

  const selectedRun = createMemo(() => {
    const list = filtered()
    return list[Math.min(selected(), Math.max(0, list.length - 1))] as WorkflowRun | undefined
  })

  const phases = createMemo(() => {
    const run = selectedRun()
    if (!run) return []
    return derivePhaseStates({ phases: run.phases, currentPhase: run.currentPhase, status: run.status })
  })

  createEffect(() => {
    const idx = selected()
    const count = filtered().length
    if (!listScroll || count === 0) return
    const child = listScroll.getChildren()[idx]
    if (!child) return
    const y = child.y - listScroll.y
    if (y >= listScroll.height) listScroll.scrollBy(y - listScroll.height + 1)
    else if (y < 0) listScroll.scrollBy(y)
  })

  function move(delta: number) {
    setSelected((prev) => clamp(prev + delta))
  }

  function enterFilter() {
    setFilterMode(true)
    setTimeout(() => input?.focus(), 1)
  }

  function exitFilter() {
    setFilterMode(false)
    setFilter("")
    input?.blur()
    setSelected(0)
  }

  async function tryCancel() {
    const run = selectedRun()
    if (!run) return
    if (run.status !== "running") return
    await sync.workflow.cancel(run.runID)
    toast.show({ message: "Workflow cancelled", variant: "info" })
  }

  async function tryDelete() {
    const run = selectedRun()
    if (!run) return
    if (run.status === "running") return
    const confirmed = await DialogConfirm.show(dialog, "Delete workflow", "Permanently delete this run?", "delete")
    if (confirmed) {
      await sync.workflow.remove(run.runID)
      toast.show({ message: "Workflow deleted", variant: "info" })
    }
  }

  async function tryResume() {
    const run = selectedRun()
    if (!run) return
    if (run.status === "running") return
    await sync.workflow.resume(run.runID)
    toast.show({ message: "Workflow resumed", variant: "info" })
  }

  function openDetail() {
    const run = selectedRun()
    if (!run) return
    dialog.clear()
    route.navigate({ type: "workflow", runID: run.runID })
  }

  useBindings(() => ({
    bindings: [
      { key: "up", desc: "Previous run", group: "Workflow", cmd: () => move(-1) },
      { key: "down", desc: "Next run", group: "Workflow", cmd: () => move(1) },
      {
        key: "escape",
        desc: "Close dialog",
        group: "Workflow",
        cmd: () => {
          if (filterMode()) {
            exitFilter()
            return
          }
          dialog.clear()
        },
      },
      { key: "/", desc: "Filter", group: "Workflow", cmd: () => { if (!filterMode()) enterFilter() } },
      {
        key: "return",
        desc: "Open detail",
        group: "Workflow",
        cmd: () => {
          if (filterMode()) {
            exitFilter()
            return
          }
          openDetail()
        },
      },
      { key: "c", desc: "Cancel", group: "Workflow", cmd: () => { if (!filterMode()) void tryCancel() } },
      { key: "d", desc: "Delete", group: "Workflow", cmd: () => { if (!filterMode()) void tryDelete() } },
      { key: "r", desc: "Resume", group: "Workflow", cmd: () => { if (!filterMode()) void tryResume() } },
    ],
  }))

  return (
    <box flexDirection="column" flexGrow={1} paddingBottom={1}>
      <box paddingLeft={4} paddingRight={4} flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Workflows
        </text>
        <text fg={theme.textMuted}>esc to close</text>
      </box>

      <Show when={filterMode()}>
        <box paddingLeft={4} paddingRight={4} paddingTop={1}>
          <input
            onInput={(e: string) => { setFilter(e); setSelected(0) }}
            focusedBackgroundColor={theme.backgroundPanel}
            focusedTextColor={theme.textMuted}
            cursorColor={theme.primary}
            ref={(r: InputRenderable) => {
              input = r
              input.traits = { status: "FILTER" }
            }}
            placeholder="Filter by name"
            placeholderColor={theme.textMuted}
            value={filter()}
          />
        </box>
      </Show>

      <Show
        when={filtered().length > 0}
        fallback={
          <box paddingLeft={4} paddingRight={4} paddingTop={2}>
            <text fg={theme.textMuted}>No workflows. Start one via the workflow tool.</text>
          </box>
        }
      >
        <box flexGrow={1} flexDirection="row" paddingLeft={2} paddingRight={4} paddingTop={1}>
          <scrollbox
            width="40%"
            maxHeight={bodyHeight()}
            scrollbarOptions={{ visible: true }}
            ref={(r: ScrollBoxRenderable) => (listScroll = r)}
          >
            <For each={filtered()}>
              {(run, index) => {
                const active = createMemo(() => index() === selected())
                const colorKey = STATUS_COLOR[run.status]
                return (
                  <box
                    flexDirection="column"
                    backgroundColor={active() ? theme.primary : undefined}
                    paddingLeft={1}
                  >
                    <box flexDirection="row">
                      <text fg={active() ? theme.text : theme[colorKey]} flexShrink={0}>
                        {STATUS_GLYPH[run.status]}{" "}
                      </text>
                      <text fg={active() ? theme.text : theme.text} flexShrink={1} wrapMode="none">
                        {run.name}
                      </text>
                    </box>
                    <text fg={active() ? theme.text : theme.textMuted} wrapMode="none">
                      {"  "}
                      <Show when={run.currentPhase} fallback={run.status}>
                        {run.currentPhase}
                      </Show>{" "}
                      {run.succeeded}✓ {run.failed}✗ {run.running}⟳
                    </text>
                  </box>
                )
              }}
            </For>
          </scrollbox>

          <DetailPane run={selectedRun()} phases={phases()} maxHeight={bodyHeight()} />
        </box>
      </Show>

      <box paddingLeft={4} paddingRight={4} paddingTop={1}>
        <text fg={theme.textMuted}>
          ↑/↓ select · enter open · / filter
          <Show when={selectedRun()?.status === "running"}> · c cancel</Show>
          <Show when={selectedRun() && selectedRun()!.status !== "running"}> · d delete · r resume</Show>
          {" · esc close"}
        </text>
      </box>
    </box>
  )
}

function DetailPane(props: {
  run: WorkflowRun | undefined
  phases: ReturnType<typeof derivePhaseStates>
  maxHeight: number
}) {
  const { theme } = useTheme()
  const run = () => props.run
  const counters = () => {
    const r = run()
    if (!r) return ""
    return `succeeded ${r.succeeded}   failed ${r.failed}   running ${r.running}   total ${r.agentCount}`
  }
  const argsText = () => {
    const r = run()
    if (!r || !r.args) return ""
    return JSON.stringify(r.args)
  }
  return (
    <Show
      when={run()}
      fallback={
        <box paddingLeft={2}>
          <text fg={theme.textMuted}>Select a run</text>
        </box>
      }
    >
      <scrollbox flexGrow={1} maxHeight={props.maxHeight} scrollbarOptions={{ visible: true }} paddingLeft={1} paddingRight={1}>
        <box flexDirection="row">
          <text fg={theme[STATUS_COLOR[run()!.status]]} flexShrink={0}>
            {STATUS_GLYPH[run()!.status]}{" "}
          </text>
          <text fg={theme.text} attributes={TextAttributes.BOLD} flexShrink={1} wrapMode="none">
            {run()!.name}
          </text>
          <text fg={theme.textMuted} flexGrow={1} />
          <text fg={theme.textMuted} flexShrink={0} wrapMode="none">
            {run()!.runID.slice(0, 16)}
          </text>
        </box>

        <text fg={theme.textMuted} wrapMode="none">
          created {relativeTime(run()!.createdAt)} · updated {relativeTime(run()!.updatedAt)}
          <Show when={run()!.currentPhase}> · phase: {run()!.currentPhase}</Show>
        </text>

        <text fg={theme.text} paddingTop={1}>
          {counters()}
        </text>

        <Show when={props.phases.length > 0}>
          <box flexDirection="column" paddingTop={1}>
            <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
              PHASES
            </text>
            <For each={props.phases}>
              {(entry) => {
                const colorKey = entry.state === "done" ? "success" : entry.state === "now" ? "info" : entry.state === "failed" ? "error" : entry.state === "cancelled" ? "warning" : "textMuted"
                return (
                  <box flexDirection="row">
                    <text fg={theme[colorKey]} flexShrink={0}>
                      {PHASE_GLYPH[entry.state]}{" "}
                    </text>
                    <text fg={entry.state === "now" ? theme.info : theme.text} flexShrink={1} wrapMode="none">
                      {entry.phase.title}
                    </text>
                    <Show when={entry.state === "now"}>
                      <text fg={theme.textMuted}>{"  ◄ running"}</text>
                    </Show>
                  </box>
                )
              }}
            </For>
          </box>
        </Show>

        <Show when={argsText()}>
          <box flexDirection="column" paddingTop={1}>
            <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
              ARGS
            </text>
            <text fg={theme.secondary} wrapMode="word">
              {argsText()}
            </text>
          </box>
        </Show>

        <Show when={run()!.status === "failed" && run()!.error}>
          <box flexDirection="column" paddingTop={1}>
            <text fg={theme.error} attributes={TextAttributes.BOLD}>
              ERROR
            </text>
            <text fg={theme.error} wrapMode="word">
              ▌ {run()!.error}
            </text>
          </box>
        </Show>
      </scrollbox>
    </Show>
  )
}
