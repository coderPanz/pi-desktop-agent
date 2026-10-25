# 阶段 0：工作区与最小 Agent 调用

> **目标**：不碰 Electron，用一个 Node 脚本把「提交一句话 → 模型回答 → 打印结果」跑通。
> **预计**：0.5–1 天。**产出**：一个能重复运行的脚本 + 一份运行记录。

---

## 1. 前置概念

- **Harness 不是 HTTP 客户端。** 它管理会话、任务、存储；模型请求只是其中一步。
- `submit()` **是收件，不是回答。** 它返回 `Submission`，回答要靠 `wait()` 或订阅。
- **没有** `resume()` **就没有调度。** `submit()` 会顺带开启调度，但显式调用更清楚。
- **MemoryStorage 不持久化。** 这一阶段就是故意的：先把链路跑通，再谈落盘。
- **Provider 是「模型来源」，Model 是「具体模型」。** 一个 provider 可以有很多 model。

---

## 2. 先读哪些文档

按顺序：

1. [核心心智模型](../02-PI-Durable/01-核心心智模型.md) —— 规则 1、2、3
2. [PI-Durable API 参考](../02-PI-Durable/02-API参考.md) —— 第 1、2 节
3. [pi-ai API 参考](../04-API/pi-ai.md) —— 第 2–5 节
4. [待验证清单](../04-API/待验证清单.md) —— 3.6–3.8

不需要读：Electron、IPC、Document、Task、TokUI。

---

## 3. 架构位置与模块协作

```
scripts/00-min-agent.ts
   │
   ├─ models.ts        createModels + setProvider
   ├─ registry.ts      createRegistry（可以先为空）
   └─ Harness.open(MemoryStorage, { models, registry }, ctx)
          │
          ├─ harness.resume()
          ├─ root = harness.root(ctx)
          ├─ submission = root.submit({type:"input", content, requestId}, ctx)
          └─ await submission.wait(ctx)
                 │
                 └─ 读 root.entries(...) 或 root.viewState(ctx)
```

这一阶段**没有**：Electron、文件工具、SQLite、UI、扩展。

---

## 4. API 清单

| 目的 | API | 导入路径 |
|---|---|---|
| 模型集合 | `createModels(options?)` | `import { createModels } from "@earendil-works/pi-ai"` |
| 凭证存储 | `InMemoryCredentialStore` | `import { InMemoryCredentialStore } from "@earendil-works/pi-ai"` |
| 注册 provider | `models.setProvider(provider)` | 方法，无需单独导入 |
| 内置 provider | `anthropicProvider()` | `import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic"` |
| 内置 provider | `openaiProvider()` | `import { openaiProvider } from "@earendil-works/pi-ai/providers/openai"` |
| 一次性注册全部 | `builtinModels()` | `import { builtinModels } from "@earendil-works/pi-ai/providers/all"` |
| 自定义 provider | `createProvider({...})` + `openAICompletionsApi()` | `import { createProvider } from "@earendil-works/pi-ai"`；`import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy"` |
| 环境变量鉴权 | `envApiKeyAuth(name, envVars)` | `import { envApiKeyAuth } from "@earendil-works/pi-ai"` |
| 模型集合类型 | `MutableModels` / `Models` | `import type { MutableModels, Models } from "@earendil-works/pi-ai"` |
| 注册表 | `createRegistry()` | `import { createRegistry } from "@earendil-works/pi-durable"` |
| 打开 | `Harness.open(storage, options, ctx)` | `import { Harness, MemoryStorage } from "@earendil-works/pi-durable"` |
| 调度 | `harness.resume()` | 方法 |
| 根会话 | `harness.root(ctx)` | 方法 |
| 配置模型 | `conversation.configure({ model }, ctx)` | 方法 |
| 提交 | `conversation.submit(draft, ctx)` | 方法 |
| 等待 | `submission.wait(ctx)` | 方法 |
| 读历史 | `conversation.entries(query, limit, cursor, ctx)` | 方法 |

`Context` 用 `BACKGROUND_CONTEXT`：

```ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
```

