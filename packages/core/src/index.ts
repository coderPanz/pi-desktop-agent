/**
 * @pi/core — 纯 Node 运行时层（禁止 import electron）
 *
 * 消费者：`apps/cli`（无 Electron 的终端入口）与 `apps/desktop` 的主进程。两者共用同一套
 * SessionManager / HarnessHost，所以「不启动 Electron 就能复现问题」是这一层的存在理由
 *
 * 已落地（S3 + S4，见 docs/知识中心/技术方案.md §4.1）：
 *   agent/models.ts        gateway provider + createModelRegistry / pickModel
 *   agent/env.ts           NodeExecutionEnv 工厂
 *   session/manager.ts     会话操作（只返回数据，不打印）
 *   paths.ts               WorkspacePaths（根由调用方注入）
 *   storage/create-storage.ts  文件库 / 内存库
 *   harness/open-harness.ts     storage → open → resume → root
 *   harness/registry.ts         装配内置扩展
 *   harness/host.ts             HarnessHost（close 幂等）
 *   frames/frame-hub.ts         多会话 watch → seq → sink
 *   diagnostics/inspect.ts      脱敏的诊断摘要
 *   dev/crash-point.ts          崩溃埋点（默认不动作）
 *
 * 还没落地（S5，依赖 `@pi/shared-docs` 的 `app.*` 文档定义）：
 *   harness/materialize.ts、agent/credentials.ts、frames/doc-hub.ts
 *
 * 不提前写用不到的抽象：没有第二个实现就不建接口。
 */
export {
  createGatewayModel,
  createModelRegistry,
  DEFAULT_BASE_URL,
  gatewayConfigFromEnv,
  pickModel,
  PROVIDER_ID,
  type GatewayConfig,
  type GatewayModel,
} from "./agent/models.ts"
export { createNodeEnv, createNodeEnvFactory, type NodeEnvOptions } from "./agent/env.ts"

export { SessionManager, defaultQueueModes, DEFAULT_QUEUE_MODE, ROOT_CONVERSATION_ID } from "./session/manager.ts"
export type {
  ConversationSummary,
  QueueModes,
  SessionManagerOptions,
  SubmitOptions,
} from "./session/manager.ts"

export { ensureWorkspacePaths, workspacePaths } from "./paths.ts"
export type { WorkspacePaths, WorkspacePathsOptions } from "./paths.ts"

export { createStorage, DEFAULT_BUSY_TIMEOUT_MS } from "./storage/create-storage.ts"
export type { CreateStorageOptions, StorageTarget } from "./storage/create-storage.ts"

export { openHarness } from "./harness/open-harness.ts"
export type { OpenedHarness, OpenHarnessOptions } from "./harness/open-harness.ts"
export { HarnessHost } from "./harness/host.ts"
export type { HarnessHostOptions } from "./harness/host.ts"
export { createPiRegistry, summarizeRegistry } from "./harness/registry.ts"
export type { RegistryOptions, RegistrySummary } from "./harness/registry.ts"

export { FrameHub } from "./frames/frame-hub.ts"
export type { FrameHubOptions, FrameSink, OpenedFrame, ViewFrame } from "./frames/frame-hub.ts"

export { inspectHarness } from "./diagnostics/inspect.ts"
export type {
  InspectionSummary,
  SubmissionSummary,
  TaskSummary,
} from "./diagnostics/inspect.ts"

export { configuredCrashPoint, crashPoint, CRASH_POINTS } from "./dev/crash-point.ts"
export type { CrashPointName } from "./dev/crash-point.ts"
