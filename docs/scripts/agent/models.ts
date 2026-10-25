import {
  createModels,
  createProvider,
  envApiKeyAuth,
  InMemoryCredentialStore,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai"

import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy"

// 网关地址，与 Claude Code 共用 ANTHROPIC_BASE_URL
const BASE_URL = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"

// 网关会校验客户端身份，非 Claude Code 的请求返回 403 "Unsupported coding client."
// 这两个头必须随每条请求发出。
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
  provider: "gateway",
  baseUrl: BASE_URL,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  reasoning: true,
  contextWindow: 128_000,
  maxTokens: 32_000,
  headers: GATEWAY_HEADERS,
  ...overrides,
})

// 网关实际支持的模型 id，不要用 Anthropic 官方目录里的名字
const MODEL_ID = process.env.ANTHROPIC_MODEL ?? "deepseek-v4.1-flash"

const MODEL_NAMES: Record<string, string> = {
  "deepseek-v4.1-flash": "DeepSeek V4.1 Flash",
}

export const MODELS: GatewayModel[] = [
  gatewayModel(MODEL_ID, MODEL_NAMES[MODEL_ID] ?? MODEL_ID),
]

// 模型注册器：一个自建 provider，走网关的 Anthropic Messages 协议
export const createModelRegistry = () => {
  const models = createModels({
    credentials: new InMemoryCredentialStore(),
  })

  models.setProvider(createProvider({
    id: "gateway",
    name: "Coding Gateway",
    baseUrl: BASE_URL,
    auth: {
      apiKey: envApiKeyAuth("Gateway API key", ["ANTHROPIC_API_KEY"]),
    },
    models: MODELS,
    api: anthropicMessagesApi(),
  }))

  return models
}

// 模型拾取
export const pickModel = async (models: MutableModels) => {
  const available = await models.getAvailable()
  if (available.length === 0) {
    throw new Error("没有可用模型：请设置 ANTHROPIC_API_KEY，然后重新运行。")
  }
  return available[0]
}
