/** 从不可变版本目录加载子应用，并在 registry 安装前完成完整性与命名校验。 */
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { defineExtension, defineTool } from "@earendil-works/pi-durable"
import type { Extension, RegistryReader, ToolRegistration } from "@earendil-works/pi-durable"
import { Type } from "typebox"
import type { AppSubapp, InstalledSubappManifest, SubappVersionFiles } from "@pi/shared-types"
import type { WorkspacePaths } from "@pi/core"

import { subappChecksum, subappVersionDirectory } from "./files.ts"
import { validateM1Candidate } from "./static-validator.ts"

export type LoadedSubapp = {
  manifest: InstalledSubappManifest
  extension: Extension<ToolRegistration>
  toolNames: string[]
}

type SubappFactory = (dependencies: { Type: typeof Type; defineTool: typeof defineTool }) => unknown | Promise<unknown>

function asInstalledManifest(value: unknown): InstalledSubappManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("manifest.json 必须是对象。")
  }
  return value as InstalledSubappManifest
}

async function optionalText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8")
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw error
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const a = [...left].sort()
  const b = [...right].sort()
  return a.every((name, index) => name === b[index])
}

function toolNamesOf(tools: readonly ToolRegistration[]): string[] {
  const names = tools.map(tool => tool.name)
  if (new Set(names).size !== names.length) throw new Error("tool.mjs 导出了重复工具名。")
  return names
}

function assertNoRegistryCollision(
  registry: RegistryReader<ToolRegistration>,
  extensionName: string,
  toolNames: readonly string[],
): void {
  const collisions = registry.snapshot().tools()
    .filter(({ extension, tool }) => extension.name !== extensionName && toolNames.includes(tool.name))
    .map(({ tool }) => tool.name)
  if (collisions.length > 0) {
    throw new Error(`工具名已由其他扩展占用：${[...new Set(collisions)].join("、")}`)
  }
}

/**
 * 读取并创建 extension，但不调用 `registry.install`。调用方可在 durable commit 前后按补偿策略切换。
 */
export async function loadSubappVersion(input: {
  paths: WorkspacePaths
  record: AppSubapp
  registry: RegistryReader<ToolRegistration>
}): Promise<LoadedSubapp> {
  const { paths, record, registry } = input
  const directory = subappVersionDirectory(paths, record.slug, record.version)
  const [manifestText, tool] = await Promise.all([
    readFile(path.join(directory, "manifest.json"), "utf8"),
    readFile(path.join(directory, "tool.mjs"), "utf8"),
  ])
  const ui = await optionalText(path.join(directory, "ui.json"))
  const manifest = asInstalledManifest(JSON.parse(manifestText))

  if (manifest.slug !== record.slug || manifest.version !== record.version) {
    throw new Error("manifest 身份与 app.subapps 记录不一致。")
  }
  if (manifest.checksum !== subappChecksum(tool, ui)) {
    throw new Error("子应用文件 checksum 不匹配，拒绝加载。")
  }
  const staticResult = validateM1Candidate(manifest, { tool, ...(ui === undefined ? {} : { ui }) } satisfies SubappVersionFiles)
  if (!staticResult.ok) {
    const reasons = staticResult.checks.filter(check => check.status === "failed").map(check => check.message ?? check.rule)
    throw new Error(`子应用静态校验失败：${reasons.join("；")}`)
  }

  const imported = await import(`${pathToFileURL(path.join(directory, "tool.mjs")).href}?v=${record.version}`) as {
    default?: SubappFactory
  }
  if (typeof imported.default !== "function") throw new Error("tool.mjs 必须默认导出 create 工厂函数。")
  const created = await imported.default({ Type, defineTool })
  if (created === null || typeof created !== "object" || Array.isArray(created)) {
    throw new Error("create 工厂必须返回 { tools, actions }。")
  }
  const { tools, actions } = created as { tools?: unknown; actions?: unknown }
  if (!Array.isArray(tools) || tools.length === 0) throw new Error("create.tools 必须是非空数组。")
  if (actions === null || typeof actions !== "object" || Array.isArray(actions) || Object.keys(actions).length !== 0) {
    throw new Error("M1 create.actions 必须为空对象。")
  }
  const typedTools = tools as ToolRegistration[]
  const toolNames = toolNamesOf(typedTools)
  if (!sameStrings(toolNames, manifest.requestedCapabilities.tools)) {
    throw new Error("tool.mjs 实际导出工具与 manifest.requestedCapabilities.tools 不一致。")
  }

  const extensionName = `subapps:${record.slug}`
  assertNoRegistryCollision(registry, extensionName, toolNames)
  return {
    manifest,
    extension: defineExtension({ name: extensionName, tools: typedTools }),
    toolNames,
  }
}