`createModelRegistry` / `pickModel` **不是 SDK 导出**，是你在 `scripts/agent/models.ts` 里自己写的两个函数。下面的代码才说明它们从哪些 API 组装而来。

---

## 5. 手写任务

### 5.1 工作区初始化

自己决定包管理器（pnpm / npm），写 `package.json`：

- `"type": "module"`
- `engines.node: ">=22.19.0"`
- 依赖：`@earendil-works/pi-durable@1.4.0`、`@earendil-works/pi-ai@1.4.0`、`typebox@1.3.27`、`tsx`（或 `ts-node`）
- 脚本：`"dev": "tsx scripts/00-min-agent.ts"`

### 5.2 `scripts/agent/models.ts`

这个文件里有两个**你自己写**的函数。先写导入，再写函数体：

```ts
import {
  createModels,
  InMemoryCredentialStore,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

export function createModelRegistry(): MutableModels {
  const models = createModels({
    credentials: new InMemoryCredentialStore(),
  });

  models.setProvider(anthropicProvider());
  models.setProvider(openaiProvider());

  // Tokenplan 等自定义 provider 先不要加。等内置 provider 跑通后，
  // 再按 04-API/pi-ai.md 第 4 节加 createProvider + openAICompletionsApi。
  return models;
}
```

再写 `pickModel`：

```ts
export async function pickModel(models: MutableModels) {
  const available = await models.getAvailable();
  if (available.length === 0) {
    throw new Error(
      "没有可用模型：请设置 ANTHROPIC_API_KEY 或 OPENAI_API_KEY，然后重新运行。",
    );
  }
  return available[0];   // { provider, id, ... }，类型由 getAvailable() 推断
}
```

要点：

- `createModels` 的默认凭证存储就是内存实现，显式传 `new InMemoryCredentialStore()` 只是让阶段 0 的行为一目了然。后面换成 Electron `safeStorage` 实现的是同一个 `CredentialStore` 接口。
- `setProvider` 是按 `provider.id` upsert，重复调用不会产生第二个 provider。
- `getAvailable()` 是异步的，它要解析凭证；没有 key 时返回空数组，不是抛错。
- **不要**把 `models` 写成一个模块级单例在脚本里到处 import；阶段 0 就在 `main` 里创建一次、向下传。
- `getAvailable()` 的元素带 `provider` 与 `id`；后面配置会话时用它们拼 `ModelRef`。

### 5.3 `scripts/00-min-agent.ts`

按顺序写：

```ts
// 伪结构，不是完整代码
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModelRegistry, pickModel } from "./agent/models.ts";

const ctx = BACKGROUND_CONTEXT;
const models = createModelRegistry();
const model = await pickModel(models);          // { provider, id, ... }
const registry = createRegistry();
const storage = new MemoryStorage();

const harness = await Harness.open(storage, { models, registry }, ctx);
try {
  harness.resume();
  const root = await harness.root(ctx);

  // 关键：Harness 不知道你想用哪个模型，必须显式配置
  await root.configure({
    model: { provider: model.provider, modelId: model.id },
  }, ctx);

  const submission = await root.submit({
    type: "input",
    content: "用一句话介绍你自己",
    requestId: crypto.randomUUID(),
  }, ctx);
  const settled = await submission.wait(ctx);
  console.log(settled);

  const page = await root.entries({ order: "descending" }, 10, undefined, ctx);
  console.log(page.items.map(e => ({ id: e.id, kind: e.kind, model: e.model, data: e.data })));
} finally {
  await harness.close(ctx);
}
```

要求：

- `requestId` 用 `crypto.randomUUID()`。
- `root.configure` 必须在 `submit` 之前；`ModelRef` 的字段名是 `provider` + `modelId`（不是 `model` 或 `id`）。
- 打印 `settled.status` 与最后一条 assistant 的文本。
- `finally` 里 `close()`，即使失败也关。

### 5.4 `scripts/00-min-agent.repeat.ts`（可选）

用同一个 `requestId` 提交两次，打印两次的 `submission.id`，确认相同。

---

## 6. 实现提示

