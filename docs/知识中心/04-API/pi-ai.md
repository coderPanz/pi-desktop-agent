# pi-ai API 参考（1.4.0）

> pi-durable 负责「什么时候调模型、怎么存」；pi-ai 负责「调哪个模型、怎么鉴权、怎么流」。
> 本项目只使用 pi-ai 的**模型目录 + 请求**能力，不直接管理会话状态。

版本：`@earendil-works/pi-ai@1.4.0`。类型定义位置：`node_modules/@earendil-works/pi-ai/dist/`。

---

## 1. 与 pi-durable 的接缝

只有一个：

```ts
Harness.open(storage, {
  models,          // Models | (() => Models)
  registry,
  settings,
  env,
}, ctx);
```

`Harness` 自己决定何时请求、如何重试、如何压缩；它只通过 `Models` 接口拿模型与鉴权。所以：

- 你不需要在业务代码里调 `models.stream()` 来「生成回复」。
- 你**会**在自定义 Task 里直接调 `models.streamSimple()`（例如知识库总结）。
- 你**会**用 `getModel` / `getAvailable` 做模型选择器。

---

## 2. 创建模型集合

```ts
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";

const models = createModels({
  credentials: new InMemoryCredentialStore(),   // 可替换为持久化实现
  // modelsStore, authContext, identity
});
```

`createModels(options?)` 返回 `MutableModels`（`Models` + 三个修改方法）：

```ts
interface MutableModels extends Models {
  setProvider(provider: Provider): void;   // 按 provider.id upsert
  deleteProvider(id: string): void;
  clearProviders(): void;
}
```

`CreateModelsOptions`（已核实）：

| 字段 | 用途 |
|---|---|
| `credentials` | `CredentialStore`；默认内存 |
| `modelsStore` | 动态模型目录的持久化 |
| `authContext` | 鉴权时的环境访问（`env(name)` / `fileExists`） |
| `identity` | 请求默认身份（客户端标识） |

---

## 3. 内置 provider

```ts
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

models.setProvider(anthropicProvider());
models.setProvider(openaiProvider());
```

工厂签名都很简单：`anthropicProvider(): Provider<"anthropic-messages">`、`openaiProvider(): Provider<"openai-responses">`。

一次性注册全部内置 provider：

```ts
import { builtinModels, builtinProviders } from "@earendil-works/pi-ai/providers/all";

const models = builtinModels();   // 已注册所有内置 provider
```

`builtinModels(options?)` 返回 `MutableModels`。需要精细控制时用 `builtinProviders()` 逐个 `setProvider`。

内置目录会随包版本更新，**模型 id 不要硬编码在 UI 里**，从 `getAvailable()` 取。

---

## 4. 自定义 provider（OpenAI 兼容）

这是接 Tokenplan / 本地推理服务的主路径。

```ts
import { createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

models.setProvider(createProvider({
  id: "tokenplan",
  name: "Tokenplan",
  baseUrl: "https://api.example.com/v1",
  auth: envApiKeyAuth("Tokenplan API key", ["TOKENPLAN_API_KEY"]),
  models: [{
    id: "my-model",
    name: "My Model",
    api: "openai-completions",
    provider: "tokenplan",
    baseUrl: "https://api.example.com/v1",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 8_192,
  }],
  api: openAICompletionsApi(),
}));
```

已核实的约束：

- `createProvider` 要求 `id / auth / models`，并且 `api`（或 `images` / `classifiers`）至少给一个。
- `Provider.auth` 至少要有 `apiKey` 或 `oauth` 之一。即使是无鉴权的本地服务，也要给一个 `apiKey` auth（它的 `resolve()` 返回「已配置」）。
- `api` 可以是一个 `ProviderStreams`，也可以是按 `model.api` 索引的映射。
- `openAICompletionsApi()` 来自 `@earendil-works/pi-ai/api/openai-completions.lazy`，返回 `ProviderStreams`。非 lazy 版本在 `api/openai-completions`，导出 `stream` / `streamSimple`。

**待验证**：`baseUrl` 是否需要带 `/v1`，取决于具体服务；`compat` 字段的自动探测是否覆盖你的服务商。见 [待验证清单](待验证清单.md)。

### `Model` 的必填字段

```ts
interface BaseModel<TApi> {
  id: string;
  name: string;
  api: TApi;
  provider: ProviderId;
  baseUrl: string;
  input: ModelInputModality[];   // ["text"] / ["text","image"]
  cost: ModelCost;
  headers?: Record<string, string>;
}

interface Model<TApi> extends BaseModel<TApi> {
  type?: "chat";
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: ThinkingLevelMap;
  promptCache?: ModelPromptCache;
  samplingParams?: SamplingParams;
  compat?: ...;                  // OpenAI 兼容层用
}
```

`cost` 的字段名以 `ModelCost` 类型为准（`input` / `output` / `cacheRead` / `cacheWrite`）。写错不会报错，只会让用量统计为 0。

---

## 5. 鉴权

### 内置 api-key 鉴权

```ts
envApiKeyAuth(name, envVars)
```

