/**
 * 侧栏的时间节点：距今多久。
 * 规则按参考控件来：1 分钟内「刚刚」，然后分钟 / 小时 / 天，超过一周换成日期（跨年才补年份）。
 */
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function relativeTime(at: number | undefined, now: number): string | undefined {
  if (at === undefined) return undefined
  // 时钟回拨或写入比读取还晚：按「刚刚」处理，不显示负数
  const diff = Math.max(0, now - at)
  if (diff < MINUTE) return "刚刚"
  if (diff < HOUR) return `${String(Math.floor(diff / MINUTE))}分钟前`
  if (diff < DAY) return `${String(Math.floor(diff / HOUR))}小时前`
  if (diff < 7 * DAY) return `${String(Math.floor(diff / DAY))}天前`
  const date = new Date(at)
  const stamp = `${String(date.getMonth() + 1)}月${String(date.getDate())}日`
  return date.getFullYear() === new Date(now).getFullYear()
    ? stamp
    : `${String(date.getFullYear())}年${stamp}`
}
