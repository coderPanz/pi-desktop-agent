# @pi/core

**纯 Node 运行时层**：把 pi-durable 的存储、会话、工具注册表、执行环境包成一套「CLI 与 Electron 主进程共用」的零件。

存在理由只有一个：**不启动 Electron 就能复现「排队 / 中断 / 分叉 / 崩溃恢复」这类问题**。
`apps/cli`（终端验收与排障）和 `apps/desktop` 的主进程消费同一套 `SessionManager` / `HarnessHost`，
所以问题出在哪一层不靠猜。

## 边界

| 规则 | 怎么保证 |
|---|---|
| **禁止 `import electron`** | `eslint.config.mjs` 对 `packages/**/*.ts`、`apps/cli/**/*.ts` 开 `no-restricted-imports`，违反即 lint 报错 |
| 只能是纯 Node | 全部模块可用 `node --import tsx` 直接跑；`pnpm test` 不需要 Electron、不联网、不需要 `.env` |
| 不碰界面 | 不 import React / 渲染进程 / `window`；渲染进程反过来也不许 import `@pi/core`（渲染进程只依赖 `@pi/shared-types`） |
| 不重复实现 SDK | `Storage` / `Harness` / `Conversation` / `ExecutionEnv` 这些接口来自 `pi-durable`，core 里**不重新定义接口** |

## 模块地图

`src/index.ts` 是唯一入口（`package.json` 的 `exports` 只有 `"."`），内部 13 个模块：

| 模块 | 职责 | 关键点 |
|---|---|---|
| `agent/models.ts` | gateway provider + `createModelRegistry` / `pickModel` | `PROVIDER_ID = "gateway"` 是落盘契约；凭证走 `envApiKeyAuth`，**每次请求**解析，换 key 不必重建 |
| `agent/env.ts` | `NodeExecutionEnv` 工厂 | 每次使用新建、不缓存（原因见 [17 号笔记](../../docs/notes/durable/17.%20为什么每次调用都新建%20NodeExecutionEnv.md)） |
| `session/manager.ts` | 会话操作：`list/select/create/submit/abort/fork/reset/compact/inbox/isBusy/contextView/entries/view` | 只返回数据、不打印；**不缓存 Conversation 句柄**，也不保存聊天记录 |
| `paths.ts` | `workspacePaths` / `ensureWorkspacePaths` | 根由调用方注入；只算路径 + 建目录，不建库 |
| `errors.ts` | `UserError` / `ConfigError` | 与 SDK 的 `SessionFailed` 分工：前者可继续，后者必须重建 Harness |
| `storage/create-storage.ts` | 文件库（`node:sqlite`，WAL）/ 内存库 | **失败不降级**到内存库；一个库文件只允许一个 Harness |
| `harness/open-harness.ts` | `storage → Harness.open → resume → root` | 顺序是验收口径；把顺序写死，调用方只提供零件 |
| `harness/host.ts` | `HarnessHost` | 唯一有内部依赖的文件；`#closing ??=` 保证 `close()` 幂等 |
| `harness/materialize.ts` | `materializeView` | SDK 视图 → `@pi/shared-types` 的副本结构；坏条目/坏文档丢弃而不抛错 |
| `harness/registry.ts` | `createPiRegistry` / `summarizeRegistry` | 内置扩展由调用方注入（现在默认装 0 个，是刻意的）；注册表可热改 |
| `frames/frame-hub.ts` | 多会话 `watch → seq → sink` | `open()` 不重放历史；每会话一条单调 seq；慢 sink 不阻塞回调 |
| `diagnostics/inspect.ts` | `inspectHarness` | 脱敏：不带 input / 工具参数 / 模型消息 / 堆栈 |
| `dev/crash-point.ts` | `crashPoint("after-submit")` 等 5 个埋点 | 用 `SIGKILL` 而非 `process.exit()`，才像断电；默认什么都不做 |

