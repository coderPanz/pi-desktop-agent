import type { HostStatus } from "./domain.ts"

export function hostUnavailable(status: HostStatus | undefined): boolean {
  return status?.scheduling === "failed" || status?.scheduling === "closing"
}

/** 本版本只通过应用重启恢复；迟到的健康快照不能覆盖已知失效或关闭状态。 */
export function mergeHostStatus(current: HostStatus | undefined, incoming: HostStatus): HostStatus {
  if (current?.scheduling === "failed") return current
  if (current?.scheduling === "closing" && incoming.scheduling !== "failed") return current
  return incoming
}
