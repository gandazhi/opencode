import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { WorkflowTool } from "@/tool/workflow"
import { workflowRef } from "@/workflow/runtime-ref"
import type { Interface as WorkflowRuntimeInterface } from "@/workflow/runtime"
import { Truncate } from "@/tool/truncate"
import { Agent } from "@/agent/agent"
import { TestConfig } from "../fixture/config"

const agentInfo = (): Agent.Info => ({
  name: "build",
  description: "",
  mode: "primary",
  permission: [],
  options: {},
})

const mockAgent = Layer.succeed(
  Agent.Service,
  Agent.Service.of({
    get: () => Effect.succeed(agentInfo()),
    list: () => Effect.succeed([]),
    defaultInfo: () => Effect.succeed(agentInfo()),
    defaultAgent: () => Effect.succeed("build"),
    generate: () => Effect.die("not used"),
  }),
)

const testLayer = Layer.mergeAll(TestConfig.layer(), Truncate.defaultLayer, mockAgent)
const configLayer = (get: () => Effect.Effect<unknown>) =>
  Layer.mergeAll(
    Truncate.defaultLayer,
    mockAgent,
    TestConfig.layer({ get: get as never }),
  )

function mockRuntime(capture: { agentTimeoutMs?: number }): WorkflowRuntimeInterface {
  return {
    start: (input) =>
      Effect.sync(() => {
        capture.agentTimeoutMs = input.agentTimeoutMs
        return { runID: "wf_test" }
      }),
    status: () => Effect.succeed({ status: "unknown", agentCount: 0 }),
    wait: () => Effect.succeed({ status: "cancelled" }),
    cancel: () => Effect.void,
    list: () => Effect.succeed([]),
    resume: () => Effect.succeed({ runID: "wf_test", resumed: false }),
    detail: () => Effect.succeed({ status: "unknown" }),
    remove: () => Effect.void,
  } satisfies WorkflowRuntimeInterface
}

describe("workflow tool per-agent timeout", () => {
  // The per-agent timeout is OFF by default so long-running legitimate agents
  // (multi-step search+fetch+reason) are never cancelled. It is opt-in via
  // config.workflow.agentTimeoutMs for users who want a safety net against
  // a single hung LLM call stalling a parallel/pipeline barrier. The TUI
  // progress display lets users spot a stuck run and cancel it manually.
  it("omits agentTimeoutMs when config does not set it (default OFF)", async () => {
    const captured: { agentTimeoutMs?: number } = {}
    const original = workflowRef.current
    workflowRef.current = mockRuntime(captured)
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const info = yield* WorkflowTool
          const tool = yield* info.init()
          yield* tool
            .execute(
              { operation: "run", name: "deep-research" },
              { sessionID: "ses_test", agent: "main" } as never,
            )
            .pipe(Effect.orDie)
        }).pipe(Effect.provide(testLayer)),
      )
    } finally {
      workflowRef.current = original
    }

    expect(captured.agentTimeoutMs).toBeUndefined()
  })

  it("forwards a config-provided agentTimeoutMs to runtime.start", async () => {
    const captured: { agentTimeoutMs?: number } = {}
    const original = workflowRef.current
    workflowRef.current = mockRuntime(captured)
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const info = yield* WorkflowTool
          const tool = yield* info.init()
          yield* tool
            .execute(
              { operation: "run", name: "deep-research" },
              { sessionID: "ses_test", agent: "main" } as never,
            )
            .pipe(Effect.orDie)
        }).pipe(
          Effect.provide(
            configLayer(() => Effect.succeed({ workflow: { agentTimeoutMs: 42 } })),
          ),
        ),
      )
    } finally {
      workflowRef.current = original
    }

    expect(captured.agentTimeoutMs).toBe(42)
  })
})