## 公共导出

`index.ts` 对外承诺 **25 个值 + 24 个类型**，按模块分组：

| 分组 | 值 | 类型 |
|---|---|---|
| 模型 | `createModelRegistry` `createGatewayModel` `pickModel` `gatewayConfigFromEnv` `PROVIDER_ID` `DEFAULT_BASE_URL` | `GatewayConfig` `GatewayModel` |
| 执行环境 | `createNodeEnv` `createNodeEnvFactory` | `NodeEnvOptions` |
| 会话 | `SessionManager` `defaultQueueModes` `DEFAULT_QUEUE_MODE` `ROOT_CONVERSATION_ID` | `ConversationSummary` `QueueModes` `SessionManagerOptions` `SubmitOptions` |
| 路径 | `workspacePaths` `ensureWorkspacePaths` | `WorkspacePaths` `WorkspacePathsOptions` |
| 存储 | `createStorage` `DEFAULT_BUSY_TIMEOUT_MS` | `CreateStorageOptions` `StorageTarget` |
| Harness | `openHarness` `HarnessHost` `createPiRegistry` `summarizeRegistry` | `OpenedHarness` `OpenHarnessOptions` `HarnessHostOptions` `RegistryOptions` `RegistrySummary` |
| 帧 | `FrameHub` | `FrameHubOptions` `FrameSink` `OpenedFrame` `ViewFrame` |
| 诊断 | `inspectHarness` | `InspectionSummary` `SubmissionSummary` `TaskSummary` |
| 崩溃埋点 | `crashPoint` `configuredCrashPoint` `CRASH_POINTS` | `CrashPointName` |

## 最小装配

### 真实运行（CLI / Electron 主进程）

```ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import {
  createModelRegistry, createNodeEnvFactory, createPiRegistry,
  createStorage, ensureWorkspacePaths, HarnessHost, SessionManager, workspacePaths,
} from "@pi/core"

const paths = workspacePaths(dataRoot)          // 根由调用方注入（userData 或 --data-dir）
await ensureWorkspacePaths(paths)               // 只建 workspace/tools/logs 三个目录

const storage = await createStorage({ kind: "file", file: paths.db })
const models = createModelRegistry()            // 读 ANTHROPIC_MODEL / ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY
const registry = createPiRegistry()             // 内置扩展；当前一行不装也能跑

const host = await HarnessHost.open({
  storage,
  models,
  registry,
  env: createNodeEnvFactory({ workspace: paths.workspace }), // 每次使用新建 NodeExecutionEnv
  agent: { cwd: paths.workspace },                          // 只在 root 首次创建时生效
})

const manager = await SessionManager.open({ harness: host.harness, storage })
const submission = await manager.submit("你好")   // 忙时默认 followUp，不打断本轮
await submission.wait(BACKGROUND_CONTEXT)        // 等这一轮跑完；之后用 manager.entries() 读结果
await manager.closeWatches()
await host.close()                               // 幂等
```

`context` 是 pi-durable 每个 API 都要带的「信封」，业务代码没有特殊需求时统一传
`BACKGROUND_CONTEXT`（`@earendil-works/chord/context`），`SessionManager` 内部已默认这么做。

### 测试模式（不联网、不落盘）

```ts
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai"
import { MemoryStorage } from "@earendil-works/pi-durable"
import { createPiRegistry, HarnessHost, SessionManager } from "@pi/core"

const storage = new MemoryStorage()
const models = createModels({ credentials: new InMemoryCredentialStore() }) // 空模型清单
const host = await HarnessHost.open({ storage, models, registry: createPiRegistry() })
const manager = await SessionManager.open({ harness: host.harness, storage })
```

这也是 `session/manager.test.ts` 里的 `openFixture()`——**core 的最小可运行装配就是这 6 行**。

## 设计规则（改代码前先看）

