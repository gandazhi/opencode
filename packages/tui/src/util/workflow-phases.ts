export type WorkflowPhase = { title: string; detail?: string }

export type PhaseState = "done" | "now" | "failed" | "cancelled" | "pending"

export type PhaseEntry = { phase: WorkflowPhase; state: PhaseState }

export type PhasedRun = {
  phases?: WorkflowPhase[]
  currentPhase?: string
  status: "running" | "completed" | "failed" | "cancelled"
}

export function derivePhaseStates(run: PhasedRun): PhaseEntry[] {
  const phases = run.phases
  if (!phases || phases.length === 0) return []
  if (run.status === "completed") {
    return phases.map((phase) => ({ phase, state: "done" as const }))
  }
  const idx = phases.findIndex((p) => p.title === run.currentPhase)
  if (idx === -1) {
    return phases.map((phase) => ({ phase, state: "pending" as const }))
  }
  const now: PhaseState = run.status === "failed" ? "failed" : run.status === "cancelled" ? "cancelled" : "now"
  return phases.map((phase, i) => {
    if (i < idx) return { phase, state: "done" as const }
    if (i === idx) return { phase, state: now }
    return { phase, state: "pending" as const }
  })
}
