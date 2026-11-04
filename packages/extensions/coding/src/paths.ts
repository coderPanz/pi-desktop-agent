/**
 * 路径边界：纯函数，不碰文件系统，可单测。
 *
 * 判定一律用 `path.resolve` + `path.relative`，**不用字符串 `startsWith`**：
 * 根 `/root` 与 `/root2` 在 `startsWith` 下判成「在内部」，在 `relative` 下得到 `../root2`，才是对的。
 */
import path from "node:path"

/** 归一化后的判定：`ok` 时带绝对路径，否则带一句给人看的原因。 */
export type PathVerdict =
  | { readonly ok: true; readonly absolute: string }
  | { readonly ok: false; readonly reason: string }

/** 目录与分隔符之外的额外空白：模型从别处复制路径时常带进来。 */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g

/**
 * 与 pi-durable `tools/path-utils.ts` 的 `normalizeToolPath` 同一套归一化：
 * 相应宽度空格换成普通空格，去掉开头的 `@`。
 *
 * 必须一致：工具真正打开的是归一化后的路径，边界检查看的是另一个字符串就等于没检查。
 */
export function normalizeToolPath(input: string): string {
  const normalized = input.replace(UNICODE_SPACES, " ")
  return normalized.startsWith("@") ? normalized.slice(1) : normalized
}

/** `target` 是否落在 `root` 内（含 `root` 本身）。两边都先规范化成绝对路径。 */
export function isInside(root: string, target: string): boolean {
  const from = path.resolve(root)
  const to = path.resolve(target)
  const relative = path.relative(from, to)
  // 同一路径 → ""；`..foo` 是根内的正常文件名，只有 `..` 与 `../…` 才是越界。
  if (relative === "") return true
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) return false
  // 不同盘符（Windows）时 `relative` 返回绝对路径。
  return !path.isAbsolute(relative)
}

/**
 * 把模型给的路径解析成工作区内的绝对路径。
 *
 * `cwd` 是会话的 cwd（`ExecutionEnv.cwd`），相对路径按它解析；绝对路径原样参与判定。
 */
export function resolveInside(root: string, requested: string, cwd: string): PathVerdict {
  const absolute = path.resolve(cwd, normalizeToolPath(requested))
  if (isInside(root, absolute)) return { ok: true, absolute }
  return {
    ok: false,
    reason: `路径 ${requested} 在工作区 ${root} 之外；本机工作台只允许在工作区内读写。`,
  }
}