1. **不缓存、不做单例**：`NodeExecutionEnv` 每次使用新建；`models` 每次进程启动建一次后向下传参；
   `SessionManager` 不缓存 `Conversation` 句柄——状态始终以 Harness / Storage 为准。
2. **失败不降级**：存储打不开就抛，不偷偷换内存库；否则「数据没落盘」会被当成「功能正常」。
3. **没有第二个实现就不建接口**：core 里没有任何 `interface` / 抽象基类，`SessionManager` / `HarnessHost` /
   `FrameHub` 都是具体类。
4. **顺序即契约**：`storage → open → resume → root`、`open()` 不重放历史、`fork` 不猜 entryId（没条目就报错）。
5. **不打印**：core 返回数据，格式化交给 `apps/cli/render.ts` 与渲染进程。

## 测试

```bash
pnpm test        # node --import tsx --test "packages/core/src/**/*.test.ts"
pnpm typecheck   # 含 apps/desktop/tsconfig.json
pnpm lint        # 硬边界（禁 electron / 渲染进程禁 node:*）在这里生效
```

当前 **25 条 `node:test`**，5 个测试文件：

| 文件 | 覆盖 |
|---|---|
| `session/manager.test.ts` | 起始会话是 root、新建/切换/列表、fork 继承 parent、**fork 无条目显式失败**、reset 写 `pi.reset`、isBusy/inbox、**view 按会话缓存同一对象**、queue modes、`close()` 幂等 |
| `frames/frame-hub.test.ts` | open 不重放历史、seq 单调 +1、重复 open 续 seq、移除 sink、坏 sink 不打断别人、会话不存在报错 |
| `storage/create-storage.test.ts` | **文件库跨进程重开能读回已提交条目**、父目录自动创建、内存库不落盘 |
| `paths.test.ts` | 默认布局、相对根解析成绝对路径、工作区可指向根外、`ensureWorkspacePaths` 可重复调用 |
| `diagnostics/inspect.test.ts` | 空闲时 0 任务且摘要不含条目内容、注册表摘要只列名字 |

## 依赖方向

下图是**声明意图**（`package.json` 的依赖与目标架构），当前实际状态：

- `apps/cli` / `apps/desktop` 还没接 `@pi/core`（根 README「下一步是接线」说的就是这件事）；
- core 代码目前**没有 import 任何 `@pi/*` 包**，只有注释提到 `@pi/shared-docs` / `@pi/ext-*`。

```
apps/desktop (主进程)  apps/cli              渲染进程（禁 import @pi/core）
            │              │
            └──────┬───────┘
                @pi/core ──→ @pi/ext-coding / ext-kb / ext-smartui / ext-toolsmith（当前空壳）
                   │      ──→ @pi/shared-docs / @pi/shared-types
                   └──────→ @earendil-works/{pi-durable, pi-ai, chord}
```

core 内部只有**一条**内部依赖边：`harness/host.ts → harness/open-harness.ts`；
其余 10 个模块只依赖 SDK 与 `node:*`。

## 还没落地（S5，等 `@pi/shared-docs` 的 `app.*` 文档定义）

- `harness/materialize.ts`——把 `app.*` 文档物化进会话创建
- `agent/credentials.ts`——凭证存储（现在只有 `envApiKeyAuth` 环境变量）
- `frames/doc-hub.ts`——文档帧（FrameHub 现在只推 `ConversationView`）

## 相关文档

- 架构与决策：[`docs/知识中心/技术方案.md`](../../docs/知识中心/技术方案.md) —— §4.1 文件结构、§5 关键设计决策（D1–D14）
- 现状与待办：[`docs/知识中心/ROADMAP.md`](../../docs/知识中心/ROADMAP.md)
- 原子笔记：[`docs/notes/durable/`](../../docs/notes/durable/) —— `ctx`、帧与 ops、watch、调用流程、`NodeExecutionEnv` 等
- 工程约定：[`AGENT.md`](../../AGENT.md)
