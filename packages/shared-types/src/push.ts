/**
 * 规定主进程主动告诉界面的消息有哪几种——界面订阅，主进程推送，不需要界面来问。
 * 渲染进程如何订阅：
 */
import type { ApprovalView, HostStatus } from "./domain.ts"
import type { ConversationId, ViewFrame } from "./frame.ts"
import type { InputSubmissionView } from "./submission.ts"
import type { SubappChanged, SubappProposal } from "./subapps.ts"

/** 一个会话的待审批集合变化：`pending` 即为当前全量（空数组表示清空）。 */
export type ApprovalPush = {
  // 会话 id
  readonly conversationId: ConversationId
  // 当前会话待审批工具集合
  readonly pending: readonly ApprovalView[]

}

export type PushMap = {
  // 视图帧：帧（每次变化推送的东西），界面那份只读副本的「增量补丁 + 序号」。主进程不整份重发会话，只发 { 哪个会话, 第几号, 变了什么 }
  view: ViewFrame
  // 用户输入追踪：它回答一个问题：「我刚发的那条输入，现在进行到哪一步了、有没有失败」
  submission: InputSubmissionView
  // 宿主状态：调度器运行状态（运行、暂停、关闭），任务总数，运行中的任务，堵塞任务，已提交未处理的任务
  "host.status": HostStatus
  // 待审批工具的集合，审批完成后会从 pending 中移除
  approval: ApprovalPush
  // 会话标题：后台摘要生成好了就推一条，列表不用轮询
  "conv.title": { readonly conversationId: ConversationId; readonly title: string }
  // Agent 生成候选且主进程完成检查后推送；renderer 再按 candidateId 拉确认页和安装 token。
  "subapp.proposed": SubappProposal
  // 子应用安装、启停、加载失败或删除后推送；界面收到后重新拉取完整列表。
  "subapp.changed": SubappChanged
}

// 所有 pushmap key 的联合类型：`view` / `submission` / `host.status` / `approval` 作为推送通道名
export type PushChannel = keyof PushMap

/** 渲染进程侧的订阅函数；返回值就是取消订阅。 */
export type Subscribe<K extends PushChannel> = (
  listener: (payload: PushMap[K]) => void,
) => () => void
