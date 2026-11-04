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

/** 往上找真实祖先时最多走几层：写入新文件时会连着几级目录都不存在。 */
const MAX_ANCESTOR_STEPS = 8

/** 找到 `absolute` 或它最近的已存在祖先的真实路径（解软链）。找不到返回 `undefined`。 */
async function canonicalAncestor(
  env: ExecutionEnv,
  absolute: string,
  context: Context,
): Promise<string | undefined> {
  let current = absolute
  for (let step = 0; step < MAX_ANCESTOR_STEPS; step += 1) {
    const canonical = await env.canonicalPath(current, context)
    if (canonical.ok) return canonical.value
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

/** 造一个绑定到固定工作区根的检查器；真实根路径按环境缓存，成功一次就不再问文件系统。 */
export function createPathGuard(workspace: string): PathGuard {
  const roots = new Map<string, string>()

  const canonicalRoot = async (env: ExecutionEnv, context: Context): Promise<string | undefined> => {
    const key = `${env.id}\u0000${workspace}`
    const cached = roots.get(key)
    if (cached !== undefined) return cached
    const canonical = await env.canonicalPath(workspace, context)
    // 根还不存在（`--memory` 下第一次写）时不缓存：等它出现再归一化。
    if (!canonical.ok) return undefined
    roots.set(key, canonical.value)
    return canonical.value
  }

  return async (requested, env, context) => {
    const lexical = resolveInside(workspace, requested, env.cwd)
    if (!lexical.ok) return lexical

    const root = await canonicalRoot(env, context)
    // 连根都真实化不了：只能信词法判定，工具自己会因文件不存在而失败。
    if (root === undefined) return lexical

    const real = await canonicalAncestor(env, lexical.absolute, context)
    if (real === undefined) return lexical
    if (isInside(root, real)) return lexical

    return {
      ok: false,
      reason: `路径 ${requested} 经软链接指向工作区之外（${real}）；本机工作台只允许在工作区内读写。`,
    }
  }
}
