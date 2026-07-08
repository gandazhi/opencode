import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import type { InstanceContext } from "@/project/instance-context"
import { Effect, Layer, Context, Schema } from "effect"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "../mcp"
import { Skill } from "../skill"
import { listSavedWorkflows } from "@/workflow/resolve"
import PROMPT_INITIALIZE from "./template/initialize.txt"
import PROMPT_REVIEW from "./template/review.txt"
import { LegacyEvent } from "@opencode-ai/schema/legacy-event"

type State = {
  commands: Record<string, Info>
}

export const Event = {
  Executed: LegacyEvent.CommandExecuted,
}

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  source: Schema.optional(Schema.Literals(["command", "mcp", "skill"])),
  // Some command templates are lazy promises from MCP prompt resolution.
  template: Schema.Unknown,
  subtask: Schema.optional(Schema.Boolean),
  hints: Schema.Array(Schema.String),
}).annotate({ identifier: "Command" })

export type Info = Omit<Schema.Schema.Type<typeof Info>, "template"> & { template: Promise<string> | string }

export function hints(template: string) {
  const result: string[] = []
  const numbered = template.match(/\$\d+/g)
  if (numbered) {
    for (const match of [...new Set(numbered)].sort()) result.push(match)
  }
  if (template.includes("$ARGUMENTS")) result.push("$ARGUMENTS")
  return result
}

export const Default = {
  INIT: "init",
  REVIEW: "review",
  GOAL: "goal",
  DEEP_RESEARCH: "deep-research",
} as const

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly list: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Command") {}

function deepResearchTemplate(): string {
  return [
    "The user requested a deep research report on:",
    "",
    "$ARGUMENTS",
    "",
    "Call the workflow tool NOW to start the deep-research workflow.",
    "Use exactly this call — do NOT ask questions, do NOT summarize, do NOT search manually:",
    "",
    '  workflow({ operation: "run", name: "deep-research", args: "$ARGUMENTS" })',
    "",
    "The workflow runs in the background. After calling the tool, tell the user the workflow has started",
    'and they can check /workflows for progress. When the workflow completes, relay its result.',
  ].join("\n")
}

// A saved workflow (from .opencode/workflows/ or .claude/workflows/) is exposed
// as a slash command whose template steers the model to invoke it by `name`.
// The workflow's description is included so the model can construct the correct
// `args` from the user's input without guessing.
function workflowCommandTemplate(name: string, description: string): string {
  return [
    `The user invoked the "${name}" workflow.`,
    "",
    description,
    "",
    "User input: $ARGUMENTS",
    "",
    `Call the workflow tool NOW to start the "${name}" workflow. Build the correct \`args\` JSON from the user input and the arguments described above, then call:`,
    "",
    `  workflow({ operation: "run", name: "${name}", args: <args JSON> })`,
    "",
    "Only ask the user a question if a required argument is missing. The workflow runs in the background; tell the user it has started and they can check /workflows for progress. When it completes, relay its result.",
  ].join("\n")
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const mcp = yield* MCP.Service
    const skill = yield* Skill.Service
    const flags = yield* RuntimeFlags.Service

    const init = Effect.fn("Command.state")(function* (ctx: InstanceContext) {
      const cfg = yield* config.get()
      const bridge = yield* EffectBridge.make()
      const commands: Record<string, Info> = {}

      commands[Default.INIT] = {
        name: Default.INIT,
        description: "guided AGENTS.md setup",
        source: "command",
        get template() {
          return PROMPT_INITIALIZE.replace("${path}", ctx.worktree)
        },
        hints: hints(PROMPT_INITIALIZE),
      }
      commands[Default.REVIEW] = {
        name: Default.REVIEW,
        description: "review changes [commit|branch|pr], defaults to uncommitted",
        source: "command",
        get template() {
          return PROMPT_REVIEW.replace("${path}", ctx.worktree)
        },
        subtask: true,
        hints: hints(PROMPT_REVIEW),
      }

      const goalTemplate =
        "Set a persistent stopping condition for this session. The assistant keeps working until the condition is met, then stops automatically.\n\nCondition: $ARGUMENTS\n\nPass empty, \"clear\", or \"reset\" to remove the current goal."
      commands[Default.GOAL] = {
        name: Default.GOAL,
        description: "set or clear a persistent stopping condition for this session",
        source: "command",
        get template() {
          return goalTemplate
        },
        hints: hints(goalTemplate),
      }

      commands[Default.DEEP_RESEARCH] = {
        name: Default.DEEP_RESEARCH,
        description: "run a deep, multi-source, fact-checked research workflow",
        source: "command",
        get template() {
          return deepResearchTemplate()
        },
        subtask: true,
        hints: hints(deepResearchTemplate()),
      }

      for (const [name, command] of Object.entries(cfg.command ?? {})) {
        commands[name] = {
          name,
          agent: command.agent,
          model: command.model,
          description: command.description,
          source: "command",
          get template() {
            return command.template
          },
          subtask: command.subtask,
          hints: hints(command.template),
        }
      }

      for (const [name, prompt] of Object.entries(yield* mcp.prompts())) {
        commands[name] = {
          name,
          source: "mcp",
          description: prompt.description,
          get template() {
            return bridge.promise(
              mcp
                .getPrompt(
                  prompt.client,
                  prompt.name,
                  prompt.arguments
                    ? Object.fromEntries(prompt.arguments.map((argument, i) => [argument.name, `$${i + 1}`]))
                    : {},
                )
                .pipe(
                  Effect.map(
                    (template) =>
                      template?.messages
                        .map((message) => (message.content.type === "text" ? message.content.text : ""))
                        .join("\n") || "",
                  ),
                ),
            )
          },
          hints: prompt.arguments?.map((_, i) => `$${i + 1}`) ?? [],
        }
      }

      for (const item of yield* skill.all()) {
        if (commands[item.name]) continue
        commands[item.name] = {
          name: item.name,
          description: item.description,
          source: "skill",
          get template() {
            return item.content
          },
          hints: [],
        }
      }

      for (const wf of yield* Effect.promise(() => listSavedWorkflows(ctx.worktree))) {
        if (commands[wf.name]) continue
        commands[wf.name] = {
          name: wf.name,
          description: wf.description,
          source: "command",
          get template() {
            return workflowCommandTemplate(wf.name, wf.description)
          },
          subtask: true,
          hints: hints(workflowCommandTemplate(wf.name, wf.description)),
        }
      }

      return {
        commands,
      }
    })

    const state = yield* InstanceState.make<State>((ctx) => init(ctx))

    const get = Effect.fn("Command.get")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      return s.commands[name]
    })

    const list = Effect.fn("Command.list")(function* () {
      const s = yield* InstanceState.get(state)
      return Object.values(s.commands)
    })

    return Service.of({ get, list })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(MCP.defaultLayer),
  Layer.provide(Skill.defaultLayer),
  Layer.provide(RuntimeFlags.defaultLayer),
)

export const node = LayerNode.make(layer, [Config.node, MCP.node, Skill.node, RuntimeFlags.node])

export * as Command from "."
