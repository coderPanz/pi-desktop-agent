/**
 * 模型配置：环境变量优先，其次应用内保存的配置（session 级 `app.settings`）。
 *
 * 密钥不落在 SQLite：core 只声明 `SecretStore`，由宿主提供实现
 * （桌面用 Electron safeStorage 加密存文件；CLI 不存，只读环境变量）。
 * core 不能 import electron，也不能自己决定明文落盘。
 */
import type { Context } from "@earendil-works/chord"
import type { Harness } from "@earendil-works/pi-durable"
import { AppSettingsDoc } from "@pi/shared-docs"
import {
  createModels,
  createProvider,
  type ApiKeyAuth,
  type MutableModels,
  type Models,
} from "@earendil-works/pi-ai"
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy"

import { ConfigError } from "../errors.ts"
import { createGatewayModel, DEFAULT_BASE_URL, PROVIDER_ID } from "./models.ts"

/** 配置来源：env 用于开发与 CI，settings 是用户在应用内保存的。 */
export type ModelConfigSource = "env" | "settings"

export type ModelSettingsSnapshot = {
  readonly modelId: string
  readonly baseUrl: string
  readonly source: ModelConfigSource
  /** 凭证来自哪里，给界面显示；没有可用凭证时 undefined。 */
  readonly keySource: string | undefined
}

/** 宿主提供的密钥存储；`kind` 只用于界面/日志说明来源。 */
export type SecretStore = {
  readonly kind: string
  read(): Promise<string | undefined>
  write(value: string): Promise<void>
  clear(): Promise<void>
}

export type ModelSettingsSaveInput = {
  readonly modelId: string
  readonly baseUrl?: string
  /** 留空表示不改动已保存的密钥。 */
  readonly apiKey?: string
}

export type ModelSettingsOptions = {
  readonly harness: Harness
  readonly secret: SecretStore
  readonly env?: NodeJS.ProcessEnv
}

/** 每次先问存储再问环境变量：应用内保存的密钥优先，符合“用户显式配置优先”。 */
function gatewayAuth(secret: SecretStore, env: NodeJS.ProcessEnv): ApiKeyAuth {
  return {
    name: "Gateway API key",
    async resolve({ ctx, credential, signal }) {
      signal.throwIfAborted()
      if (credential?.key) {
        return { auth: { apiKey: credential.key }, env: credential.env, source: "stored credential" }
      }
      const stored = await secret.read()
      signal.throwIfAborted()
      if (stored !== undefined && stored !== "") {
        return { auth: { apiKey: stored }, source: "应用配置" }
      }
      const fromEnv = await ctx.env("ANTHROPIC_API_KEY")
      signal.throwIfAborted()
      if (fromEnv) return { auth: { apiKey: fromEnv }, source: "ANTHROPIC_API_KEY" }
      void env
      return undefined
    },
  }
}

function buildRegistry(snapshot: ModelSettingsSnapshot | undefined, auth: ApiKeyAuth): MutableModels {
  const models = createModels()
  if (snapshot === undefined) return models
  models.setProvider(
    createProvider({
      id: PROVIDER_ID,
      name: "Coding Gateway",
      baseUrl: snapshot.baseUrl,
      auth: { apiKey: auth },
      models: [createGatewayModel({ modelId: snapshot.modelId, baseUrl: snapshot.baseUrl })],
      api: anthropicMessagesApi(),
    }),
  )
  return models
}

export class ModelSettings {
  readonly #harness: Harness
  readonly #secret: SecretStore
  readonly #env: NodeJS.ProcessEnv
  #snapshot: ModelSettingsSnapshot | undefined
  #models: MutableModels | undefined
  #warming: Promise<void> | undefined

  constructor(options: ModelSettingsOptions) {
    this.#harness = options.harness
    this.#secret = options.secret
    this.#env = options.env ?? process.env
  }

  /** 当前生效的模型集合；Harness 需要同步读取，所以必须先 `warm()`。 */
  current(): Models {
    if (this.#models === undefined) throw new ConfigError("模型配置尚未就绪：请先等待启动完成。")
    return this.#models
  }

  snapshot(): ModelSettingsSnapshot | undefined {
    return this.#snapshot
  }

  /** 启动时调用一次：解析配置并建好模型集合（没有配置时集合为空，生成会报 no_model）。 */
  async warm(context: Context): Promise<ModelSettingsSnapshot | undefined> {
    this.#warming ??= (async () => {
      this.#snapshot = await this.#resolve(context)
      this.#models = buildRegistry(this.#snapshot, gatewayAuth(this.#secret, this.#env))
    })()
    try {
      await this.#warming
    } catch (error) {
      this.#warming = undefined
      throw error
    }
    return this.#snapshot
  }

  /**
   * 保存配置并立即重建模型集合。只影响后续新建会话；
   * 已有会话的模型由各自的 `pi.agent` 决定，不会被静默改写。
   */
  async save(input: ModelSettingsSaveInput, context: Context): Promise<ModelSettingsSnapshot | undefined> {
    const modelId = input.modelId.trim()
    if (modelId === "") throw new ConfigError("模型 id 不能为空。")
    const baseUrl = input.baseUrl?.trim() || DEFAULT_BASE_URL
    await this.#harness.commit(async tx => {
      const doc = await tx.doc(AppSettingsDoc)
      doc.model = { provider: PROVIDER_ID, modelId }
      doc.baseUrl = baseUrl
    }, context)
    if (input.apiKey !== undefined && input.apiKey.trim() !== "") {
      await this.#secret.write(input.apiKey.trim())
    }
    this.#warming = undefined
    await this.warm(context)
    return this.#snapshot
  }

  /** 清除应用内保存的密钥；环境变量仍可作为回退。 */
  async clearKey(): Promise<void> {
    await this.#secret.clear()
    this.#models = undefined
    this.#warming = undefined
  }

  /** 密钥来源说明，给设置面板显示。 */
  async keyState(): Promise<{ readonly stored: boolean; readonly env: boolean }> {
    const stored = (await this.#secret.read()) !== undefined
    return { stored, env: (this.#env["ANTHROPIC_API_KEY"] ?? "") !== "" }
  }

  async #resolve(context: Context): Promise<ModelSettingsSnapshot | undefined> {
    const envModel = this.#env["ANTHROPIC_MODEL"]?.trim() ?? ""
    if (envModel !== "") {
      return {
        modelId: envModel,
        baseUrl: this.#env["ANTHROPIC_BASE_URL"]?.trim() || DEFAULT_BASE_URL,
        source: "env",
        keySource: (this.#env["ANTHROPIC_API_KEY"] ?? "") === "" ? undefined : "ANTHROPIC_API_KEY",
      }
    }
    const doc = await this.#harness.snapshot(AppSettingsDoc, context)
    const modelId = doc?.model?.modelId?.trim() ?? ""
    if (modelId === "") return undefined
    const stored = (await this.#secret.read()) !== undefined
    const envKey = (this.#env["ANTHROPIC_API_KEY"] ?? "") !== ""
    return {
      modelId,
      baseUrl: doc?.baseUrl?.trim() || DEFAULT_BASE_URL,
      source: "settings",
      keySource: stored ? "应用配置" : envKey ? "ANTHROPIC_API_KEY" : undefined,
    }
  }
}