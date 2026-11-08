/**
 * 应用级状态：应用信息、宿主状态、会话列表。
 *
 * 与 `useConversation` 分工：那边是「某个会话的副本」，这里是「整个应用的外围信息」。
 * 两者都只调 `ipc.ts`，不直接碰 `window.pi`。
 */
import { useCallback, useEffect, useState } from "react"

import type {
  ApprovalView,
  ConversationId,
  ConversationSummary,
  HostInfo,
  HostStatus,
} from "@pi/shared-types"

import { invoke, subscribe } from "./ipc.ts"

export type HostState = {
  readonly info: HostInfo | undefined
  readonly status: HostStatus | undefined
  readonly conversations: readonly ConversationSummary[]
}

export type HostHandle = HostState & {
  /** 重新拉会话列表（新建/分叉/切换后调）。 */
  readonly refresh: () => Promise<void>
}

/** 应用级信息与状态；启动时拉一次，之后跟推送更新状态。 */
export function useHost(): HostHandle {
  const [info, setInfo] = useState<HostInfo | undefined>(undefined)
  const [status, setStatus] = useState<HostStatus | undefined>(undefined)
  const [conversations, setConversations] = useState<readonly ConversationSummary[]>([])

  useEffect(() => {
    void (async () => {
      const [hostInfo, hostStatus] = await Promise.all([
        invoke("app.info", {}),
        invoke("app.status", {}),
      ])
      setInfo(hostInfo)
      setStatus(hostStatus)
    })().catch(() => {
      // 主进程还没就绪：等推送或下次刷新。启动失败会在界面上以「启动中…」体现。
    })
  }, [])

  // 宿主状态变化（收尾前会推一条 scheduling: "closing"）。
  useEffect(() => subscribe("host.status", setStatus), [])

  const refresh = useCallback(async () => {
    setConversations(await invoke("conv.list", { limit: 50 }))
  }, [])

  useEffect(() => {
    void refresh().catch(() => {})
  }, [refresh])

  return { info, status, conversations, refresh }
}

export type ApprovalsHandle = {
  readonly pending: readonly ApprovalView[]
  /** 答复一条审批；失败时抛 `IpcCallError`。 */
  readonly respond: (id: string, approved: boolean) => Promise<void>
}

/**
 * 某个会话的待审批请求。
 *
 * 两条来源：进会话时拉一次全量（`approval.list`），之后跟 `approval` 推送。
 * 推送里的 `pending` 是全量而不是增量，所以直接替换即可。
 */
export function useApprovals(conversationId: ConversationId | undefined): ApprovalsHandle {
  const [pending, setPending] = useState<readonly ApprovalView[]>([])

  useEffect(() => {
    setPending([])
    if (conversationId === undefined) return

    let active = true
    void invoke("approval.list", { conversationId })
      .then((items) => {
        if (active) setPending(items)
      })
      .catch(() => {})

    const stop = subscribe("approval", (payload) => {
      if (payload.conversationId !== conversationId) return
      setPending(payload.pending)
    })

    return () => {
      active = false
      stop()
    }
  }, [conversationId])

  const respond = useCallback(async (id: string, approved: boolean) => {
    await invoke("approval.respond", { id, approved })
  }, [])

  return { pending, respond }
}
