/** 子应用 M1 服务：候选预览、确认安装、启动恢复与启停。IPC 在 M1-4 接入本服务。 */
import { rm } from "node:fs/promises"

import type { Context } from "@earendil-works/chord"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { defineExtension, defineTool } from "@earendil-works/pi-durable"
import type { Harness, Registry, ToolRegistration } from "@earendil-works/pi-durable"
import { Type } from "typebox"
import { AppSubappsDoc } from "@pi/shared-docs"
import type {
  AppSubapp,
  InstalledSubappManifest,
  SubappChanged,
  SubappPreview,
  SubappProposal,
} from "@pi/shared-types"
import type { WorkspacePaths } from "@pi/core"

import { CandidateStore, type SubappCandidate } from "./candidates.ts"
import { subappsContextSection } from "./context.ts"
import { stageSubappVersion, subappChecksum, subappRoot } from "./files.ts"
import { SubappInstaller } from "./installer.ts"
import { loadSubappVersion } from "./loader.ts"
import { runSubappSmoke } from "./smoke-runner.ts"
import { validateM1Candidate } from "./static-validator.ts"

export type SubappServiceOptions = {
  paths: WorkspacePaths
  harness: Harness
  registry: Registry<ToolRegistration>
  candidates?: CandidateStore
  onChanged?: (change: SubappChanged) => void
  onProposed?: (proposal: SubappProposal) => void
}

export class SubappService {
  readonly #paths: WorkspacePaths
  readonly #harness: Harness
  readonly #registry: Registry<ToolRegistration>
  readonly #candidates: CandidateStore
  readonly #installer: SubappInstaller
  readonly #onChanged: ((change: SubappChanged) => void) | undefined
  readonly #onProposed: ((proposal: SubappProposal) => void) | undefined
  #queue: Promise<void> = Promise.resolve()

