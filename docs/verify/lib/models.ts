/**
 * 模型集合：一个自建 gateway provider，走 Anthropic Messages 协议。
 *
 * 这里只决定「有哪些模型、怎么鉴权」；「这条会话用哪个模型」由 conversation.configure 决定。
 * provider id 与 model id 都会写进存储（ModelRef / AgentState），改名等于破坏已有会话。
 */
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  InMemoryCredentialStore,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai"
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy"

/** 稳定的 provider 标识。 */
export const PROVIDER_ID = "gateway"

const BASE_URL = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"

/**
 * 网关会校验客户端身份，非 Claude Code 的请求返回 403 "Unsupported coding client."
 * 这两个头必须随每条请求发出。
 */
const GATEWAY_HEADERS: Record<string, string> = {
  "user-agent": "claude-cli/2.1.309",
  "x-app": "cli",
}

type GatewayModel = Model<"anthropic-messages">

const gatewayModel = (
  id: string,
  name: string,
  overrides: Partial<GatewayModel> = {},
): GatewayModel => ({
  id,
  name,
  api: "anthropic-messages",
  provider: PROVIDER_ID,
  baseUrl: BASE_URL,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  reasoning: true,
  contextWindow: 128_000,
  maxTokens: 32_000,
  headers: GATEWAY_HEADERS,
  ...overrides,
})

/** 网关实际支持的模型 id，不跟随 Anthropic 官方目录。 */
export const MODEL_ID = process.env.ANTHROPIC_MODEL ?? ""

const MODEL_NAMES: Record<string, string> = {
  "deepseek-v4.1-flash": "DeepSeek V4.1 Flash",
}

export const MODELS: GatewayModel[] = MODEL_ID
  ? [gatewayModel(MODEL_ID, MODEL_NAMES[MODEL_ID] ?? MODEL_ID)]
  : []

/** 建一个只含 gateway provider 的模型集合。每次进程启动建一次，向下传递，不做模块级单例。 */
export function createModelRegistry(): MutableModels {
  if (MODEL_ID === "") {
    throw new Error(
      "缺少 ANTHROPIC_MODEL：请在 .env 里填上网关支持的模型 id（参考 .env.example）。",
    )
  }

  const models = createModels({
    credentials: new InMemoryCredentialStore(),
  })

  models.setProvider(
    createProvider({
      id: PROVIDER_ID,
      name: "Coding Gateway",
      baseUrl: BASE_URL,
      auth: { apiKey: envApiKeyAuth("Gateway API key", ["ANTHROPIC_API_KEY"]) },
      models: MODELS,
      api: anthropicMessagesApi(),
    }),
  )

  return models
}

/** 取第一个可用模型。没有可用模型说明凭证没解析到，必须显式失败而不是猜。 */
export async function pickModel(models: MutableModels) {
  const available = await models.getAvailable()
  const first = available[0]
  if (first === undefined) {
    throw new Error(
      "没有可用模型：请设置 ANTHROPIC_API_KEY（凭证未解析到时 getAvailable() 返回空数组，不抛错）。",
    )
  }
  return first
}
