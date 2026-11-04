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

export type AppApprovals = {
  /** 尚待决定的请求，按产生顺序。 */
  pending: ApprovalRequest[]
  /** 最近一次决定，界面用来显示结果。 */
  latest?: {
    id: string
    decision: ApprovalDecision
    at: number
  }
}

export const AppApprovalsDoc = defineDoc({
  kind: "app.approvals",
  version: 1,
  scope: "conversation",
  history: "latest",
  // 分叉时带走过往决定：同一条命令不该在新分支里再问一次。
  fork: "current",
  initial: (): AppApprovals => ({ pending: [] }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 32,
})
