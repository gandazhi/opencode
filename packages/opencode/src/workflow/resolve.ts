import path from "path"
import { Filesystem } from "@/util/filesystem"
import { BuiltinWorkflow } from "./builtin"
import { parseMeta } from "./meta"

const META_RE = /export\s+const\s+meta\s*=/

export function isInlineScript(nameOrScript: string): boolean {
  return META_RE.test(nameOrScript)
}

const SAFE_NAME = /^[A-Za-z0-9._-]+$/

// resolveName unifies the two workflow-name sources so a `name` resolves the
// same way from the workflow TOOL as it does from the in-script workflow()
// host function: built-in registry first, then the on-disk saved workflows.
export async function resolveName(name: string, start: string, stop: string): Promise<string | null> {
  const builtin = BuiltinWorkflow.get(name)?.script
  if (builtin) return builtin
  return resolveWorkflowScript(name, start, stop)
}

export async function resolveWorkflowScript(name: string, start: string, stop: string): Promise<string | null> {
  if (!SAFE_NAME.test(name)) throw new Error(`invalid workflow name: ${JSON.stringify(name)}`)
  const subdirs = [".opencode/workflows", ".claude/workflows"]
  for (const found of await collectUp(name, subdirs, start, stop)) {
    return Filesystem.readText(found)
  }
  return null
}

// Lists saved workflows discoverable on disk under a project root, parsing each
// script's meta WITHOUT executing it (parseMeta is a pure data reader). Used to
// surface available workflow names to the model so a saved workflow behaves
// like a named command. .opencode takes precedence over .claude for duplicates.
export async function listSavedWorkflows(root: string): Promise<{ name: string; description: string }[]> {
  const out: { name: string; description: string }[] = []
  const seen = new Set<string>()
  for (const sub of [".opencode/workflows", ".claude/workflows"]) {
    const dir = path.join(root, sub)
    let entries: string[] = []
    try {
      entries = await Array.fromAsync(new Bun.Glob("*.js").scan({ cwd: dir }))
    } catch {
      continue
    }
    for (const file of entries.sort()) {
      const parsed = parseMeta(await Filesystem.readText(path.join(dir, file)))
      if (!parsed.ok || seen.has(parsed.meta.name)) continue
      seen.add(parsed.meta.name)
      out.push({ name: parsed.meta.name, description: parsed.meta.description })
    }
  }
  return out
}

async function collectUp(name: string, subdirs: string[], start: string, stop: string): Promise<string[]> {
  const out: string[] = []
  let current = start
  for (;;) {
    for (const sub of subdirs) {
      const candidate = path.join(current, sub, `${name}.js`)
      if (await Filesystem.exists(candidate)) out.push(candidate)
    }
    if (current === stop) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return out
}
