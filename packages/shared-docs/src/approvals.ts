/**
 * `app.approvals`：待审批的副作用
 *
 * 审批是「三档策略」的实现点（技术方案 §D6）：只读放行、写文件需确认、危险命令必确认。
 * 审批状态必须与工具任务分开存：任务是 durable 的，审批是人的决定。
 */
import { defineDoc } from "@earendil-works/pi-durable"

/** 审批结果的三种终态：同意、拒绝、超时未决（视为拒绝）。 */
export type ApprovalDecision = "approved" | "denied" | "expired"

/** 一条待审批请求。`id` 与工具调用的 `callId` 不同：同一次调用可以重复请求审批。 */
export type ApprovalRequest = {
  id: string
  callId: string
  tool: string
  /** 给人看的一句话，例如 `rm -rf build/`。 */
  summary: string
  /** 产生请求的时间（毫秒），用于界面排序与超时。 */
  createdAt: number
}

// 待批队列+最近一次审批决定
export type AppApprovals = {
  pending: ApprovalRequest[]
  latest?: {
    id: string
    decision: ApprovalDecision
    at: number
  }
}

// 一条待审批请求
export const AppApprovalsDoc = defineDoc({
  kind: "app.approvals", // 文档类型
  version: 1, // 版本号，后续字段变了需要 +1
  /**
   * 文档作用域：
   * conversation：每个会话一份，需要携带 conversationId 才能读到
   * task：每个任务一份，必须携带 taskId 才能读到
   * session：整个仓库一份，不需要 id，直接读取
   *
   * */
  scope: "conversation",
  /**
   * 这份文档只保留「当前值」，不保留可以回看的旧版本
   * 为什么审批选 latest：
   * 审批文档只有两种有意义的信息：现在还有谁在等、最近一次决定是什么。没人需要「回看 3 天前 14:32 的 pending 列表长什么样」
   * 同时也能拿节省 token
   */
  history: "latest",
  // 分叉时携带过往工具审批决定，避免重复询问
  fork: "current",
  initial: (): AppApprovals => ({ pending: [] }), // 文档第一次被创建时的初始值
  /**
   * 这份文档被改动的次数，目的是存储层的压缩，跟业务计数毫无关系
   *  - info.deltasSinceBase：上一个 base 之后已经存了多少条 【增量】（不含当前这条）
   *  - 返回 true → 本次改动直接存成新 base，之前的 delta 一起丢掉
   * 原因：攒太多读取速度会变慢且占地方，定期把「base + 若干 delta」合并成一份新的 base（就是这里说的 checkpoint）
   */
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 32,
})
