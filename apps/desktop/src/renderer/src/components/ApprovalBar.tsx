/**
 * 待审批请求：工具要执行敏感操作时出现在消息上方。
 *
 * 只有一条数据来源（`approval.list` + `approval` 推送），答复走 `approval.respond`。
 * 答复后不要本地删除——等主进程把新的 `pending` 推回来，界面才与已提交状态一致。
 */
import type { ApprovalView } from "@pi/shared-types"

export type ApprovalBarProps = {
  readonly pending: readonly ApprovalView[]
  readonly onRespond: (id: string, approved: boolean) => void
}

export function ApprovalBar({ pending, onRespond }: ApprovalBarProps) {
  if (pending.length === 0) return null

  return (
    <div className="space-y-2">
      {pending.map((request) => (
        <div
          key={request.id}
          className="rounded border border-[#78350f] bg-[#2a1f0f] px-3 py-2 text-xs text-[#fcd34d]"
        >
          <div className="font-mono break-all">{request.summary}</div>
          <div className="mt-2 flex items-center gap-2">
            <button
              className="rounded bg-[#166534] px-2 py-1 text-[#dcfce7]"
              onClick={() => onRespond(request.id, true)}
            >
              允许
            </button>
            <button
              className="rounded bg-[#7f1d1d] px-2 py-1 text-[#fee2e2]"
              onClick={() => onRespond(request.id, false)}
            >
              拒绝
            </button>
            <span className="text-[10px] text-[#a16207]">
              不答会在超时后按拒绝处理；答复后才真正执行
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}
