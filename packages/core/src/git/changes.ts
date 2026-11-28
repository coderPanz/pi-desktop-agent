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
import { readFile, rm, stat } from "node:fs/promises"
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
  } catch (error) {
    // `git diff` / `diff --no-index` 用退出码 1 表示“有差异”，这不是失败。
    const stdout = (error as { stdout?: unknown }).stdout
    return typeof stdout === "string" && stdout !== "" ? stdout : undefined
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

/**
 * 工作区里未跟踪的文件（相对仓库根）。
 * `git diff` 看不到它们，所以 Agent 新建文件必须单独补，否则卡片会漏。
 */
async function untrackedPaths(workspace: string): Promise<readonly string[]> {
  const out = await git(workspace, ["status", "--porcelain", "--untracked-files=all"])
  if (out === undefined) return []
  const paths: string[] = []
  for (const line of out.split("\n")) {
    if (!line.startsWith("?? ")) continue
    const file = line.slice(3).trim()
    if (file !== "") paths.push(file)
  }
  return paths
}

/** 新建文件的“新增行数”；二进制文件返回 undefined。 */
async function newFileStats(absolute: string): Promise<{ added: number; binary: boolean } | undefined> {
  try {
    const content = await readFile(absolute)
    if (content.includes(0)) return { added: 0, binary: true }
    const text = content.toString("utf8")
    const added = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0)
    return { added, binary: false }
  } catch {
    return undefined
  }
}

/**
 * 相对仓库根统计改动；`baseline` 缺失时返回空列表，由界面提示“没有基线”。
 * `sinceMs` 是这一轮的起点时间：只把**这之后才创建**的未跟踪文件算作本轮新增，
 * 避免把用户动手前就存在、还没 `git add` 的文件算进去。
 */
export async function summary(workspace: string, baseline: string | undefined, sinceMs?: number): Promise<ChangeSummary> {
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
  // 补上本轮新建、git 还没有跟踪的文件
  if (sinceMs !== undefined) {
    for (const file of await untrackedPaths(workspace)) {
      if (files.length >= 200) {
        truncated = true
        break
      }
      const absolute = path.join(root, file)
      const info = await stat(absolute).catch(() => undefined)
      if (info === undefined || info.mtimeMs < sinceMs) continue
      const stats = await newFileStats(absolute)
      if (stats === undefined) continue
      files.push({ path: file, added: stats.added, removed: 0, binary: stats.binary })
    }
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
  // 未跟踪的新文件不在 `git diff <baseline>` 里，用 --no-index 对空文件比出“新增”补丁
  const tracked = await git(workspace, ["ls-files", "--error-unmatch", "--", relative])
  const out = tracked === undefined
    ? await git(workspace, ["diff", "--no-index", "--", "/dev/null", relative])
    : await git(workspace, ["diff", baseline, "--", relative])
  if (out === undefined) return undefined
  if (out.length <= MAX_PATCH_BYTES) return { patch: out, truncated: false }
  return { patch: out.slice(0, MAX_PATCH_BYTES), truncated: true }
}

/**
 * 把一个文件退回本轮基线。
 *
 * - 已跟踪：`git checkout <baseline> -- <file>`（只动这一个文件，不碰 index 之外的东西）
 * - 本轮新增（未跟踪）：基线里没有它，直接删除
 *
 * 只接受仓库内的相对路径；返回 `false` 表示没做成（不存在、越界、git 失败），由界面提示。
 */
export async function revertFile(workspace: string, baseline: string, file: string): Promise<boolean> {
  const root = await repoRoot(workspace)
  if (root === undefined) return false
  const relative = path.normalize(file)
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false
  const tracked = await git(workspace, ["ls-files", "--error-unmatch", "--", relative])
  if (tracked !== undefined) {
    const out = await git(workspace, ["checkout", baseline, "--", relative])
    return out !== undefined
  }
  // 未跟踪：本轮新建的，撤销 = 删掉。只在确实存在时才删，避免误删别的路径。
  const absolute = path.join(root, relative)
  const info = await stat(absolute).catch(() => undefined)
  if (info === undefined || !info.isFile()) return false
  await rm(absolute, { force: true })
  return true
}

/** 保留多少轮基线：再多也没人回滚那么远，还占文档体积。 */
export const MAX_ROUNDS = 10
