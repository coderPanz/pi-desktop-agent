/**
 * 把某个会话的主进程副本搬成 React 状态，：`conv.open` 起手，之后逐帧叠加，跳号就 resync 重建。
 *
 * 帧的判定顺序：`convId` 不符丢弃 → `seq <= 当前` 丢弃（重复/旧帧）→ `seq` 跳号则重连 →
 * `isBase(ops)` 整帧重建，否则增量应用。
 */
import { useCallback, useEffect, useRef, useState } from "react"

import { applyImmutable, isBase } from "@pi/shared-types"
import type { ConversationId, OpenedView, ViewSnapshot } from "@pi/shared-types"

import { invoke, subscribe } from "./ipc.ts"

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
  status: "idle",
  convId: undefined,
  seq: -1,
  snapshot: undefined,
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
  /**
   * 会话轮次号：`conversationId` 每变一次就 +1（含首次挂载），`open()` 与帧回调都带着出发时的号，
   * 号对不上就说明是上一轮会话的迟到结果，丢弃。
   * resync 不 +1：它要的正是同一轮的最新副本。
   */
  const generation = useRef(0)
  /** 同一时刻只允许一次重连：跳号触发的那次 conv.open 没回来之前，不再发第二次 */
  const resyncing = useRef(false)

  // 当前会话 id
  const currentId = useRef<ConversationId | undefined>(undefined)

  // open 是「拉一次完整副本并（如果轮次没变）用它整体替换本地状态」——首次挂载和 resync 都用它，区别只在 resync 标志是否给 resyncs 计数
  const open = useCallback(
    // gen 是 generation 的缩写，含义是「这一轮 effect 出发时的轮次号」
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
   *
   * - 同一时刻只允许一次（`resyncing`）：并发重开会让响应乱序，`seq` 可能被改回去，进而反复跳号；
   * - 轮次号沿用 `generation.current`（不 +1）：这次结果就该生效；
   * - 失败只记 `error`，旧副本仍能看，不白屏。
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
