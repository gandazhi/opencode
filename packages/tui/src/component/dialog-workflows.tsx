import { DialogSelect } from "../ui/dialog-select"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useDialog } from "../ui/dialog"
import { useSync, type WorkflowRun } from "../context/sync"
import { useRoute } from "../context/route"
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
  const toast = useToast()

  const sessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))

  onMount(() => {
    dialog.setSize("large")
    void sync.workflow.load(sessionID())
  })

  const runs = createMemo(() => Object.values(sync.data.workflow).toSorted((a, b) => b.runID.localeCompare(a.runID)))

  const options = createMemo(() =>
    runs().map((run) => {
      const counters = `${run.succeeded}✓ ${run.failed}✗ ${run.running}…`
      const tail = run.logs?.length ? run.logs[run.logs.length - 1].slice(0, 50) : undefined
      const description = `${STATUS_LABEL[run.status]} ${run.currentPhase ? "· " + run.currentPhase : ""} · ${counters}${tail ? " · " + tail : ""}`
      return {
        title: run.name,
        description,
        value: run.runID,
        footer: run.error ? run.error.slice(0, 60) : undefined,
      }
    }),
  )

  async function tryCancel(runID: string) {
    await sync.workflow.cancel(runID)
    toast.show({ message: "Workflow cancelled", variant: "info" })
    dialog.replace(() => <DialogWorkflows />)
  }

  async function tryDelete(runID: string) {
    const confirmed = await DialogConfirm.show(dialog, "Delete workflow", "Permanently delete this run?", "delete")
    if (!confirmed) {
      dialog.replace(() => <DialogWorkflows />)
      return
    }
    await sync.workflow.remove(runID)
    toast.show({ message: "Workflow deleted", variant: "info" })
    dialog.replace(() => <DialogWorkflows />)
  }

  return (
    <DialogSelect
      title="Workflows"
      options={options()}
      actions={[
        {
          command: "workflow.cancel",
          title: "Cancel",
          side: "right",
          disabled: (option) => {
            if (!option) return true
            const run = sync.data.workflow[option.value]
            return !run || run.status !== "running"
          },
          onTrigger: (option) => {
            if (option) void tryCancel(option.value)
          },
        },
        {
          command: "workflow.delete",
          title: "Delete",
          side: "right",
          disabled: (option) => {
            if (!option) return true
            const run = sync.data.workflow[option.value]
            return !run || run.status === "running"
          },
          onTrigger: (option) => {
            if (option) void tryDelete(option.value)
          },
        },
      ]}
      onSelect={(option) => {
        dialog.clear()
        route.navigate({ type: "workflow", runID: option.value })
      }}
    />
  )
}
