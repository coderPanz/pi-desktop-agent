/**
 * 流式进场的节奏控制：三件事
 *
 * 1. 开闸：模型是「一大段一大段」吐字的，这里按固定节拍摊平——每 32ms 推进一次、一步最多 6 个字，
 *    文字是一条线往下走，而不是一坨一坨蹦出来（晃眼主要来自后者）。
 * 2. 限速：基准 34 字/秒，积压按 600ms 时间常数追上。显示最多落后模型 0.3 秒左右的量，
 *    突发的一大段被摊到半秒里陆续出现，也不会越积越多、在结尾一次性冲出来。
 * 3. 落定：按 520ms 节拍推进「已落定」边界（大于动画 400ms + 最大错开 48ms），
 *    摘掉动画类时一定已经播完，看不出跳变。
 *
 * 三个数字都在这几行里，嫌快嫌慢直接调它们。
 */
import { useCallback, useEffect, useRef, useState } from "react"

import type { StreamReveal } from "../lib/streamReveal.ts"

const TICK = 32
const REVEAL_CPS = 34
const CATCHUP_TAU = 600
const MAX_STEP = 6
const SETTLE_INTERVAL = 520
const STAGGER = 12
const MAX_STAGGER = 48

export type StreamRevealState = {
  /** 已经揭示的字符数：调用方只画 `text.slice(0, shown)`。 */
  readonly shown: number
  readonly reveal: StreamReveal
}

export function useStreamReveal(text: string): StreamRevealState {
  const [shown, setShown] = useState(0)
  /** 已落定的字符数：小于它的文本不再播动画。 */
  const [settledBefore, setSettledBefore] = useState(0)
  /** 目标文本长度（模型已经给到的量）。 */
  const target = useRef(text.length)
  /** 揭示进度（浮点，按字节算步长才不会卡在 0）。 */
  const revealed = useRef(0)
  /** 揭示进度的整数镜像：落定节拍读它。 */
  const rendered = useRef(0)
  /** 上一次落定节拍时的揭示长度，下一次节拍拿它当边界。 */
  const lastTick = useRef(0)
  /** 上一帧文本，用来判断是不是换了一轮输出。 */
  const previous = useRef(text)
  /** 每个词第一次进场的延迟：同一个偏移永远同一份延迟，重渲染不会改动画进度。 */
  const delays = useRef(new Map<number, number>())
  const settled = useRef(0)
  const plan = useRef({ boundary: -1, count: 0 })

  settled.current = settledBefore

  useEffect(() => {
    target.current = text.length
    if (!text.startsWith(previous.current)) {
      // 换了一轮输出（新回答 / 消息被换掉）：整段重新进场
      revealed.current = 0
      rendered.current = 0
      lastTick.current = 0
      delays.current.clear()
      plan.current = { boundary: -1, count: 0 }
      setShown(0)
      setSettledBefore(0)
    }
    previous.current = text
  }, [text])

  // 开闸 + 限速：只推进字符数，文本由调用方切片
  useEffect(() => {
    let last = performance.now()
    const timer = setInterval(() => {
      const now = performance.now()
      // 后台标签页回来时 dt 会很大，夹住，避免一帧冲进一大段
      const dt = Math.min(now - last, TICK * 3)
      last = now
      const goal = target.current
      const current = revealed.current
      if (current >= goal) return
      const backlog = goal - current
      const step = Math.min(MAX_STEP, Math.max((dt * REVEAL_CPS) / 1000, (backlog * dt) / CATCHUP_TAU))
      const next = Math.min(goal, current + step)
      revealed.current = next
      const whole = Math.floor(next)
      if (whole <= rendered.current) return
      rendered.current = whole
      setShown(whole)
    }, TICK)
    return () => clearInterval(timer)
  }, [])

  // 落定：用「上一节拍时的揭示长度」当边界，保证每个词至少带一个完整节拍的动画
  useEffect(() => {
    const timer = setInterval(() => {
      const boundary = lastTick.current
      lastTick.current = rendered.current
      // 已经落定的词不会再被查到延迟，顺手清掉，长时间输出也不涨内存
      if (boundary > 0) for (const start of delays.current.keys()) if (start < boundary) delays.current.delete(start)
      setSettledBefore(current => (boundary > current ? boundary : current))
    }, SETTLE_INTERVAL)
    return () => clearInterval(timer)
  }, [])

  const delayFor = useCallback((start: number) => {
    const known = delays.current.get(start)
    if (known !== undefined) return known
    if (plan.current.boundary !== settled.current) plan.current = { boundary: settled.current, count: 0 }
    const delay = Math.min(plan.current.count * STAGGER, MAX_STAGGER)
    plan.current = { boundary: plan.current.boundary, count: plan.current.count + 1 }
    delays.current.set(start, delay)
    return delay
  }, [])

  return { shown, reveal: { settledBefore, delayFor } }
}
