/**
 * 工作区边界检查
 *
 * 两层是必要的：
 *   1. 词法层（`paths.ts`）挡住 `../..` 与绝对路径；
 *   2. 真实路径层挡住「工作区里放一个指向 `/etc` 的软链」——词法上完全合法，打开后却在外面。
 *
 * 真实路径层要**两边都归一化**：macOS 上 `/var` 与 `/private/var` 是同一处，只归一化目标会把正常读写全判成越界。
 */
import type { Context } from "@earendil-works/chord"
import type { ExecutionEnv } from "@earendil-works/pi-durable/env"
import path from "node:path"

import { isInside, resolveInside, type PathVerdict } from "./paths.ts"

/** 判定一次请求路径：`ok` 时给出绝对路径。 */
export type PathGuard = (requested: string, env: ExecutionEnv, context: Context) => Promise<PathVerdict>

/** 仅在确认路径确实不存在时向上找祖先；权限错误、断链和取消不能退回词法放行。 */
async function canonicalAncestor(
  env: ExecutionEnv,
  absolute: string,
  workspace: string,
  context: Context,
): Promise<string | undefined> {
  let current = absolute
  while (true) {
    const canonical = await env.canonicalPath(current, context)
    if (canonical.ok) return canonical.value
    if (canonical.error.code !== "not_found") return undefined

    // realpath 的 ENOENT 也可能来自指向不存在目标的软链；lstat 区分断链与待创建路径。
    const info = await env.fileInfo(current, context)
    if (info.ok || info.error.code !== "not_found") return undefined
    if (current === workspace) return undefined
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/** 不按 env.id 缓存根：本地环境共享 id，根失效后不能继续信任旧的解析结果。 */
export function createPathGuard(workspace: string): PathGuard {
  const lexicalRoot = path.resolve(workspace)

  return async (requested, env, context) => {
    const lexical = resolveInside(workspace, requested, env.cwd)
    if (!lexical.ok) return lexical

    const root = await env.canonicalPath(lexicalRoot, context)
    if (!root.ok) {
      return { ok: false, reason: "无法确认工作区根的真实目录，拒绝执行文件操作。" }
    }
    // 根可为有效目录软链；最终目标必须可确认是目录。
    const rootInfo = await env.fileInfo(root.value, context)
    if (!rootInfo.ok || rootInfo.value.kind !== "directory") {
      return { ok: false, reason: "工作区根不是可确认的目录，拒绝执行文件操作。" }
    }

    const real = await canonicalAncestor(env, lexical.absolute, lexicalRoot, context)
    if (real === undefined) {
      return { ok: false, reason: `无法确认路径 ${requested} 的真实边界，拒绝执行文件操作。` }
    }
    if (isInside(root.value, real)) return lexical

    return {
      ok: false,
      reason: `路径 ${requested} 经软链接指向工作区之外（${real}）；本机工作台只允许在工作区内读写。`,
    }
  }
}
