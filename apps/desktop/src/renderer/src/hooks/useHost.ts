/**
 * 应用级状态：应用信息、宿主状态、会话列表。
 * 与 `useConversation` 分工：那边是「某个会话的副本」，这里是「整个应用的外围信息」
 */
import { useCallback, useEffect, useState } from "react"

import type {
  ApprovalView,
  ConversationId,
  ConversationSummary,
  HostInfo,
  HostStatus,
} from "@pi/shared-types"

import { invoke, subscribe } from "../ipc.ts"

export type HostState = {
  readonly info: HostInfo | undefined
  readonly status: HostStatus | undefined
  readonly conversations: readonly ConversationSummary[]
  /** 会话列表是否已经拉到过一次：起始会话的选择要等它，否则「空列表」和「还没拉」分不开。 */
  readonly loaded: boolean
}

export type HostHandle = HostState & {
  /** 重新拉会话列表（新建/分叉/切换后调）。 */
  readonly refresh: () => Promise<void>
}

/** 应用级信息与状态；启动时拉一次，之后跟推送更新状态。 */
export function useHost(): HostHandle {
  const [info, setInfo] = useState<HostInfo | undefined>(undefined) // 应用和环境信息
  const [status, setStatus] = useState<HostStatus | undefined>(undefined) // harness 整体运行状态
  const [conversations, setConversations] = useState<
    readonly ConversationSummary[]
  >([]) // 当前的会话
  const [loaded, setLoaded] = useState(false) // 会话列表是否拉到过一次

  // 组件挂载时，拉取应用信息和状态
  useEffect(() => {
    void (async () => {
      const [hostInfo, hostStatus] = await Promise.all([
        invoke("app.info", {}),
        invoke("app.status", {}),
      ])
      setInfo(hostInfo)
      setStatus(hostStatus)
    })().catch(() => {})
  }, [])

  /**
   * 订阅 harness 调度器状态，用于实时在界面上反馈：ipcRenderer.on(channel, handler)
   */
  useEffect(() => subscribe("host.status", setStatus), [])

  /** 后台摘要好了：把列表里那一行换掉，不重拉整份列表。 */
  useEffect(
    () =>
      subscribe("conv.title", payload => {
        setConversations(current =>
          current.map(item =>
            item.id === payload.conversationId ? { ...item, title: payload.title } : item,
          ),
        )
      }),
    [],
  )

  /**
   * useCallback 稳定函数引用：避免每次渲染时都重新创建新的函数，提高性能
   * 这里是为了避免无限循环
   * 如果不包：refresh 执行后，由于下方的 useEffect 依赖了 refresh，导致 useEffect 执行
   * 从而再次触发 refresh 重新执行，引用发生变化，又导致 useEffect 执行，无限循环
   */
  const refresh = useCallback(async () => {
    // 获取会话列表
    setConversations(await invoke("conv.list", { limit: 50 }))
    setLoaded(true)
  }, [])

  useEffect(() => {
    void refresh().catch(() => {})
  }, [refresh])

  return { info, status, conversations, loaded, refresh }
}

export type ApprovalsHandle = {
  readonly pending: readonly ApprovalView[]
  /** 答复一条审批  */
  readonly respond: (id: string, approved: boolean) => Promise<void>
}

/**
 * 某个会话的待审批请求
 */
export function useApprovals(
  conversationId: ConversationId | undefined, // 会话 id
): ApprovalsHandle {
  const [pending, setPending] = useState<readonly ApprovalView[]>([]) // 待审批的请求

  useEffect(() => {
    setPending([]) // 清空待审批的请求
    if (conversationId === undefined) return

    let active = true
    // 获取当前会话的所有待审的请求
    void invoke("approval.list", { conversationId })
      .then(items => {
        if (active) setPending(items)
      })
      .catch(() => {})

    // 渲染进程监听 approval 命令，并执行 handler，更新审批状态
    const stop = subscribe("approval", payload => {
      if (payload.conversationId !== conversationId) return
      setPending(payload.pending)
    })

    return () => {
      active = false
      stop()
    }
  }, [conversationId])

  // 获取用户的审批答复
  const respond = useCallback(async (id: string, approved: boolean) => {
    await invoke("approval.respond", { id, approved })
  }, [])

  return { pending, respond }
}
