/**
 * 规定主进程主动告诉界面的消息有哪几种——界面订阅，主进程推送，不需要界面来问。
 * 渲染进程如何订阅：
 */
import type { ApprovalView, HostStatus } from "./domain.ts"
import type { ConversationId, ViewFrame } from "./frame.ts"

/** 一个会话的待审批集合变化：`pending` 即为当前全量（空数组表示清空）。 */
export type ApprovalPush = {
  readonly conversationId: ConversationId
  readonly pending: readonly ApprovalView[]
}

// 三个通道
export type PushMap = {
  // 会话变了：新消息-流式文字-工具状态
  view: ViewFrame
  /** 宿主健康度变化（启动、暂停、关闭、任务进出）。 */
  "host.status": HostStatus
  /** 待审批集合变化（新增请求、已答、超时）。 */
  approval: ApprovalPush
}

export type PushChannel = keyof PushMap

/** 渲染进程侧的订阅函数；返回值就是取消订阅。 */
export type Subscribe<K extends PushChannel> = (
  listener: (payload: PushMap[K]) => void,
) => () => void
