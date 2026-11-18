type IconName = "sparkles" | "message" | "plus" | "branch" | "compress" | "reset" | "arrow-up" | "stop" | "check" | "chevron" | "tool" | "shield" | "alert" | "model" | "refresh" | "trash"

const PATHS: Record<IconName, string> = {
  sparkles: "M13 3l2.5 6.5L22 12l-6.5 2.5L13 21l-2.5-6.5L4 12l6.5-2.5L13 3z M4 3v4M2 5h4 M21 18v4M19 20h4",
  message: "M20 11.5a7.5 7.5 0 01-7.5 7.5H8l-5 3v-6a7.5 7.5 0 01-1-4.5A7.5 7.5 0 019.5 4H13a7.5 7.5 0 017 7.5z M7 10h8 M7 14h5",
  plus: "M12 5v14 M5 12h14",
  branch: "M6 6v12 M6 12h8a4 4 0 004-4V6 M4 3h4v4H4z M4 17h4v4H4z M16 3h4v4h-4z",
  compress: "M4 3v5h5 M20 3v5h-5 M4 21v-5h5 M20 21v-5h-5 M4 8l5-5 M20 8l-5-5 M4 16l5 5 M20 16l-5 5",
  reset: "M4 10a8 8 0 111 8 M4 4v6h6",
  "arrow-up": "M12 19V5 M6 11l6-6 6 6",
  stop: "M6 6h12v12H6z",
  check: "M5 12l4 4L19 6",
  chevron: "M9 5l7 7-7 7",
  tool: "M4 5h16v14H4z M7 9l3 3-3 3 M13 15h4",
  shield: "M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3z M8 12l3 3 5-6",
  alert: "M12 3L2 21h20L12 3z M12 9v5 M12 17v.5",
  model: "M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z M4 7.5l8 4.5 8-4.5 M12 12v9",
  refresh: "M20 10a8 8 0 00-14-5L3 8 M3 3v5h5 M4 14a8 8 0 0014 5l3-3 M21 21v-5h-5",
  trash: "M4 7h16 M10 4h4v3h-4z M6.5 7l1 13h9l1-13 M10 11v5 M14 11v5",
}

/** 本地描边图标，不引入字体或远程资源；可交互控件的名称由外层文字/aria-label 提供。 */
export function Icon({ name, className = "" }: { readonly name: IconName; readonly className?: string }) {
  return (
    <svg className={`size-4 shrink-0 ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  )
}
