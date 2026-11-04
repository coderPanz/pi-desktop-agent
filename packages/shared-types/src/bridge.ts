/**
 * preload 通过 `contextBridge` 暴露给渲染进程的那层 API
 *
 * 类型放在契约包里，三处共用一个定义：
 *   - preload 按它实现；
 *   - 渲染进程按它调用（`window.pi`）；
 *   - 主进程按 `IpcMap` / `PushMap` 应答。
 *
 * 刻意只给两个通用方法，而不是每个通道一个具名函数：
 * 具名包装放在渲染进程的 `ipc.ts` 里（那边可以自由分层），preload 越薄越安全。
 * **不暴露 `ipcRenderer`**：一旦暴露，渲染进程就能向任意通道发消息。
 */
import type { IpcChannel, IpcRequest, IpcResult } from "./ipc.ts"
import type { PushChannel, PushMap } from "./push.ts"

/**
 * 一条命令：成功带值，失败带码。
 *
 * **不在 preload 里把失败转成 throw**：那样错误码就只剩 message 字符串，
 * 界面没法按 `BUSY` / `SESSION_FAILED` 分别处理。压成异常这一步放在渲染进程的 `ipc.ts`，
 * 那里可以带着 code 一起抛。
 */
export type BridgeInvoke = <K extends IpcChannel>(
  channel: K,
  request: IpcRequest<K>,
) => Promise<IpcResult<K>>

/** 订阅一条推送；返回值是取消订阅。 */
export type BridgeSubscribe = <K extends PushChannel>(
  channel: K,
  listener: (payload: PushMap[K]) => void,
) => () => void

/** 主进程与渲染进程之间的全部通道名：preload 用它做白名单。 */
export const IPC_INVOKE_CHANNEL = "pi:invoke"
export const PUSH_CHANNELS: readonly PushChannel[] = ["view", "host.status", "approval"]

export type PiBridge = {
  readonly invoke: BridgeInvoke
  readonly subscribe: BridgeSubscribe
}
