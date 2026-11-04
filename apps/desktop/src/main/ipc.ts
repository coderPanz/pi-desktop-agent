/**
 * IPC 进程通信
 * electron 里有两个 IPC 通道
 * - ipcMain：主进程接收消息
 * - ipcRenderer：渲染进程发-收消息
 * 单向发送：
 * - 主 `webContents.send`（主 → 渲染）：mainWindow.webContents.send('hello', { name: 'keith' })
 * - 渲染进程：ipcRenderer.on('hello', (event, arg) => { console.log(arg) })
 * 
 * 双向调用：invoke / handle 渲染进程发起调用，主进程注册处理函数，可以返回 Promise
 * // main
    ipcMain.handle('get-config', async () => {
      return { version: '1.0' }
    })

  // renderer
    const res = await ipcRenderer.invoke('get-config')

 * 该文件：只做三件事——校验发送方、限制通道、把结果原样回给渲染进程。
 */
import { ipcMain, type IpcMainInvokeEvent } from "electron"

import { IPC_INVOKE_CHANNEL } from "@pi/shared-types"
import type { IpcChannel, IpcResult } from "@pi/shared-types"

import type { DesktopRuntime } from "./runtime.ts"

/**
 * 渲染进程可以调的命令通道白名单。
 *
 * `IpcMap` 只是**编译期**契约：跨 IPC 过来的是个任意字符串，主进程得自己挡一道，
 * 否则渲染进程能触发任意通道（包括以后新增但还没想清楚的）。
 * 加通道时这张表也要加——光靠「记得同步」会拖到运行时才报「未知通道」，
 * 所以下面的遗漏检查把它变成编译错误。
 */
const CHANNEL_LIST = [
  "app.info", // 应用与环境信息；也兼作「主进程已就绪」探针
  "app.status", // 宿主健康度快照：调度状态与任务/提交计数
  "conv.list", // 会话列表，含忙碌与排队数
  "conv.open", // 打开会话：返回副本起点 + 起始帧号
  "conv.create", // 新建空白会话
  "conv.submit", // 提交一条用户输入（`requestId` 幂等）
  "conv.abort", // 中断该会话的回答（durable 操作）
  "conv.fork", // 从某条条目分叉出新会话
  "conv.reset", // 重置上下文，不删历史
  "conv.compact", // 压缩上下文，返回摘要条目 id
  "doc.get", // 读一份 `app.*` 文档的当前值
  "approval.list", // 该会话当前待审批的请求
  "approval.respond", // 答复一条审批（重复答复返回终态）
] as const satisfies readonly IpcChannel[]

/** 漏写（或写错）一个通道就编译失败：`Exclude` 的结果必须恰好是 `never`。 */
type MissingChannel = Exclude<IpcChannel, (typeof CHANNEL_LIST)[number]>
const _allChannelsListed: MissingChannel extends never ? true : MissingChannel = true

/** 查询用的集合；声明成 `ReadonlySet<string>` 是因为查的是已收窄成 `string` 的 `unknown`。 */
const CHANNELS: ReadonlySet<string> = new Set(CHANNEL_LIST)

export type RegisterIpcOptions = {
  readonly runtime: DesktopRuntime
  /** 是不是我们自己那个窗口发来的；不是就拒绝。 */
  readonly isTrustedSender: (event: IpcMainInvokeEvent) => boolean
}

/** 注册命令通道，返回注销函数（退出时用）。 */
export function registerIpc(options: RegisterIpcOptions): () => void {
  const { runtime, isTrustedSender } = options

  ipcMain.handle(
    IPC_INVOKE_CHANNEL,
    async (event, channel: unknown, request: unknown): Promise<IpcResult<IpcChannel>> => {
      if (!isTrustedSender(event)) {
        return { ok: false, error: { code: "UNKNOWN", message: "不受信任的调用方" } }
      }
      if (typeof channel !== "string" || !CHANNELS.has(channel)) {
        return { ok: false, error: { code: "INVALID_ARGUMENT", message: `未知通道：${String(channel)}` } }
      }
      // 校验通过后，把 【活】 交给路由去真正处理
      return await runtime.router.handle(channel as IpcChannel, request)
    },
  )

  return () => {
    // 注销 IPC 回调
    ipcMain.removeHandler(IPC_INVOKE_CHANNEL)
  }
}
