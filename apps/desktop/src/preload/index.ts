// `contextIsolation: true`：渲染页面 JS 和 preload JS 是**两个隔离的上下文**，不能直接互相访问，`contextBridge` 就是二者唯一的桥梁。
import { contextBridge } from "electron"

/**
 * 通过 `contextBridge` 向渲染层暴露一个叫 `pi` 的 API
 */
const api = {
  debug: {
    ping: (): string => "pong",
  },
}
// 挂载到渲染层的 window 对象上
contextBridge.exposeInMainWorld("pi", api)
