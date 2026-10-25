import { contextBridge } from "electron"

/**
 * preload 只做「通道映射 + 类型收窄」，不写业务逻辑。
 *
 * 现在只暴露一个 ping，用来验证 contextBridge + sandbox 链路是否通。
 * 阶段 5 起按 技术方案二.md §7 增加 conv.* / doc.* / settings.*，
 * 规矩不变：只暴露具体方法（不暴露 ipcRenderer），每个 on* 必须返回 unsubscribe。
 */
const api = {
  debug: {
    ping: (): string => "pong",
  },
}

contextBridge.exposeInMainWorld("pi", api)
