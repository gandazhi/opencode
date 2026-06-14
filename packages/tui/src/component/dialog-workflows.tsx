import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useDialog } from "../ui/dialog"
import { useSync, type WorkflowRun } from "../context/sync"
import { useRoute } from "../context/route"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"
import { createMemo, onMount } from "solid-js"

const STATUS_LABEL: Record<WorkflowRun["status"], string> = {
  running: "running",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
}

export function DialogWorkflows() {
  const dialog = useDialog()
  const sync = useSync()
  const route = useRoute()
  const { theme } = useTheme()
  const toast = useToast()

  const sessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))

  onMount(() => {
    dialog.setSize("large")
    void sync.workflow.load(sessionID())
  })

  const runs = createMemo(() => Object.values(sync.data.workflow).toSorted((a, b) => b.runID.localeCompare(a.runID)))

  const options = createMemo((): DialogSelectOption<string>[] =>
    runs().map((run) => {
      const counters = `${run.succeeded}+${run.failed}/${run.running + run.succeeded + run.failed}`
      const description = `${STATUS_LABEL[run.status]} ${run.currentPhase ? "· " + run.currentPhase : ""} · ${counters}`
      return {
        title: run.name,
        description,
        value: run.runID,
        footer: run.error ? run.error.slice(0, 60) : undefined,
      }
    }),
  )

  async function tryResume(runID: string) {
    const confirmed = await DialogConfirm.show(
      dialog,
      "Resume workflow",
      "Restart this workflow from its journal?",
      "resume",
    )
    if (!confirmed) {
      dialog.replace(() => <DialogWorkflows />)
      return
    }
    try {
      await sync.workflow.resume(runID)
      toast.show({ message: "Workflow resumed", variant: "info" })
    } catch (err) {
      toast.show({
        title: "Failed to resume workflow",
        message: err instanceof Error ? err.message : String(err),
        variant: "error",
      })
    }
    dialog.replace(() => <DialogWorkflows />)
  }

  return (
    <DialogSelect
      title="Workflows"
      options={options()}
      onSelect={(option) => {
        const run = sync.data.workflow[option.value]
        if (!run) {
          dialog.clear()
          return
        }
        if (run.status === "running") {
          dialog.clear()
          return
        }
        void tryResume(option.value)
      }}
    />
  )
}
