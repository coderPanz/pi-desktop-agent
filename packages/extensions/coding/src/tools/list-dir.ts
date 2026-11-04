/**
 * `list_dir`：列目录
 *
 * SDK 只给了 `read` / `write` / `edit` / `bash` 四个工具，没有「看目录」这一步：
 * 模型在只想知道某个目录有什么的时候，不该被迫用 `bash ls` 换个姿势拿到同样信息。
 *
 * 三条边界写死在这里：深度上限（默认 1，最多 3）、忽略 `node_modules` 与 `.git`、条数上限。
 */
import { defineTool } from "@earendil-works/pi-durable"
import type { ExecutionEnv } from "@earendil-works/pi-durable/env"
import type { Context } from "@earendil-works/chord"
import { Type } from "typebox"

import type { PathGuard } from "../guard.ts"
import { toolError } from "../results.ts"

/** 列目录时永远跳过的名字：它们的内容对「这个项目有什么」没有帮助，只会挤爆输出。 */
const IGNORED_NAMES: ReadonlySet<string> = new Set(["node_modules", ".git"])

/** 一次最多给这么多行：目录树是给人看的地图，不是全量导出。 */
const MAX_ENTRIES = 400

const listDirSchema = Type.Object({
  path: Type.Optional(
    Type.String({ description: "要列的目录，相对工作区根；缺省为工作区根。" }),
  ),
  depth: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 3, description: "往下展开几层目录，默认 1。" }),
  ),
})

/** 文件条目渲染成一行：目录带 `/`，软链带 `@`。 */
function entryLabel(kind: string, name: string): string {
  if (kind === "directory") return `${name}/`
  if (kind === "symlink") return `${name}@`
  return name
}

/** 目录在前、文件在后，同类按名字排序：每次输出顺序稳定，才能比对两次列目录的差异。 */
function compareEntries(left: { kind: string; name: string }, right: { kind: string; name: string }): number {
  const leftIsDir = left.kind === "directory"
  const rightIsDir = right.kind === "directory"
  if (leftIsDir !== rightIsDir) return leftIsDir ? -1 : 1
  if (left.name === right.name) return 0
  return left.name < right.name ? -1 : 1
}

type WalkResult =
  | { readonly ok: true; readonly lines: readonly string[]; readonly truncated: boolean }
  | { readonly ok: false; readonly reason: string }

/** 递归列目录；失败（不存在、权限、不是目录）一律返回原因，由调用方转成工具错误结果。 */
async function walkDirectory(
  env: ExecutionEnv,
  absolute: string,
  depth: number,
  context: Context,
): Promise<WalkResult> {
  const lines: string[] = []
  let truncated = false

  const visit = async (dir: string, prefix: string, remaining: number): Promise<string | undefined> => {
    const listed = await env.listDir(dir, context)
    if (!listed.ok) {
      const error = listed.error
      if (error.code === "not_found") return `目录不存在：${dir}`
      if (error.code === "not_directory") return `不是目录：${dir}`
      return `无法列出 ${dir}：${error.message}`
    }

    const entries = [...listed.value].sort(compareEntries)
    for (const entry of entries) {
      if (IGNORED_NAMES.has(entry.name)) continue
      if (lines.length >= MAX_ENTRIES) {
        truncated = true
        return undefined
      }
      lines.push(`${prefix}${entryLabel(entry.kind, entry.name)}`)
      if (entry.kind !== "directory" || remaining <= 1) continue
      const failure = await visit(entry.path, `${prefix}${entry.name}/`, remaining - 1)
      if (failure !== undefined) return failure
      if (truncated) return undefined
    }
    return undefined
  }

  const failure = await visit(absolute, "", depth)
  if (failure !== undefined) return { ok: false, reason: failure }
  return { ok: true, lines, truncated }
}

/** 造 `list_dir` 工具；工作区根由创建者注入，工具自己不做路径拼接。 */
export function createListDirTool(options: { readonly guard: PathGuard }) {
  const { guard } = options
  return defineTool({
    name: "list_dir",
    description:
      `列出目录内容，最多 ${String(MAX_ENTRIES)} 条，深度默认 1（上限 3），` +
      "自动跳过 node_modules 与 .git。目录带 `/`，软链接带 `@`，软链接不展开。",
    parameters: listDirSchema,
    replay: "safe",
    async execute(args, api, context) {
      const env = api.env
      if (env === undefined) return toolError("no_environment", "没有可用的执行环境，无法列目录。")

      const requested = args.path ?? "."
      const verdict = await guard(requested, env, context)
      if (!verdict.ok) return toolError("path_outside_workspace", verdict.reason)

      const listed = await walkDirectory(env, verdict.absolute, args.depth ?? 1, context)
      if (!listed.ok) return toolError("list_failed", listed.reason)

      const diagnostics: { severity: "info"; code: string; message: string }[] = []
      if (listed.truncated) {
        diagnostics.push({
          severity: "info",
          code: "truncated",
          message: `只列出前 ${String(MAX_ENTRIES)} 条；缩小 path 或 depth 才能看全。`,
        })
      }

      return {
        output:
          listed.lines.length === 0
            ? [{ type: "text" as const, text: "（空目录）" }]
            : [{ type: "text" as const, text: listed.lines.join("\n") }],
        diagnostics,
      }
    },
  })
}
