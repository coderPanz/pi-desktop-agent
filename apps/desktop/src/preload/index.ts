/**
 * 通信桥
 *
 * 只暴露两个通用方法（见 `@pi/shared-types/bridge.ts`）：
 *   - `invoke(channel, request)`：走命令通道，返回 `{ ok, value } | { ok, error }`；
 *   - `subscribe(channel, listener)`：订阅推送，返回取消订阅。
 *
 * 推送通道在这里也做白名单：只允许 `PUSH_CHANNELS` 里那几个。
 */
import { contextBridge, ipcRenderer } from "electron"

import { IPC_INVOKE_CHANNEL, PUSH_CHANNELS } from "@pi/shared-types"
import type { BridgeInvoke, BridgeSubscribe, PiBridge } from "@pi/shared-types"

/**
 * 渲染进程发起调用、等待主进程返回结果，返回 Promise
 */
const invoke: BridgeInvoke = async (channel, request) =>
  await ipcRenderer.invoke(IPC_INVOKE_CHANNEL, channel, request)

/**
 * 主进程主动往渲染端推消息
 * 订阅推送，返回取消订阅
 * @param channel 通道名
 * @param listener 监听器
 * @returns 取消订阅
 */
const subscribe: BridgeSubscribe = (channel, listener) => {
  if (!PUSH_CHANNELS.includes(channel)) {
    throw new Error(`未知推送通道：${String(channel)}`)
  }
  // 发给渲染进程的只有 payload：Electron 的 event 对象不能穿过 contextBridge
  const handler = (_event: unknown, payload: unknown): void => {
    listener(payload as never)
  }
  // 渲染进程订阅并执行
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api: PiBridge & { debug: { ping(): string } } = {
  invoke,
  subscribe,
  // 渲染进程是否真的拿到桥：占位页与自测用它确认。
  debug: { ping: () => "pong" },
}

// 把封装好的 `api` 对象，挂载到全局 `window.pi` 上，让隔离的渲染页面（Vue/React/ 原生页面）安全调用，**而不是直接暴露 ipcRenderer**。
contextBridge.exposeInMainWorld("pi", api)
