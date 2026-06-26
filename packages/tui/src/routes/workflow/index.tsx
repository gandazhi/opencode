/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useSync } from "../../context/sync"
import { useSDK } from "../../context/sdk"
import { useRoute } from "../../context/route"
import { useTheme } from "../../context/theme"
import { useToast } from "../../ui/toast"
import { useDialog } from "../../ui/dialog"
import { DialogConfirm } from "../../ui/dialog-confirm"
import { useBindings, useOpencodeModeStack } from "../../keymap"

const STATUS_GLYPH: Record<string, string> = {
  running: "◐",
  completed: "✓",
  failed: "✗",
  cancelled: "⊘",
  succeeded: "✓",
}

const STATUS_COLOR: Record<string, "success" | "error" | "warning" | "info"> = {
  running: "info",
  completed: "success",
  failed: "error",
  cancelled: "warning",
  succeeded: "success",
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

function formatCost(cost?: number | null): string {
  if (cost == null) return ""
  return `$${cost.toFixed(2)}`
}

function formatToolInput(input: Record<string, unknown>): string {
  const skip = new Set(["metadata"])
  const parts: string[] = []
  for (const [key, value] of Object.entries(input)) {
    if (skip.has(key)) continue
    if (typeof value === "string") {
      const truncated = value.length > 80 ? value.slice(0, 77) + "…" : value
      parts.push(`${key}: "${truncated}"`)
    } else if (typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}: ${value}`)
    }
  }
  return parts.join("  ")
}

export function WorkflowDetail() {
  const sync = useSync()
  const sdk = useSDK()
  const route = useRoute()
  const { theme } = useTheme()
  const toast = useToast()
  const dialog = useDialog()

  const runID = createMemo(() => (route.data.type === "workflow" ? route.data.runID : ""))
  const run = createMemo(() => sync.data.workflow[runID()])
  const agents = createMemo(() => run()?.agents ?? [])
  const logs = createMemo(() => run()?.logs ?? [])

  const [selectedAgent, setSelectedAgent] = createSignal(0)
  const [now, setNow] = createSignal(Date.now())
  const modeStack = useOpencodeModeStack()

  const selectedAgentSessionID = createMemo(() => agents()[selectedAgent()]?.sessionID)
  const [agentToolCalls, setAgentToolCalls] = createSignal<any[]>([])

  createEffect(() => {
    const sessionID = selectedAgentSessionID()
    if (!sessionID) {
      setAgentToolCalls([])
      return
    }
    void (async () => {
      try {
        const result = await sdk.client.session.messages({ sessionID, limit: 100 })
        const tools = (result.data ?? []).flatMap((msg: any) =>
          (msg.parts ?? []).filter((p: any) => p.type === "tool"),
        )
        setAgentToolCalls(tools)
      } catch {
        setAgentToolCalls([])
      }
    })()
  })

  onMount(() => {
    void sync.workflow.detail(runID())
    const interval = setInterval(() => setNow(Date.now()), 1000)
    const popMode = modeStack.push("workflow.detail")
    onCleanup(() => {
      clearInterval(interval)
      popMode()
    })
  })

  const headerLine = createMemo(() => {
    const r = run()
    if (!r) return "Loading..."
    const counters = `${r.succeeded}✓ ${r.failed}✗ ${r.running}…`
    const phase = r.currentPhase ? `· phase: ${r.currentPhase}` : ""
    const totalCost = agents().reduce((sum, a) => sum + (a.cost ?? 0), 0)
    const costStr = totalCost > 0 ? `· $${totalCost.toFixed(2)}` : ""
    return `${r.name} · ${STATUS_GLYPH[r.status] ?? "?"} ${r.status} ${phase} · ${counters} ${costStr}`
  })

  function moveAgent(dir: number) {
    const count = agents().length
    if (count === 0) return
    setSelectedAgent((prev) => {
      const next = prev + dir
      if (next < 0) return count - 1
      if (next >= count) return 0
      return next
    })
  }

  async function doCancel() {
    await sync.workflow.cancel(runID())
    toast.show({ message: "Workflow cancelled", variant: "info" })
  }

  async function doDelete() {
    const confirmed = await DialogConfirm.show(dialog, "Delete workflow", "Permanently delete this run?", "delete")
    if (!confirmed) return
    await sync.workflow.remove(runID())
    toast.show({ message: "Workflow deleted", variant: "info" })
    route.navigate({ type: "home" })
  }

  async function doResume() {
    await sync.workflow.resume(runID())
    toast.show({ message: "Workflow resumed", variant: "info" })
  }

  function openChildSession() {
    const agent = agents()[selectedAgent()]
    if (!agent?.sessionID) {
      toast.show({ message: "No session for this agent", variant: "warning" })
      return
    }
    route.navigate({ type: "session", sessionID: agent.sessionID })
  }

  useBindings(() => ({
    mode: "workflow.detail",
    bindings: [
      { key: "up", desc: "Previous agent", group: "Workflow", cmd: () => moveAgent(-1) },
      { key: "down", desc: "Next agent", group: "Workflow", cmd: () => moveAgent(1) },
      { key: "enter", desc: "Open child session", group: "Workflow", cmd: openChildSession },
      { key: "c", desc: "Cancel", group: "Workflow", cmd: doCancel },
      { key: "r", desc: "Resume", group: "Workflow", cmd: doResume },
      { key: "d", desc: "Delete", group: "Workflow", cmd: doDelete },
      { key: "escape", desc: "Back", group: "Workflow", cmd: () => route.navigate({ type: "home" }) },
      { key: "q", desc: "Back", group: "Workflow", cmd: () => route.navigate({ type: "home" }) },
    ],
  }))

  const logsHeight = 4

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.background}>
      <box paddingLeft={1} paddingRight={1} flexShrink={0}>
        <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
          {headerLine()}
        </text>
      </box>

      <box flexShrink={0} flexDirection="column" paddingLeft={1} paddingRight={1}>
        <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
          Agents ({agents().length})
        </text>
        <scrollbox maxHeight={Math.max(1, Math.min(agents().length, 6))} scrollbarOptions={{ visible: false }}>
          <For each={agents()}>
            {(agent, index) => {
              const active = createMemo(() => index() === selectedAgent())
              const agentDuration = createMemo(() => {
                if (agent.endedAt) return agent.endedAt - agent.startedAt
                return now() - agent.startedAt
              })
              const colorKey = STATUS_COLOR[agent.status] ?? "info"
              const color = theme[colorKey] ?? theme.text
              return (
                <box flexDirection="row" backgroundColor={active() ? theme.primary : undefined} paddingLeft={1}>
                  <text fg={color} flexShrink={0}>
                    {active() ? "▌" : " "}
                  </text>
                  <text fg={color} flexShrink={0}>
                    {STATUS_GLYPH[agent.status] ?? "?"}{" "}
                  </text>
                  <text fg={active() ? theme.text : theme.text} flexShrink={0} wrapMode="none">
                    {agent.agentType.slice(0, 10).padEnd(10)}{" "}
                  </text>
                  <text fg={theme.textMuted} flexGrow={1} flexShrink={1} wrapMode="none">
                    {(agent.label ?? "").slice(0, 30)}{" "}
                  </text>
                  <text fg={theme.textMuted} flexShrink={0}>
                    {agent.phase ?? ""}{" "}
                  </text>
                  <text fg={theme.textMuted} flexShrink={0}>
                    {formatDuration(agentDuration())}{" "}
                  </text>
                  <Show when={agent.cost != null}>
                    <text fg={theme.textMuted} flexShrink={0}>
                      {formatCost(agent.cost)}{" "}
                    </text>
                  </Show>
                  <Show when={agent.reason}>
                    <text fg={theme.error} flexShrink={0}>
                      {agent.reason}
                    </text>
                  </Show>
                </box>
              )
            }}
          </For>
        </scrollbox>
      </box>

      <box flexGrow={1} flexDirection="column" paddingLeft={1} paddingRight={1} minHeight={0}>
        <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
          Tool calls ({agentToolCalls().length})
        </text>
        <scrollbox flexGrow={1} scrollbarOptions={{ visible: true }}>
          <For each={agentToolCalls()}>
            {(tool) => {
              const status = tool.state?.status ?? "running"
              const glyph = STATUS_GLYPH[status] ?? "?"
              const colorKey = STATUS_COLOR[status] ?? "info"
              const color = theme[colorKey] ?? theme.text
              return (
                <box flexDirection="column" paddingBottom={0}>
                  <box flexDirection="row">
                    <text fg={color} flexShrink={0}>
                      {glyph}{" "}
                    </text>
                    <text fg={theme.text} flexShrink={0} wrapMode="none">
                      {(tool.tool ?? "unknown").slice(0, 28).padEnd(28)}{" "}
                    </text>
                    <text fg={theme.textMuted} flexGrow={1} flexShrink={1} wrapMode="none">
                      {formatToolInput(tool.state?.input ?? {})}
                    </text>
                  </box>
                  <Show when={tool.state?.status === "completed" && tool.state?.output}>
                    <text fg={theme.textMuted} flexGrow={1} flexShrink={1} wrapMode="none" paddingLeft={2}>
                      {"→ "} {(tool.state.output ?? "").slice(0, 120)}
                    </text>
                  </Show>
                </box>
              )
            }}
          </For>
        </scrollbox>
      </box>

      <box height={logsHeight} flexShrink={0} paddingLeft={1} paddingRight={1} flexDirection="column">
        <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
          Logs
        </text>
        <scrollbox flexGrow={1} scrollbarOptions={{ visible: false }}>
          <For each={logs().slice(-20)}>
            {(log) => (
              <text fg={theme.textMuted} wrapMode="none">
                {log}
              </text>
            )}
          </For>
        </scrollbox>
      </box>

      <box paddingLeft={1} paddingRight={1} flexShrink={0} flexDirection="row" gap={2}>
        <text fg={theme.textMuted}>
          <Show when={run()?.status === "running"}>[c] cancel </Show>
          <Show when={run()?.status !== "running"}>[r] resume [d] delete </Show>
          [Enter] session [esc] back
        </text>
      </box>
    </box>
  )
}
