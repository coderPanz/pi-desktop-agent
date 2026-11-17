/**
 * 把某个会话的主进程副本搬成 React 状态，：`conv.open` 起始，之后逐帧叠加，跳号就 resync 重建
 *
 * 帧的判定顺序：`convId` 不符丢弃 → `seq <= 当前` 丢弃（重复/旧帧）→ `seq` 跳号则重连 →
 * `isBase(ops)` 整帧重建，否则增量应用。
 * 跳号：帧序号不连续， 主进程 FrameHub 为每个会话维护一个单调递增的计数器（packages/core/src/frames/frame-hub.ts）所以渲染层手里是两条信息：「副本长这样」+「它是第几号」。之后每来一帧，编号应该恰好是上一号 + 1 —— 因为主进程是严格按顺序 +1 发出去的
 * 为什么会丢帧：
 * 1. open 与 subscribe 之间的时间窗：主进程在 open() 里 materializeView(watch.value) 取快照、响应 IPC；这个往  
    返期间会话可能又变了，那些帧已经 #publish 出去了，但渲染进程的 "view" 监听还没挂上 → 丢。
 2. 推送通道不可靠：addSink(frame => options.publish("view", frame)) → webContents.send。窗口在后台被节流、渲 
    染进程忙、send 失败，都可能丢。
 3. 重连竞态：resync 期间的旧响应与新帧交错。
 */
import { useCallback, useEffect, useRef, useState } from "react"
// 「把一批 op 应用到旧值上，返回新值，绝不改旧值」**函数-它是 useConversation 里唯一改动 snapshot 的手段
import { applyImmutable, isBase } from "@pi/shared-types"
import type { ConversationId, OpenedView, ViewSnapshot } from "@pi/shared-types"

import { invoke, subscribe } from "../ipc.ts"

export type ConversationState = {
  readonly status: "idle" | "loading" | "ready" | "error"
  readonly convId: ConversationId | undefined
  readonly seq: number
  readonly snapshot: ViewSnapshot | undefined
  /** 跳号触发过的重连次数：自测 seq 连续性看它。 */
  readonly resyncs: number
  /** 丢弃的重复/旧帧数。 */
  readonly stale: number
  readonly error: string | undefined
}

const EMPTY: ConversationState = {
  status: "idle", // 会话忙碌状态
  convId: undefined, // 会话 id
  seq: -1, // 会话帧序号
  snapshot: undefined, // 会话快照
  resyncs: 0,
  stale: 0,
  error: undefined,
}

export type ConversationHandle = ConversationState & {
  /** 重新拉一次副本（界面上的「重连」按钮用它）。 */
  readonly resync: () => void
}


export function useConversation(conversationId: ConversationId | undefined): ConversationHandle {
  /**
   * 会话状态
   * {
   *   status: "idle" | "loading" | "ready" | "error"
   *   convId: ConversationId | undefined
   *   seq: number
   *   snapshot: ViewSnapshot | undefined
   *   resyncs: number
   *   stale: number
   *   error: string | undefined
   * }
   */
  const [state, setState] = useState<ConversationState>(EMPTY)
  // 会话轮次号
  const generation = useRef(0)
  /** 是否正在重连的：同一时刻只允许一次重连 */
  const resyncing = useRef(false)

  // 当前会话 id
  const currentId = useRef<ConversationId | undefined>(undefined)

  /** 
   * open 是「拉一次完整副本并（如果轮次没变）用它整体替换本地状态」
   * open 被放进了 useEffect 的依赖数组，而依赖是按引用比较的——不包裹就会变成每次渲染都重订阅、无限循环调    
 conv.open
   */
  const open = useCallback(
    async (id: ConversationId, gen: number, resync: boolean) => {
      /**
       * 调用主进程的 conv.open 接口，获取会话的起点
       * OpenedView: {
       *   convId: ConversationId // convId = 这份副本/这一帧属于哪个会话的编号
       *   seq: number // seq = 这份副本/这一帧的序号
       *   snapshot: ViewSnapshot // snapshot = 这份副本/这一帧的快照
       * }
       */
      const opened: OpenedView = await invoke("conv.open", {
        conversationId: id,
      })
      if (gen !== generation.current) return
      setState(prev => ({
        status: "ready",
        convId: opened.convId,
        seq: opened.seq,
        snapshot: opened.snapshot,
        resyncs: resync ? prev.resyncs + 1 : prev.resyncs,
        stale: prev.stale,
        error: undefined,
      }))
    },
    [],
  )

  /**
   * 跳号后的重连：重新 `conv.open`，用新副本整体顶掉本地状态
   */
  const resyncNow = useCallback(() => {
    const id = currentId.current
    // 没会话可重连 / 已经有一次在路上：都不再发
    if (id === undefined || resyncing.current) return
    resyncing.current = true
    void open(id, generation.current, true)
      .catch((error: unknown) => {
        setState(prev => ({ ...prev, error: errorText(error) }))
      })
      .finally(() => {
        resyncing.current = false
      })
  }, [open])

  useEffect(() => {
    // 轮次号 +1
    generation.current += 1
    const gen = generation.current
    // 更新当前会话 id
    currentId.current = conversationId

    if (conversationId === undefined) {
      setState(EMPTY)
      return
    }

    setState({ ...EMPTY, status: "loading", convId: conversationId })
    // 调用 open 拉一次完整副本并（如果轮次没变）用它整体替换本地状态
    void open(conversationId, gen, false).catch((error: unknown) => {
      if (gen !== generation.current) return
      setState(prev => ({ ...prev, status: "error", error: errorText(error) }))
    })

    // 订阅帧回调
    return subscribe("view", frame => {
      // 轮次号不符：丢弃上一次会话迟到的副本
      if (gen !== generation.current) return
      setState(prev => {
        // 快照不存在：丢弃
        if (prev.snapshot === undefined) return prev
        // 帧 id 不符：丢弃
        if (frame.convId !== conversationId) return prev
        // 帧序号小于等于当前序号：丢弃
        if (frame.seq <= prev.seq) return { ...prev, stale: prev.stale + 1 }
        // 帧序号不等于当前序号 + 1：跳号
        if (frame.seq !== prev.seq + 1) {
          // 跳号：副本已经不可信，交给 resync 重建（不能就地猜）。
          // 推到微任务里：`resyncNow` 会 setState，不能在 updater 里直接改 state。
          queueMicrotask(resyncNow)
          return { ...prev, stale: prev.stale + 1 }
        }
        // 增量应用
        const next = isBase(frame.ops)
          ? applyImmutable<ViewSnapshot | undefined>(undefined, frame.ops)
          : applyImmutable(prev.snapshot, frame.ops)
        return { ...prev, seq: frame.seq, snapshot: next }
      })
    })
  }, [conversationId, open, resyncNow])

  return { ...state, resync: resyncNow }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
