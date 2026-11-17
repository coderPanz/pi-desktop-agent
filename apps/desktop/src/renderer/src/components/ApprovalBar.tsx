/**
 * 待审批请求：工具要执行敏感操作时出现在消息上方。
 *
 * 只有一条数据来源（`approval.list` + `approval` 推送），答复走 `approval.respond`。
 * 答复后不要本地删除——等主进程把新的 `pending` 推回来，界面才与已提交状态一致。
 */
import type { ApprovalView } from "@pi/shared-types"

import { Icon } from "./Icon.tsx"

export type ApprovalBarProps = {
  readonly pending: readonly ApprovalView[]
  readonly onRespond: (id: string, approved: boolean) => void
}

export function ApprovalBar({ pending, onRespond }: ApprovalBarProps) {
  // 如果待审批的数量为 0 就无需渲染该审批组件
  if (pending.length === 0) return null

  return (
    <div className="shrink-0 space-y-2 px-6 pt-4" aria-label="待审批操作">
      {pending.map((request) => (
        <div key={request.id} className="mx-auto flex max-w-[760px] items-start gap-3 rounded-xl border border-warning/15 bg-warning-soft px-4 py-3.5">
          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-warning/8 text-warning"><Icon name="shield" /></span>
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-semibold text-primary">等待你的批准</p>
            <p className="mt-1 font-mono text-[12px] break-all text-secondary">{request.summary}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button className="rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white shadow-control hover:bg-accent-hover active:bg-accent-active" onClick={() => onRespond(request.id, true)}>允许</button>
              <button className="rounded-lg border border-control-border bg-surface/80 px-3 py-1.5 text-[12px] font-medium text-secondary hover:bg-surface active:bg-subtle" onClick={() => onRespond(request.id, false)}>拒绝</button>
              <span className="text-[11px] leading-5 text-warning">不答会在超时后按拒绝处理；答复后才真正执行</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
