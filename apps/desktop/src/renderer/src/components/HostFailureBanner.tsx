import type { HostStatus } from "@pi/shared-types"
import { hostUnavailable } from "@pi/shared-types"
import { Icon } from "./Icon.tsx"

export function HostFailureBanner(props: {
  readonly status: HostStatus | undefined
  readonly restarting: boolean
  readonly onRestart: () => void
}) {
  if (!hostUnavailable(props.status)) return null
  const failed = props.status?.scheduling === "failed"
  return (
    <div role="alert" data-host-state={props.status?.scheduling} className="mx-5 my-2 flex shrink-0 items-start gap-2.5 rounded-xl border border-danger/15 bg-danger-soft px-4 py-3 text-[12px] leading-5 text-danger">
      <Icon name="alert" className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{failed ? "运行时不可用" : "运行时正在关闭"}</p>
        <p>{props.status?.error?.message ?? "发送、审批与会话操作已停用。"}</p>
        <p>已加载的历史副本仍可查看。状态不明的旧工具调用不会自动重放。</p>
      </div>
      {failed ? (
        <button type="button" disabled={props.restarting} onClick={props.onRestart} className="shrink-0 rounded-lg border border-danger/20 px-3 py-1.5 font-medium hover:bg-danger/5 disabled:opacity-50">
          {props.restarting ? "正在重启…" : "重启应用"}
        </button>
      ) : null}
    </div>
  )
}
