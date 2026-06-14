import path from "path"
import { Filesystem } from "@/util/filesystem"

const META_RE = /export\s+const\s+meta\s*=/

export function isInlineScript(nameOrScript: string): boolean {
  return META_RE.test(nameOrScript)
}

const SAFE_NAME = /^[A-Za-z0-9._-]+$/

export async function resolveWorkflowScript(name: string, start: string, stop: string): Promise<string | null> {
  if (!SAFE_NAME.test(name)) throw new Error(`invalid workflow name: ${JSON.stringify(name)}`)
  const subdirs = [".opencode/workflows", ".claude/workflows"]
  for (const found of await collectUp(name, subdirs, start, stop)) {
    return Filesystem.readText(found)
  }
  return null
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
