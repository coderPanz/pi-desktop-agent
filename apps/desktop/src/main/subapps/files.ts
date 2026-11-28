/** 子应用版本目录、内容校验和与原子落盘。安装流程的 registry / durable 补偿在 installer 层实现。 */
import { createHash } from "node:crypto"
import { access, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import type { InstalledSubappManifest, SubappVersionFiles } from "@pi/shared-types"
import type { WorkspacePaths } from "@pi/core"

export const SUBAPP_SLUG_PATTERN = /^[a-z0-9-]{2,40}$/
const RESERVED_SLUGS = new Set(["coding", "kb", "subapps"])

export type StagedSubappVersion = {
  readonly slug: string
  readonly version: number
  /** 尚未激活的临时目录；只允许交给 commit/discard。 */
  readonly directory: string
  readonly target: string
}

export function assertSubappSlug(slug: string): void {
  if (!SUBAPP_SLUG_PATTERN.test(slug)) {
    throw new Error("子应用 slug 只允许 2–40 位小写字母、数字或连字符。")
  }
  if (RESERVED_SLUGS.has(slug)) throw new Error(`子应用 slug 不能使用内置扩展名：${slug}`)
}

function assertVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error("子应用 version 必须是大于 0 的安全整数。")
  }
}

export function subappRoot(paths: WorkspacePaths, slug: string): string {
  assertSubappSlug(slug)
  return path.join(paths.subapps, slug)
}

export function subappVersionDirectory(paths: WorkspacePaths, slug: string, version: number): string {
  assertVersion(version)
  return path.join(subappRoot(paths, slug), "versions", String(version))
}

export function subappHistoryFile(paths: WorkspacePaths, slug: string, version: number): string {
  assertVersion(version)
  return path.join(subappRoot(paths, slug), "history", `${version}.json`)
}

/** `tool.mjs + NUL + ui.json-or-empty` 的固定字节序列，避免换行或可选文件造成歧义。 */
export function subappChecksum(tool: string, ui?: string): string {
  const hash = createHash("sha256")
  hash.update(tool, "utf8")
  hash.update("\0", "utf8")
  hash.update(ui ?? "", "utf8")
  return `sha256:${hash.digest("hex")}`
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

async function writeVersionFiles(
  directory: string,
  manifest: InstalledSubappManifest,
  files: SubappVersionFiles,
): Promise<void> {
  await Promise.all([
    writeFile(path.join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }),
    writeFile(path.join(directory, "tool.mjs"), files.tool, { encoding: "utf8", mode: 0o600 }),
    ...(files.ui === undefined
      ? []
      : [writeFile(path.join(directory, "ui.json"), files.ui, { encoding: "utf8", mode: 0o600 })]),
    ...(files.readme === undefined
      ? []
      : [writeFile(path.join(directory, "README.md"), files.readme, { encoding: "utf8", mode: 0o600 })]),
  ])
}

/**
 * 把一个已由安装器规范化的版本写进私有临时目录。
 *
 * 这里不触碰 registry 或 durable 文档；调用方完成 smoke/用户确认后再 commit，失败时调用
 * `discardStagedSubappVersion()`。临时目录与目标目录位于同一文件系统，rename 可原子发布完整目录。
 */
export async function stageSubappVersion(input: {
  readonly paths: WorkspacePaths
  readonly manifest: InstalledSubappManifest
  readonly files: SubappVersionFiles
}): Promise<StagedSubappVersion> {
  const { paths, manifest, files } = input
  assertSubappSlug(manifest.slug)
  assertVersion(manifest.version)
  if (files.tool.length === 0) throw new Error("M1 子应用必须提供非空 tool.mjs。")
  const expected = subappChecksum(files.tool, files.ui)
  if (manifest.checksum !== expected) throw new Error("子应用 manifest checksum 与实际 tool.mjs/ui.json 不一致。")

  const root = subappRoot(paths, manifest.slug)
  const target = subappVersionDirectory(paths, manifest.slug, manifest.version)
  if (await exists(target)) throw new Error(`子应用版本已存在：${manifest.slug}@${manifest.version}`)
  await mkdir(path.join(root, "versions"), { recursive: true })
  const directory = await mkdtemp(path.join(root, ".stage-"))
  try {
    await writeVersionFiles(directory, manifest, files)
    return { slug: manifest.slug, version: manifest.version, directory, target }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

/**
 * 原子发布 staged 目录。安装器必须串行化同一 slug 的安装，且在调用前保持旧版本目录不动；
 * registry / durable 的切换失败由上层执行补偿。
 */
export async function commitStagedSubappVersion(staged: StagedSubappVersion): Promise<string> {
  if (await exists(staged.target)) throw new Error(`子应用版本已存在：${staged.slug}@${staged.version}`)
  await rename(staged.directory, staged.target)
  return staged.target
}

export async function discardStagedSubappVersion(staged: StagedSubappVersion): Promise<void> {
  await rm(staged.directory, { recursive: true, force: true })
}
