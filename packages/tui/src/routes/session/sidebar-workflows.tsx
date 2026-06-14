import { createMemo, For, Show } from "solid-js"
import type { Session } from "@opencode-ai/sdk/v2"
import { useSync, type WorkflowRun } from "../../context/sync"
import { useTheme } from "../../context/theme"

const STATUS_COLOR: Record<WorkflowRun["status"], "success" | "error" | "warning" | "info"> = {
  running: "info",
  completed: "success",
  failed: "error",
  cancelled: "warning",
}

const STATUS_GLYPH: Record<WorkflowRun["status"], string> = {
  running: "◐",
  completed: "✓",
  failed: "✗",
  cancelled: "⊘",
}

/**
 * Inline workflow status for the session sidebar. Shows only the runs belonging
 * to the current session — running ones first, then the most recent finished —
 * capped so a runaway fan-out can't push the rest of the sidebar off-screen.
 */
export function SidebarWorkflows(props: { sessionID: string }) {
  const sync = useSync()
  const { theme } = useTheme()

  const runs = createMemo(() => {
    const reachable = descendantSessionIDs(sync.data.session, props.sessionID)
    return Object.values(sync.data.workflow)
      .filter((run) => reachable.has(run.sessionID))
      .toSorted((a, b) => b.runID.localeCompare(a.runID))
  })

  // Running runs always show; keep at most 3 most-recent finished so the block
  // stays compact once a session has accumulated history.
  const visible = createMemo(() => {
    const all = runs()
    const running = all.filter((run) => run.status === "running")
    const finished = all.filter((run) => run.status !== "running").slice(0, 3)
    return [...running, ...finished]
  })

  return (
    <Show when={visible().length > 0}>
      <box flexDirection="column" gap={0} paddingTop={1}>
        <text fg={theme.textMuted}>Workflows</text>
        <For each={visible()}>
          {(run) => {
            return (
              <box flexDirection="column">
                <text>
                  <span style={{ fg: theme[STATUS_COLOR[run.status]] }}>{STATUS_GLYPH[run.status]}</span>{" "}
                  <span style={{ fg: theme.text }}>{run.name}</span>
                </text>
                <text fg={theme.textMuted}>
                  <Show when={run.currentPhase} fallback={run.status}>
                    {run.currentPhase}
                  </Show>
                  {" · "}
                  {run.succeeded}✓ {run.failed}✗ {run.running}…
                </text>
                <Show when={run.logs?.length}>
                  <text fg={theme.textMuted}>{run.logs[run.logs.length - 1].slice(0, 50)}</text>
                </Show>
                <Show when={run.status === "failed" && run.error}>
                  <text fg={theme.textMuted}>{run.error!.slice(0, 60)}</text>
                </Show>
              </box>
            )
          }}
        </For>
      </box>
    </Show>
  )
}

function descendantSessionIDs(sessions: Session[], root: string): Set<string> {
  const byParent = new Map<string, string[]>()
  for (const session of sessions) {
    if (!session.parentID) continue
    byParent.set(session.parentID, [...(byParent.get(session.parentID) ?? []), session.id])
  }
  const out = new Set<string>([root])
  const stack = [root]
  while (stack.length) {
    const current = stack.pop()!
    for (const child of byParent.get(current) ?? []) {
      if (out.has(child)) continue
      out.add(child)
      stack.push(child)
    }
  }
  return out
}
