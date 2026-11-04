/**
 * @pi/shared-types — 主进程、preload、渲染进程共用的契约。
 *
 * 一份定义，三处引用：任何一侧改形状，另一侧立刻编译不过。
 * 约束：本包不得依赖 `pi-durable`——渲染进程要能直接引用它。
 *
 * 实现状态：
 *   json.ts    JsonValue / JsonObject 与守卫
 *   frame.ts   帧协议（ViewFrame / ViewSnapshot / applyFrame）与内置 kind 常量
 *   domain.ts  业务视图模型（会话摘要、工具展示、宿主状态）
 *   errors.ts  IPC 错误码与封套
 *   ipc.ts     命令通道 IpcMap
 *   push.ts    推送通道 PushMap
 *
 * 校验：请求的逐字段检查在主进程的 `@pi/core` IPC 路由里（`ipc/router.ts`），
 * 不另建 schemas 包——校验与错误码必须跟实际使用点迪在一处。
 */
export type { JsonObject, JsonValue } from "./json.ts"
export { isJsonObject, isJsonValue } from "./json.ts"

export type {
  ConversationId,
  EntryId,
  OpenedView,
  Op,
  TaskId,
  ViewConversation,
  ViewEntry,
  ViewFrame,
  ViewSnapshot,
} from "./frame.ts"
export {
  applyFrame,
  applyImmutable,
  DocKind,
  EntryKind,
  entryText,
  isBase,
  lastAssistantEntry,
  liveGenerationText,
  liveIsRunning,
  liveTools,
  messageContentText,
} from "./frame.ts"

export type {
  ApprovalDecision,
  ApprovalView,
  ConversationSummary,
  HostInfo,
  HostStatus,
  ToolInfo,
  ToolStatus,
} from "./domain.ts"

export type { IpcErrorCode, IpcErrorPayload } from "./errors.ts"
export { IpcError, toIpcErrorPayload } from "./errors.ts"

export type {
  IpcChannel,
  IpcMap,
  IpcRequest,
  IpcResponse,
  IpcResult,
  WhenBusy,
} from "./ipc.ts"

export type { ApprovalPush, PushChannel, PushMap, Subscribe } from "./push.ts"

export { IPC_INVOKE_CHANNEL, PUSH_CHANNELS } from "./bridge.ts"
export type { BridgeInvoke, BridgeSubscribe, PiBridge } from "./bridge.ts"