  constructor(options: SubappServiceOptions) {
    this.#paths = options.paths
    this.#harness = options.harness
    this.#registry = options.registry
    this.#candidates = options.candidates ?? new CandidateStore()
    this.#installer = new SubappInstaller({
      paths: options.paths,
      harness: options.harness,
      registry: options.registry,
    })
    this.#onChanged = options.onChanged
    this.#onProposed = options.onProposed
    // 这是能力清单提示词，不是用户生成 extension；slug "subapps" 为保留内置名。
    this.#registry.install(defineExtension({
      name: "subapps",
      sections: [subappsContextSection(this.#registry)],
      tools: [this.#proposalTool()],
    }))
  }

  /** 启动恢复：坏掉的子应用只标记 failed，绝不能阻塞桌面应用启动。 */
  restore(context: Context = BACKGROUND_CONTEXT): Promise<void> {
    return this.#exclusive(async () => {
      for (const record of await this.#records(context)) {
        if (!record.enabled || record.status !== "ready") continue
        try {
          const loaded = await loadSubappVersion({ paths: this.#paths, record, registry: this.#registry })
          this.#registry.install(loaded.extension)
        } catch (error) {
          const failed = await this.#update(record.slug, current => ({
            ...current,
            status: "failed",
            error: errorMessage(error),
          }), context)
          this.#changed({ slug: failed.slug, status: failed.status })
        }
      }
    })
  }

  list(context: Context = BACKGROUND_CONTEXT): Promise<AppSubapp[]> {
    return this.#exclusive(async () => structuredClone((await this.#records(context))))
  }

  /** 模型工具调用：生成候选、静态检查和 smoke，但绝不签发可安装 token。 */
  propose(candidate: SubappCandidate, context: Context = BACKGROUND_CONTEXT): Promise<SubappProposal> {
    return this.#exclusive(async () => {
      const validation = validateM1Candidate(candidate.manifest, candidate.files)
      if (!validation.ok) {
        const reasons = validation.checks.filter(item => item.status === "failed").map(item => item.message ?? item.rule)
        throw new Error(`候选子应用静态校验失败：${reasons.join("；")}`)
      }
      const record = this.#candidates.create(candidate)
      const version = nextVersion(await this.#records(context), candidate.manifest.slug)
      const manifest: InstalledSubappManifest = {
        ...structuredClone(candidate.manifest),
        version,
        createdAt: Date.now(),
        enforcement: "m1-local-confirmed",
        checksum: subappChecksum(candidate.files.tool, candidate.files.ui),
      }
      const smoke = await runSubappSmoke(candidate.files.tool)
      this.#candidates.setPreview({
        candidateId: record.id,
        manifest,
        staticChecks: validation.checks,
        smoke,
      })
      const proposal = this.#candidates.proposal(record.id)
      this.#proposed(proposal)
      return proposal
    })
  }

  /** 只有可信 renderer 取确认页时才签发绑定 sender 的一次性安装 token。 */
  preview(candidateId: string, sender: string): Promise<SubappPreview> {
    return this.#exclusive(async () => this.#candidates.preview(candidateId, sender))
  }

  /** 用户确认后消费 token 并切换版本；smoke 失败必须由调用方显式声明 force。 */
  install(input: {
    installToken: string
    sender: string
    forceSmokeFailure?: boolean
    context?: Context
  }): Promise<AppSubapp> {
    return this.#exclusive(async () => {
      const candidate = this.#candidates.consumeInstallToken(input.installToken, input.sender)
      const preview = candidate.preview
      if (preview === undefined) throw new Error("候选子应用缺少安装预览。")
      if (preview.smoke.status === "failed" && input.forceSmokeFailure !== true) {
        throw new Error("候选子应用未通过 smoke；需要用户再次明确确认后才能安装。")
      }
      const staged = await stageSubappVersion({
        paths: this.#paths,
        manifest: preview.manifest,
        files: candidate.candidate.files,
      })
      const installed = await this.#installer.installStaged({
        staged,
        manifest: preview.manifest,
        smoke: preview.smoke,
        context: input.context,
      })
      this.#changed({ slug: installed.slug, status: installed.status })
      return installed
    })
  }

  setEnabled(slug: string, enabled: boolean, context: Context = BACKGROUND_CONTEXT): Promise<AppSubapp> {
    return this.#exclusive(async () => {
      const record = (await this.#records(context)).find(item => item.slug === slug)
      if (record === undefined) throw new Error("子应用不存在。")
      const extensionName = `subapps:${slug}`
      if (!enabled) {
        const extension = this.#registry.snapshot().extension(extensionName)
        if (extension !== undefined) this.#registry.uninstall(extension)
        const disabled = await this.#update(slug, current => ({
          ...current,
          enabled: false,
          status: "disabled",
          error: undefined,
        }), context)
        this.#changed({ slug: disabled.slug, status: disabled.status })
        return disabled
      }
      try {
        const loaded = await loadSubappVersion({ paths: this.#paths, record, registry: this.#registry })
        this.#registry.install(loaded.extension)
        const ready = await this.#update(slug, current => ({
          ...current,
          enabled: true,
          status: "ready",
          error: undefined,
        }), context)
        this.#changed({ slug: ready.slug, status: ready.status })
        return ready
      } catch (error) {
        const failed = await this.#update(slug, current => ({
          ...current,
          enabled: true,
          status: "failed",
          error: errorMessage(error),
        }), context)
        this.#changed({ slug: failed.slug, status: failed.status })
        return failed
      }
    })
  }

  remove(slug: string, context: Context = BACKGROUND_CONTEXT): Promise<void> {
    return this.#exclusive(async () => {
      const record = (await this.#records(context)).find(item => item.slug === slug)
      if (record === undefined) throw new Error("子应用不存在。")
      const extension = this.#registry.snapshot().extension(`subapps:${slug}`)
      if (extension !== undefined) this.#registry.uninstall(extension)
      try {
        await this.#harness.commit(async tx => {
          const doc = await tx.doc(AppSubappsDoc)
          const index = doc.items.findIndex(item => item.slug === slug)
          if (index === -1) throw new Error("子应用不存在。")
          doc.items.splice(index, 1)
        }, context)
      } catch (error) {
        if (extension !== undefined) this.#registry.install(extension)
        throw error
      }
      // 代码目录不属于用户产生数据；卸载后删除失败只留下未引用残留，不恢复已成功的 durable 删除。
      await rm(subappRoot(this.#paths, slug), { recursive: true, force: true })
      this.#changed({ slug, removed: true })
    })
  }

  async #records(context: Context): Promise<AppSubapp[]> {
    let records: AppSubapp[] = []
    await this.#harness.commit(async tx => {
      records = cloneJson((await tx.doc(AppSubappsDoc)).items)
    }, context)
    return records
  }

  async #update(
    slug: string,
    update: (record: AppSubapp) => AppSubapp,
    context: Context,
  ): Promise<AppSubapp> {
    let result: AppSubapp | undefined
    await this.#harness.commit(async tx => {
      const doc = await tx.doc(AppSubappsDoc)
      const index = doc.items.findIndex(item => item.slug === slug)
      if (index === -1) throw new Error("子应用不存在。")
      const current = doc.items[index]
      if (current === undefined) throw new Error("子应用记录不存在。")
      // update 回调可能用 `error: undefined` 清字段；先过一遍 JSON 复制，去掉 strict JSON 不允许的 undefined。
      const next = cloneJson(update(cloneJson(current)))
      doc.items[index] = next
      result = cloneJson(next)
    }, context)
    if (result === undefined) throw new Error("子应用状态提交失败。")
    return result
  }

  #proposalTool(): ToolRegistration {
    return defineTool({
      name: "subapp.propose",
      description: "提交一个本机子应用候选包进行静态检查和受限 smoke；不会安装，必须等待用户在界面确认。",
      parameters: Type.Object({
        manifest: Type.Object({
          schemaVersion: Type.Literal(1),
          slug: Type.String(),
          title: Type.String(),
          requestedCapabilities: Type.Object({
            tools: Type.Array(Type.String()),
            readPaths: Type.Array(Type.String()),
            writePaths: Type.Array(Type.String()),
            network: Type.Boolean(),
            runsCommands: Type.Boolean(),
          }),
        }),
        files: Type.Object({
          tool: Type.String(),
          readme: Type.Optional(Type.String()),
        }),
      }),
      execute: async (args, _api, context) => {
        const proposal = await this.propose(args as SubappCandidate, context)
        return {
          output: [{
            type: "text",
            text: `已生成候选子应用 ${proposal.manifest.title}（${proposal.manifest.slug}），等待用户确认安装。候选编号：${proposal.candidateId}`,
          }],
        }
      },
    })
  }

  #changed(change: SubappChanged): void {
    try { this.#onChanged?.(change) } catch { /* 推送失败不能回滚已提交安装状态。 */ }
  }

  #proposed(proposal: SubappProposal): void {
    try { this.#onProposed?.(proposal) } catch { /* 候选仍在主进程存储，renderer 可在重连后重新拉取。 */ }
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation)
    this.#queue = result.then(() => undefined, () => undefined)
    return result
  }
}

/** durable Draft 由代理组成，不能用 structuredClone；它们的契约本身只允许 JSON 值。 */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function nextVersion(items: readonly AppSubapp[], slug: string): number {
  const current = items.find(item => item.slug === slug)
  return current === undefined ? 1 : current.version + 1
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length <= 1_000 ? message : `${message.slice(0, 997)}...`
}
