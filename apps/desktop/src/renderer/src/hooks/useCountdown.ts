/**
 * 倒计时：给「N 秒后自动重试」用。
 *
 * 只在这一处按秒走字；没有目标时间就不跑定时器，避免空闲时每秒重渲染。
 */
import { useEffect, useState } from "react"

/** 返回距 `at` 还有几秒（向上取整，最小 0）；`at` 为空或已过返回 undefined。 */
export function useCountdownAt(at: number | undefined): number | undefined {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (at === undefined) return
    setNow(Date.now())
    const timer = setInterval(() => {
      const current = Date.now()
      setNow(current)
      if (current >= at) clearInterval(timer)
    }, 1000)
    return () => clearInterval(timer)
  }, [at])

  if (at === undefined) return undefined
  const remaining = Math.ceil((at - now) / 1000)
  return remaining > 0 ? remaining : 0
}