import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, Show } from "solid-js"

const id = "internal:sidebar-goal"

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const goal = createMemo(() => props.api.state.session.goal(props.session_id))
  const show = createMemo(() => !!goal()?.condition)

  const status = createMemo(() => {
    const g = goal()
    if (!g?.lastMessageID) return null
    const v = g.verdicts[g.lastMessageID]
    if (!v) return null
    if (v.ok) return { icon: "\u2713", text: "goal met", color: theme().primary }
    if (v.impossible) return { icon: "\u2298", text: "impossible", color: theme().text }
    if (v.error) return { icon: "!", text: "judge error", color: theme().text }
    return { icon: "\u27F3", text: `round ${v.attempt} \u00B7 not met`, color: theme().text }
  })

  return (
    <Show when={show()}>
      <box>
        <box flexDirection="row" gap={1}>
          <text fg={theme().primary}>
            <b>Goal</b>
          </text>
        </box>
        <box flexDirection="row" gap={1}>
          <text fg={theme().textMuted}>{goal()?.condition}</text>
        </box>
        <Show when={status()}>
          <box flexDirection="row" gap={1}>
            <text fg={status()!.color}>{status()!.icon}</text>
            <text fg={theme().textMuted}>{status()!.text}</text>
          </box>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 380,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = { id, tui }
export default plugin
