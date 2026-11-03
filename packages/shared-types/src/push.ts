/**
 * 规定主进程主动告诉界面的消息有哪几种——界面订阅，主进程推送，不需要界面来问。
 * 渲染进程如何订阅：
 */
import type { HostStatus } from "./domain.ts"
import type { ViewFrame } from "./frame.ts"

// 两个通道
export type PushMap = {
  // 会话变了：新消息-流式文字-工具状态
  view: ViewFrame
  /** 宿主健康度变化（启动、暂停、关闭、任务进出）。 */
  "host.status": HostStatus
}

export type PushChannel = keyof PushMap

/** 渲染进程侧的订阅函数；返回值就是取消订阅。 */
export type Subscribe<K extends PushChannel> = (
  listener: (payload: PushMap[K]) => void,
) => () => void
