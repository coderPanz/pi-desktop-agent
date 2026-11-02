/**
 * 模型集合：一个自建 gateway provider，走 Anthropic Messages 协议
 *
 * 这里只决定「有哪些模型、怎么鉴权」；
 * 「这条会话用哪个模型」由 `conversation.configure()` 决定
 */
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  InMemoryCredentialStore, // 内存凭证存储
  type Model,
  type MutableModels, // 多模型集合
} from "@earendil-works/pi-ai"
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy"

/** provider 标识 */
export const PROVIDER_ID = "gateway"

export const DEFAULT_BASE_URL = "https://api.anthropic.com"

/** 【未来云 tokenplan 网关】会校验客户端身份，非 Claude Code 的请求返回 403 "Unsupported coding client." */
const GATEWAY_HEADERS: Record<string, string> = {
  "user-agent": "claude-cli/2.1.309",
  "x-app": "cli",
}

/** 网关配置 */
export type GatewayConfig = {
  readonly modelId: string
  readonly baseUrl: string
}

export type GatewayModel = Model<"anthropic-messages">

const MODEL_NAMES: Record<string, string> = { // Record ts 内置用于分别定义对象键与值的类型
  "deepseek-v4.1-flash": "DeepSeek V4.1 Flash",
}

/** 从环境变量读网关配置 */
export function gatewayConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const modelId = env.ANTHROPIC_MODEL?.trim() ?? ""
  if (modelId === "") throw new Error("缺少 ANTHROPIC_MODEL：请在 .env 里填上网关支持的模型 id（参考 .env.example）。",)
  
  return {
    modelId,
    baseUrl: env.ANTHROPIC_BASE_URL?.trim() || DEFAULT_BASE_URL,
  }
}

/** 建一个网关模型描述。改字段等于改成本/上限，谨慎。 */
export function createGatewayModel(config: GatewayConfig): GatewayModel {
  return {
    id: config.modelId,
    name: MODEL_NAMES[config.modelId] ?? config.modelId,
    api: "anthropic-messages",
    provider: PROVIDER_ID,
    baseUrl: config.baseUrl,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: true,
    contextWindow: 128_000,
    maxTokens: 32_000,
    headers: GATEWAY_HEADERS,
  }
}

/**
 * 建一个只含 gateway provider 的模型集合。每次进程启动建一次，向下传递，不做模块级单例。
 * 凭证走 `envApiKeyAuth`：解析发生在每次请求，所以换 key 不必重建模型集合。
 */
export function createModelRegistry(config: GatewayConfig = gatewayConfigFromEnv()): MutableModels {
  const models = createModels({ credentials: new InMemoryCredentialStore() })

  models.setProvider(
    createProvider({
      id: PROVIDER_ID,
      name: "Coding Gateway",
      baseUrl: config.baseUrl,
      auth: { apiKey: envApiKeyAuth("Gateway API key", ["ANTHROPIC_API_KEY"]) },
      models: [createGatewayModel(config)],
      api: anthropicMessagesApi(),
    }),
  )

  return models
}

/**
 * 取第一个可用模型
*/
export async function pickModel(models: MutableModels): Promise<Model<"anthropic-messages">> {
  const available = await models.getAvailable()
  const first = available[0]
  if (first === undefined) throw new Error("没有可用模型：请设置 ANTHROPIC_API_KEY（凭证未解析到时 getAvailable() 返回空数组，不抛错）。",)
  return first as Model<"anthropic-messages">
}
