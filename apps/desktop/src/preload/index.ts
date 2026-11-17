/**
 * 预加载脚本：通信桥-用于渲染进程与主进程通信
 */


/** 1. `contextBridge`：安全桥，用来把 Electron 能力暴露给页面的 window 对象，隔离渲染层和 Node 环境，是官方推荐的安全方案，禁止直接把 `ipcRenderer` 整个挂到 window 上
2. `ipcRenderer`：渲染进程侧的 IPC 通道，用来和主进程通信（发消息、监听主进程返回）
*/
import { contextBridge, ipcRenderer } from "electron"

// IPC_INVOKE_CHANNEL：“pi:invoke”
import { IPC_INVOKE_CHANNEL, PUSH_CHANNELS } from "@pi/shared-types"
import type { BridgeInvoke, BridgeSubscribe, PiBridge } from "@pi/shared-types"

// 渲染进程发起调用、等待主进程返回结果，返回 Promise
const invoke: BridgeInvoke = async (channel, request) => await ipcRenderer.invoke(IPC_INVOKE_CHANNEL, channel, request)

/**
 * 主进程主动往渲染进程推消息
 * @param channel 通道名
 * @param listener 监听器
 * @returns 取消订阅
 */
const subscribe: BridgeSubscribe = (channel, listener) => {
  if (!PUSH_CHANNELS.includes(channel)) throw new Error(`未知推送通道：${String(channel)}`)
  
  const handler = (_event: unknown, payload: unknown): void => listener(payload as never)
  
  // 渲染进程订阅并执行
  ipcRenderer.on(channel, handler)

  // 取消订阅
  return () => ipcRenderer.removeListener(channel, handler)
  
}

const api: PiBridge & { debug: { ping(): string } } = {
  invoke,
  subscribe,
  // 渲染进程是否真的拿到桥：占位页与自测用它确认。
  debug: { ping: () => "pong" },
}

// 把封装好的 `api` 对象，挂载到全局 `window.pi` 上，让隔离的渲染页面（Vue/React/ 原生页面）安全调用
contextBridge.exposeInMainWorld("pi", api)
