/**
 * 改动统计：用工作区自己的 git 算「这一轮改了什么」。
 *
 * 为什么用 git 而不是自己存 diff：每轮都落一份 patch，长期会把磁盘撑爆；
 * git 仓库里现算既准确又不占盘。没有 git 仓库时**不硬造**——只给工具侧知道的文件列表，
 * 由界面标注「无法显示 diff」。
 *
 * 约束：只跑只读命令（`rev-parse` / `stash create` / `diff`），argv 形式不过 shell，cwd 固定在工作区。
 */
import { execFile } from "node:child_process"
import path from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)
const MAX_PATCH_BYTES = 256 * 1024
const TIMEOUT_MS = 10_000

async function git(workspace: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", [...args], {
      cwd: workspace,
      timeout: TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    })
    return stdout
  } catch {
    return undefined
  }
}

/** 工作区所在的 git 仓库根；不在仓库里返回 undefined。 */
export async function repoRoot(workspace: string): Promise<string | undefined> {
  const out = await git(workspace, ["rev-parse", "--show-toplevel"])
  const root = out?.trim()
  return root === undefined || root === "" ? undefined : root
}

/**
 * 一轮的起点：`git stash create` 生成一个游离 commit（**不改工作区、不建 stash 栈**）。
 * 比记 `HEAD` 准：工作区本来就有未提交改动时，那些改动不会被算进这一轮。
 */
export async function createBaseline(workspace: string): Promise<string | undefined> {
  if ((await repoRoot(workspace)) === undefined) return undefined
  const stashed = (await git(workspace, ["stash", "create"]))?.trim()
  // 工作区干净时 `stash create` 什么都不输出（没有可 stash 的内容），此时退回 HEAD。
  if (stashed !== undefined && stashed !== "") return stashed
  const head = (await git(workspace, ["rev-parse", "HEAD"]))?.trim()
  return head === undefined || head === "" ? undefined : head
}

export type ChangedFile = {
  readonly path: string
  readonly added: number
  readonly removed: number
  /** 二进制文件 git 不给行数。 */
  readonly binary: boolean
}

export type ChangeSummary = {
  readonly repo: boolean
  readonly root?: string
  readonly files: readonly ChangedFile[]
  /** diff 被截断时的说明（文件太多或太大）。 */
  readonly truncated: boolean
}

/** 相对仓库根统计改动；`baseline` 缺失时返回空列表，由界面提示“没有基线”。 */
export async function summary(workspace: string, baseline: string | undefined): Promise<ChangeSummary> {
  const root = await repoRoot(workspace)
  if (root === undefined) return { repo: false, files: [], truncated: false }
  if (baseline === undefined) return { repo: true, root, files: [], truncated: false }
  const out = await git(workspace, ["diff", "--numstat", baseline, "--"])
  if (out === undefined) return { repo: true, root, files: [], truncated: false }
  const files: ChangedFile[] = []
  let truncated = false
  for (const line of out.split("\n")) {
    if (line.trim() === "") continue
    const [added, removed, ...rest] = line.split("\t")
    const file = rest.join("\t")
    if (file === "" || added === undefined || removed === undefined) continue
    if (files.length >= 200) {
      truncated = true
      break
    }
    const binary = added === "-" && removed === "-"
    files.push({
      path: file,
      added: binary ? 0 : Number(added) || 0,
      removed: binary ? 0 : Number(removed) || 0,
      binary,
    })
  }
  files.sort((left, right) => left.path.localeCompare(right.path))
  return { repo: true, root, files, truncated }
}

/** 单个文件的 patch；调用方负责确认 `path` 来自上面的 summary（不接受任意输入直接下发）。 */
export async function filePatch(
  workspace: string,
  baseline: string,
  file: string,
): Promise<{ readonly patch: string; readonly truncated: boolean } | undefined> {
  const relative = path.normalize(file)
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined
  const out = await git(workspace, ["diff", baseline, "--", relative])
  if (out === undefined) return undefined
  if (out.length <= MAX_PATCH_BYTES) return { patch: out, truncated: false }
  return { patch: out.slice(0, MAX_PATCH_BYTES), truncated: true }
}