- **先验 provider，再写业务。** 用 `curl` 直接请求服务商的 `/models` 或 `/chat/completions`，确认 key 与 baseUrl。不要用应用去调试网络问题。
- `getAvailable()` **是异步的。** 它要解析凭证。
- **模型 id 不要猜。** 从 `getAvailable()` 的返回值里挑，打印出来看。
- `entry.model` **是消息数组。** 最后一条 assistant 的文本在 `model[0].content` 里（content 可能是字符串或块数组），先 `console.dir` 一次真实结构再提取。
- **不要在脚本里** `process.exit(0)`**。** 用 `await harness.close(ctx)`，否则你会误以为「关不掉」。
- **如果卡住不动**：检查是否调用了 `resume()`；检查 `submission.wait()` 是否在 `try` 里被吞了；用 `harness.inspect(ctx)` 看任务状态。
- **Tokenplan 的** `baseUrl`：先按服务商文档带 `/v1`；400 时再试不带。

---

## 7. 调试方法

| 问题       | 命令/位置                                                                          |
| -------- | ------------------------------------------------------------------------------ |
| 有哪些模型    | `console.log((await models.getAvailable()).map(m =>` ${m.provider}/${m.id}`))` |
| 请求有没有发出  | 在 `onReport` 里打印；或看服务商控制台                                                      |
| 任务卡在哪    | `console.dir(await harness.inspect(ctx), {depth: 5})`                          |
| 消息结构长什么样 | `console.dir(page.items, {depth: 8})`                                          |
| 提交是否去重   | 打印两次 `submission.id`                                                           |
| key 是否读到 | 单独打印 `process.env.X ? "set" : "missing"`，不要打印值                                 |

脚本级调试不要引入日志框架。`console.dir(..., {depth})` 足够。

---

## 8. 验收标准

全部满足才算完成：

- [ ] `pnpm dev` 能打印出一段模型回答。
- [ ] 打印出的 `provider/modelId` 与 `pickModel()` 选中的模型一致。
- [ ] 打印出的最后一条 assistant entry 的文本，与屏幕输出一致。
- [ ] 没设置 key 时，错误信息能指出缺哪个环境变量，而不是 `undefined is not a function`。
- [ ] 同一个 `requestId` 提交两次，`submission.id` 相同。
- [ ] 脚本正常退出（没有挂起的 timer / 未关闭的 Harness）。
- [ ] `harness.inspect(ctx)` 显示没有 running 任务（在 close 前打印一次）。

---

## 9. 阶段产出

- `scripts/00-min-agent.ts`
- `scripts/agent/models.ts`
- 一份 `notes/stage0.md`：记录你用的 provider、模型 id、遇到的第一个错误及原因。

**不要**在这一阶段建 Electron 工程、写 UI、接 SQLite。那些是后面的事。

---

## 10. 常见失败

| 现象 | 原因 | 修法 |
|---|---|---|
| `No models available` | 没注册 provider / 凭证没解析 | 先 `checkAuth`，再 `getAvailable` |
| 提交后报「没有模型」/ 模型未配置 | 只把 `models` 传给 Harness，没给会话选模型 | submit 前 `configure({ model: { provider, modelId } })` |
| `modelId: undefined` | 把 pi-ai 的 `model.id` 写成了 `model.model` | `ModelRef` 是 `{ provider, modelId }` |
| 一直不返回 | 忘了 `resume()`，或 `wait()` 的 ctx 被取消 | 显式 `resume()`；用 `BACKGROUND_CONTEXT` |
| `401` | key 环境变量名写错 | 核对 `envApiKeyAuth` 的第二个参数 |
| `404 model not found` | 模型 id 或 baseUrl 错 | 用 `/models` 返回值 |
| `entry.model` 是 undefined | 读了 user entry，不是 assistant | 过滤 `kind === "pi.assistant"` |
| 进程不退出 | Harness 没 close / 有 timer | `await harness.close(ctx)` |
| `requestId` 重复导致第二次没反应 | 用了固定字符串 | 每次 `randomUUID()` |
| TypeScript 找不到子路径 | `moduleResolution` 不是 `bundler`/`node16` | 配 `"moduleResolution": "bundler"` |

---

## 下一步

[阶段 1：流式输出与状态订阅](阶段1-流式输出与状态订阅.md)
