/** 宿主状态来自主进程；失效后保留已有列表，停止查询已关闭的库。 */
import { useCallback, useEffect, useRef, useState } from "react"
import { hostUnavailable, mergeHostStatus } from "@pi/shared-types"
import type { ApprovalView, ConversationId, ConversationSummary, HostInfo, HostStatus } from "@pi/shared-types"

import { invoke, subscribe } from "../ipc.ts"

export type HostState = {
  readonly info: HostInfo | undefined
  readonly status: HostStatus | undefined
  readonly conversations: readonly ConversationSummary[]
  readonly loaded: boolean
}
export type HostHandle = HostState & {
  readonly refresh: () => Promise<void>
  readonly checkHealth: () => Promise<void>
  readonly restart: () => Promise<void>
}

export function useHost(): HostHandle {
  const [info, setInfo] = useState<HostInfo | undefined>(undefined)
  const [status, setStatus] = useState<HostStatus | undefined>(undefined)
  const [conversations, setConversations] = useState<readonly ConversationSummary[]>([])
  const [loaded, setLoaded] = useState(false)
  // 只用于跨异步请求的即时准入检查，UI 仍只读主进程的 status。
  const latestStatus = useRef<HostStatus | undefined>(undefined)
  const active = useRef(false)
  const accept = useCallback((incoming: HostStatus) => {
    if (!active.current) return
    const next = mergeHostStatus(latestStatus.current, incoming)
    latestStatus.current = next
    setStatus(next)
  }, [])

  useEffect(() => {
    active.current = true
    let current = true
    // 先订阅再查询；查询响应可能比失败推送更晚到达。
    const stop = subscribe("host.status", accept)
    void invoke("app.info", {}).then(value => { if (current) setInfo(value) }).catch(() => {})
    void invoke("app.status", {}).then(value => { if (current) accept(value) }).catch(() => {})
    return () => { current = false; active.current = false; stop() }
  }, [accept])

  const checkHealth = useCallback(async () => { accept(await invoke("app.status", {})) }, [accept])
  useEffect(() => {
    if (status?.scheduling !== "closing") return
    // closing 是等待资源收尾的过渡态；即使失败推送丢失，也能取得最终的失败快照。
    const timer = setInterval(() => { void checkHealth().catch(() => {}) }, 250)
    return () => clearInterval(timer)
  }, [status?.scheduling, checkHealth])

  const refresh = useCallback(async () => {
    if (!active.current || hostUnavailable(latestStatus.current)) return
    try {
      const items = await invoke("conv.list", { limit: 50 })
      if (!active.current || hostUnavailable(latestStatus.current)) return
      setConversations(items)
      setLoaded(true)
    } catch (error) {
      // 推送丢失时也能通过不访问存储的健康快照获得失效状态。
      if (active.current) await checkHealth().catch(() => {})
      throw error
    }
  }, [checkHealth])
  useEffect(() => { void refresh().catch(() => {}) }, [refresh])
  useEffect(() => subscribe("conv.title", payload => {
    if (hostUnavailable(latestStatus.current)) return
    setConversations(current => current.map(item =>
      item.id === payload.conversationId ? { ...item, title: payload.title } : item))
  }), [])

  const restart = useCallback(async () => { await invoke("app.restart", {}) }, [])

  // 会话列表里的忙/排队是主进程算的，任务结束不会自己重拉；
  // submission 一变就防抖刷新，覆盖“开始忙”“入队”“结束”三种时机。
  const refreshTimer = useRef<number | undefined>(undefined)
  useEffect(() => subscribe("submission", () => {
    if (!active.current || hostUnavailable(latestStatus.current)) return
    window.clearTimeout(refreshTimer.current)
    refreshTimer.current = window.setTimeout(() => {
      void refresh().catch(() => {})
    }, 150)
  }), [refresh])
  useEffect(() => () => window.clearTimeout(refreshTimer.current), [])

  return { info, status, conversations, loaded, refresh, checkHealth, restart }
}

export type ApprovalsHandle = {
  readonly pending: readonly ApprovalView[]
  readonly respond: (id: string, approved: boolean) => Promise<void>
}

export function useApprovals(conversationId: ConversationId | undefined, enabled = true): ApprovalsHandle {
  const [pending, setPending] = useState<readonly ApprovalView[]>([])
  useEffect(() => {
    setPending([])
    if (conversationId === undefined || !enabled) return
    let active = true
    void invoke("approval.list", { conversationId }).then(items => {
      if (active) setPending(items)
    }).catch(() => {})
    const stop = subscribe("approval", payload => {
      if (payload.conversationId === conversationId && active) setPending(payload.pending)
    })
    return () => { active = false; stop() }
  }, [conversationId, enabled])
  const respond = useCallback(async (id: string, approved: boolean) => {
    if (enabled) await invoke("approval.respond", { id, approved })
  }, [enabled])
  return { pending: enabled ? pending : [], respond }
}
