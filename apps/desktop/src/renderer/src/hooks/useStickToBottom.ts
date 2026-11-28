/**
 * 会话区的「贴着底部」行为：用户已经在底部就跟随新内容，往上翻了就一动不动，「回到最新」按钮负责回去。
 *
 * 为什么用 ResizeObserver 而不是「props 变了就滚」：流式文本是逐帧揭示的（推进在 StreamingMarkdown 内部），
 * 消息列表自己的 props ~100ms 才变一次；只有监听内容盒子高度，才能在每个新行落下时都跟上。
 *
 * 两条阈值（滞回）：离开底部只要超过 16px 就算走开，回到 64px 以内才重新跟随——
 * 避免贴着底部边缘时因为一行高度差在「跟随 / 不跟随」之间来回抖。
 */
import { useCallback, useEffect, useRef, useState } from "react"

const LEAVE_PX = 16
const ENTER_PX = 64

export type StickToBottom = {
  /** 滚动容器（`overflow-y-auto`）。 */
  readonly scroller: React.RefObject<HTMLDivElement | null>
  /** 会不断变高的内容盒子。 */
  readonly content: React.RefObject<HTMLDivElement | null>
  /** 此刻是否贴着底部；false 时显示「回到最新」。 */
  readonly stuck: boolean
  readonly onScroll: () => void
  /** 强制回到最新并恢复跟随：「回到最新」按钮、自己发消息、切会话都用它。 */
  readonly follow: () => void
  /** 只在贴底时重新贴一次：内容结构变化（流式节点换成正式条目）不会触发 ResizeObserver 时用它兜底。 */
  readonly nudge: () => void
}

export function useStickToBottom(resetKey: unknown): StickToBottom {
  const scroller = useRef<HTMLDivElement | null>(null)
  const content = useRef<HTMLDivElement | null>(null)
  const [stuck, setStuck] = useState(true)
  /** 滚动回调与 ResizeObserver 都要立刻读到，所以用 ref 镜像，不靠 state。 */
  const sticking = useRef(true)
  /** 上一次由程序贴底后的 scrollTop；用来区分「内容变高」与「用户自己滚走」。 */
  const pinnedTop = useRef<number | null>(null)

  const pin = useCallback(() => {
    const el = scroller.current
    if (el === null) return
    el.scrollTop = el.scrollHeight
    pinnedTop.current = el.scrollTop
  }, [])

  const follow = useCallback(() => {
    sticking.current = true
    setStuck(true)
    pin()
  }, [pin])

  const onScroll = useCallback(() => {
    const el = scroller.current
    if (el === null) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    const next = sticking.current ? distance <= LEAVE_PX : distance <= ENTER_PX
    sticking.current = next
    setStuck(current => (current === next ? current : next))
  }, [])

  // 内容变高就跟随；已经走开的不动。
  // 判据不是「现在离底部多远」（内容一长就不近了），而是「scrollTop 有没有被用户改过」：
  // 内容增长只改 scrollHeight，不动 scrollTop；用户滚动才会改 scrollTop。
  useEffect(() => {
    const el = scroller.current
    const inner = content.current
    if (el === null || inner === null) return
    const observer = new ResizeObserver(() => {
      if (!sticking.current) return
      const pinned = pinnedTop.current
      if (pinned !== null && Math.abs(el.scrollTop - pinned) > 1) return
      pin()
    })
    observer.observe(inner)
    // 窗口高度变化会改变可视区，同样需要重新贴底
    observer.observe(el)
    pin()
    return () => observer.disconnect()
  }, [pin])

  // 往上滚的意图立刻生效：不等下一帧被「贴回底部」，否则鼠标慢慢拖也会被拽回去
  useEffect(() => {
    const el = scroller.current
    if (el === null) return
    const onWheel = (event: WheelEvent): void => {
      if (event.deltaY >= 0 || el.scrollTop <= 0) return
      sticking.current = false
      setStuck(false)
    }
    el.addEventListener("wheel", onWheel, { passive: true })
    return () => el.removeEventListener("wheel", onWheel)
  }, [])

  // 换会话：重新贴底（滚动容器的 scrollTop 会被复用，不重置会停在上一个会话的位置）
  useEffect(() => {
    follow()
  }, [resetKey, follow])

  const nudge = useCallback(() => {
    if (sticking.current) pin()
  }, [pin])

  return { scroller, content, stuck, onScroll, follow, nudge }
}
