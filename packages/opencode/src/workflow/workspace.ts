import path from "path"
import { Filesystem } from "@/util/filesystem"
import { Glob } from "@opencode-ai/core/util/glob"

export function resolveInWorkspace(root: string, rel: string): string {
  const abs = path.resolve(root, rel)
  if (abs !== root && !Filesystem.contains(root, abs)) {
    throw new Error(`workspace path escapes the workspace root: ${JSON.stringify(rel)}`)
  }
  return abs
}

export function makeFileHooks(root: string) {
  return {
    async readFile(rel: unknown): Promise<string | null> {
      const abs = resolveInWorkspace(root, String(rel))
      if (!(await Filesystem.exists(abs))) return null
      return Filesystem.readText(abs)
    },
    async writeFile(rel: unknown, content: unknown): Promise<void> {
      const abs = resolveInWorkspace(root, String(rel))
      await Filesystem.write(abs, String(content))
    },
    async exists(rel: unknown): Promise<boolean> {
      const abs = resolveInWorkspace(root, String(rel))
      return Filesystem.exists(abs)
    },
    async glob(pattern: unknown): Promise<string[]> {
      const abs = await Glob.scan(String(pattern), {
        cwd: root,
        absolute: true,
        include: "all",
        dot: true,
      })
      return abs
        .map((p) => path.relative(root, p))
        .filter((rel) => rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel))
        .sort()
    },
  }
}
