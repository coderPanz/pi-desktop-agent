/**
 * IPC 进程通信
 * 校验发送方、限制通道、把结果原样回给渲染进程
 */
import { ipcMain, type IpcMainInvokeEvent } from "electron"

import { IPC_INVOKE_CHANNEL } from "@pi/shared-types"
import type { IpcChannel, IpcResult } from "@pi/shared-types"

import type { DesktopRuntime } from "./runtime.ts"

// 渲染进程调用命令白名单
const CHANNEL_LIST = [
  "app.info", // 应用与环境信息；
  "app.status", // 宿主状态
  "app.restart", // 宿主失效后重启应用
  "conv.list", // 会话列表-含忙碌与排队数
  "conv.open", // 打开会话：返回副本起点 + 起始帧号
  "conv.submission", // 最近一次用户输入的持久化状态（含终态失败）
  "conv.create", // 新建空白会话
  "conv.submit", // 提交一条用户输入
  "conv.abort", // 中断该会话
  "conv.fork", // 分叉
  "conv.delete", // 删除会话-从列表移除
  "conv.rename", // 重命名-写会话标题
  "conv.pin", // 置顶 / 取消置顶
  "conv.reset", // 重置上下文-不删历史
  "conv.compact", // 压缩上下文-返回摘要条目 id
  "doc.get", // 读一份 `app.*` 文档的当前值
  "approval.list", // 该会话当前待审批的所有请求
  "approval.respond", // 用户答复该审批
] as const satisfies readonly IpcChannel[]

type MissingChannel = Exclude<IpcChannel, (typeof CHANNEL_LIST)[number]>
const _allChannelsListed: MissingChannel extends never ? true : MissingChannel = true
const CHANNELS: ReadonlySet<string> = new Set(CHANNEL_LIST)

export type RegisterIpcOptions = {
  readonly runtime: DesktopRuntime
  /** 检查是否为信任窗口发来的调用；不是就拒绝。 */
  readonly isTrustedSender: (event: IpcMainInvokeEvent) => boolean
}

/** 注册命令通道，返回注销函数（退出时用）。 */
export function registerIpc(options: RegisterIpcOptions): () => void {
  const { runtime, isTrustedSender } = options

  // 监听【渲染进程】发来的 IPC 调用
  ipcMain.handle(
    IPC_INVOKE_CHANNEL, // export const IPC_INVOKE_CHANNEL = "pi:invoke"， 监听渲染进程的 pi:invoke 调用
    async (
      event,
      channel: unknown,
      request: unknown,
    ): Promise<IpcResult<IpcChannel>> => {
      if (!isTrustedSender(event)) {
        return {
          ok: false,
          error: { code: "UNKNOWN", message: "不受信任的调用方" },
        }
      }
      if (typeof channel !== "string" || !CHANNELS.has(channel)) {
        return {
          ok: false,
          error: {
            code: "INVALID_ARGUMENT",
            message: `未知通道：${String(channel)}`,
          },
        }
      }
      /**
       * DesktopRuntime 声明了 router: IpcRouter 属性
       * handle方法：返回命令的调用结果
       * IpcRouter 在构造时在应用启动阶段，并传入了 Harness-manager 所以可以进行进行任务分发执行。
       */
      return await runtime.router.handle(channel as IpcChannel, request)
    },
  )

  return () => {
    // 注销 IPC 回调
    ipcMain.removeHandler(IPC_INVOKE_CHANNEL)
  }
}
