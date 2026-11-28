/**
 * 子应用版本切换：协调不可变目录、registry 与 `app.subapps`。
 *
 * 三者没有共同事务，故顺序固定为“发布目录 → 装 registry → commit durable”，并在后两步失败时
 * 恢复先前 extension 和 durable 尚未改变的记录。候选验证、用户确认与 token 消费由上层 service 负责。
 */
import { rm } from "node:fs/promises"

import type { Context } from "@earendil-works/chord"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { Harness, Registry, ToolRegistration } from "@earendil-works/pi-durable"
import type { AppSubapp, InstalledSubappManifest, SubappSmokeResult } from "@pi/shared-types"
import { AppSubappsDoc } from "@pi/shared-docs"
import type { WorkspacePaths } from "@pi/core"

import { commitStagedSubappVersion, discardStagedSubappVersion } from "./files.ts"
import type { StagedSubappVersion } from "./files.ts"
import { loadSubappVersion, type LoadedSubapp } from "./loader.ts"

export type SubappInstallerOptions = {
  paths: WorkspacePaths
  harness: Harness
  registry: Registry<ToolRegistration>
}

export class SubappInstaller {
  readonly #paths: WorkspacePaths
  readonly #harness: Harness
  readonly #registry: Registry<ToolRegistration>

  constructor(options: SubappInstallerOptions) {
    this.#paths = options.paths
    this.#harness = options.harness
    this.#registry = options.registry
  }

  /**
   * 使一个已通过用户确认、已经 staged 的版本生效。
   *
   * 返回 durable 中的新记录；若抛错则 registry 已恢复到调用前状态，且新版本目录已移除。
   */
  async installStaged(input: {
    staged: StagedSubappVersion
    manifest: InstalledSubappManifest
    smoke: SubappSmokeResult
    context?: Context
  }): Promise<AppSubapp> {
    const context = input.context ?? BACKGROUND_CONTEXT
    const extensionName = `subapps:${input.manifest.slug}`
    const previousExtension = this.#registry.snapshot().extension(extensionName)
    let publishedDirectory = false
    let installed: LoadedSubapp | undefined
    try {
      await commitStagedSubappVersion(input.staged)
      publishedDirectory = true
      installed = await loadSubappVersion({
        paths: this.#paths,
        record: this.#recordFromManifest(input.manifest, input.smoke),
        registry: this.#registry,
      })
      this.#registry.install(installed.extension)
      const record = await this.#commitRecord(input.manifest, input.smoke, context)
      return record
    } catch (error) {
      if (installed !== undefined) {
        if (previousExtension === undefined) this.#registry.uninstall(installed.extension)
        else this.#registry.install(previousExtension)
      }
      if (publishedDirectory) {
        await rm(input.staged.target, { recursive: true, force: true }).catch(() => undefined)
      } else {
        await discardStagedSubappVersion(input.staged).catch(() => undefined)
      }
      throw error
    }
  }

  #recordFromManifest(manifest: InstalledSubappManifest, smoke: SubappSmokeResult): AppSubapp {
    return {
      slug: manifest.slug,
      title: manifest.title,
      version: manifest.version,
      enabled: true,
      status: "ready",
      requestedCapabilities: structuredClone(manifest.requestedCapabilities),
      enforcement: manifest.enforcement,
      smoke: smoke.status,
      installedAt: manifest.createdAt,
    }
  }

  async #commitRecord(
    manifest: InstalledSubappManifest,
    smoke: SubappSmokeResult,
    context: Context,
  ): Promise<AppSubapp> {
    let committed: AppSubapp | undefined
    await this.#harness.commit(async tx => {
      const doc = await tx.doc(AppSubappsDoc)
      const index = doc.items.findIndex(item => item.slug === manifest.slug)
      const previous = index === -1 ? undefined : doc.items[index]
      const record = this.#recordFromManifest(manifest, smoke)
      if (previous !== undefined && previous.version !== record.version) record.previousVersion = previous.version
      if (index === -1) doc.items.push(record)
      else doc.items[index] = record
      committed = structuredClone(record)
    }, context)
    if (committed === undefined) throw new Error("app.subapps 提交后未得到子应用记录。")
    return committed
  }
}
