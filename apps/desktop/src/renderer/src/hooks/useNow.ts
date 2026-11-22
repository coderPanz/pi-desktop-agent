import { useEffect, useState } from "react"

/**
 * 走动的「现在」：相对时间（刚刚 / 5分钟前）得跟着时间自己变。
 * 30 秒一跳够用，也不用每秒把整棵树重渲染一遍。
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, intervalMs)
    return () => { clearInterval(timer) }
  }, [intervalMs])
  return now
}
