/**
 * 给 UI 展示用：：会话摘要、工具状态、应用信息
 */

import type { ConversationId, EntryId, TaskId } from "./frame.ts"

/** 会话列表里的一条。 */
export type ConversationSummary = {
  readonly id: ConversationId
  /** 从哪个会话的哪条消息分叉出来的；根会话没有。 */
  readonly parent:
    | {
        readonly conversationId: ConversationId
        readonly at: EntryId
      }
    | undefined
  /** 有没有正在跑的回答。 */
  readonly busy: boolean
  /** 排队等着的消息条数。 */
  readonly queued: number
}

/** 工具调用明面上的三种状态：等着跑 / 跑着 / 跑完了。 */
export type ToolStatus = "pending" | "running" | "done"

/** 界面上一个工具调用长什么样。输出太长时只留头尾，丢掉多少单独记着 */
export type ToolInfo = {
  readonly callId: string
  readonly name: string
  readonly status: ToolStatus
  /** 跑完后结果存成的条目；工具出错或被丢掉时没有。 */
  readonly entryId?: EntryId
  readonly taskId?: TaskId
  readonly output?: string
  readonly droppedBytes?: number
  readonly droppedLines?: number
  /** 工具报错了（抛错，或自己返回 isError）。 */
  readonly isError?: boolean
}

/** 整体运行状况，给启动自检和状态栏用；不含任何消息内容。 */
export type HostStatus = {
  /** 调度器在不在推进。 */
  readonly scheduling: "running" | "paused" | "closing"
  /** 任务总数 / 在跑的 / 卡住的 / 还没结算的提交数。 */
  readonly tasks: number
  readonly running: number
  readonly blocked: number
  readonly submissions: number
}

/** 应用和环境信息。界面自己不猜，全部由主进程给。 */
export type HostInfo = {
  readonly appVersion: string
  /** 不在 Electron 里跑时为 undefined（如 CLI、测试）。 */
  readonly electron: string | undefined
  readonly node: string
  readonly chrome: string | undefined
  readonly platform: string
  /** 数据根目录（绝对路径），界面只用来显示。 */
  readonly dataDir: string
  /** 起始会话 id，由主进程给，界面不自己算。 */
  readonly rootConversationId: ConversationId
  /** 当前配置好的模型；没配就是 undefined。 */
  readonly model: { readonly provider: string; readonly modelId: string } | undefined
}