语义（已核实）：**存储的凭证优先，其次取第一个有值的环境变量。** 还自带一个 `login()`，提示用户输入 key。

### 自定义 `CredentialStore`

```ts
interface CredentialStore {
  read(providerId, options?): Promise<Credential | undefined>;
  list(options?): Promise<readonly CredentialInfo[]>;
  modify(providerId, fn, options?): Promise<Credential | undefined>;
  delete(providerId, options?): Promise<void>;
}
```

实现要点：

- `modify` 是**唯一写路径**，必须按 provider 串行。
- `list` 只返回元信息，不返回密钥。
- 返回的凭证要能序列化；Electron 里用 `safeStorage` 加密后落盘。

### 查询与登录

```ts
await models.checkAuth("anthropic");                 // 是否配置完整
await models.getAuth("anthropic");                   // AuthResult | undefined
await models.getAvailable();                         // 只返回可用鉴权的模型
await models.login(providerId, type, interaction);   // 跑 provider 的登录流程
await models.logout(providerId);
```

`getAuth(model)` 会带上模型的静态 headers。解析失败会 reject `ModelsError`（`code: "auth" | "oauth"`）。

---

## 6. 直接请求模型（自定义 Task 用）

```ts
const model = models.getModel("anthropic", "claude-...");
if (!model) throw new Error("model not found");

// Context = { systemPrompt?, messages, tools? }（已核实）
const reqContext = {
  systemPrompt: "你是知识库整理助手。",
  messages: [{ role: "user", content: "总结这段…" }],
};
const message = await models.completeSimple(model, reqContext);
```

流式：

```ts
const stream = models.streamSimple(model, reqContext);
for await (const event of stream) {
  // 事件类型以 AssistantMessageEvent 为准
}
```

`Models.stream/complete` 的 `context` 是 pi-ai 的 `Context`（消息 + 系统提示 + 工具），**不是** chord 的 `Context`。两者同名，注意区分：pi-durable 的调用参数叫 `context` 的是 chord 的；模型请求的上下文是 `ModelContext`/`TranscriptContext` 形状。

> 命名冲突的处理：在本项目内部，chord 的 Context 一律叫 `ctx`，pi-ai 的请求上下文叫 `reqContext`。

---

## 7. 模型查询

| 方法 | 返回 |
|---|---|
| `getProviders()` | 所有 provider |
| `getProvider(id)` | 单个 |
| `getModels(provider?)` | 已知聊天模型（同步、可能为空） |
| `getModel(provider, id)` | `Model<Api> \| undefined` |
| `getAvailable(provider?)` | 已配置鉴权的模型（异步） |
| `getAllAvailable()` | 所有类型 |
| `refresh({providers?, allowNetwork?})` | 刷新动态目录 |
| `hasApi(model, api)` | 类型守卫，收窄 `Model<TApi>` |
| `calculateCost(model, usage)` | 计算费用 |
| `modelsAreEqual(a, b)` | 比较 type/id/provider |

`getModel` 返回的是 `Model<Api>`，直接传给 `stream` 时类型很宽。用 `hasApi` 收窄后再拿具体选项类型。

---

## 8. 用量

pi-durable 已经把每次请求的 token 与费用写进 `pi.usage`（按 `provider/model`，工具结果按工具名）。你**不需要**自己记账。

自定义 Task 里直接调 `models.streamSimple` 时，用量不会自动进 `pi.usage`——要么把结果通过 `rt.commit` 写进业务文档，要么走工具（工具结果带 `usage` 会被统计）。

---

## 9. 版本与兼容

- pi-durable 1.4.0 依赖 pi-ai 1.4.0。**不要**在同一个项目里装两个 pi-ai 版本。
- `package.json` 里用精确版本或 `~1.4.0`，不要 `^` 跨 minor（pi-ai 的 minor 有过 breaking）。
- 模型目录是**生成**的（`models.generated.d.ts`），升级后会变。不要把生成目录里的 id 当稳定 API。

检查实际版本：

```bash
node -p "require('@earendil-works/pi-ai/package.json').version"
```

---

## 10. 常见失败

| 现象 | 原因 | 修法 |
|---|---|---|
| 启动时没有模型 | 没 `setProvider` 或 provider 未配置 | `getAvailable()` 检查 |
| 401/403 | key 没解析到 | `checkAuth` / `getAuth` 看来源 |
| 400 unknown model | `model.id` 与服务端不一致 | 对照服务商文档 |
| 流式没有输出 | `baseUrl` 少了 `/v1` 或 SSE 被代理缓冲 | 用 `curl` 验证；关代理缓冲 |
| 费用统计为 0 | `cost` 字段缺失/写错 | 对照 `ModelCost` |
| 两个 pi-ai 实例 | 依赖树里有重复版本 | `npm ls @earendil-works/pi-ai` |
| Tokenplan 连不上 | 自定义 provider 的 `api` 没给 | `api: openAICompletionsApi()` |

---

## 11. 相关文档

- 模型选择与凭证落地：[../03-Electron/01-主进程与HarnessHost.md](../03-Electron/01-主进程与HarnessHost.md) 第 5 节
- 待验证项：[待验证清单.md](待验证清单.md)
