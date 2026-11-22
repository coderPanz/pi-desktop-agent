/**
 * 助手头像：取 `docs/UI 优化.md` 里的图标，做成「浅灰圆形底 + 深色标记」。
 * 图标是 32×32 的像素稿（深色块面即标记，白色即标记外的留白）：
 * 这里按像素边界描成一条外轮廓 + 方孔 + 右下方块（evenodd 挖孔），
 * 不用逐块矩形拼，避免相邻块之间出现抗锯齿白缝；标记留出边距，不顶到圆边。
 */
const MARK = "M0 0h24v16h-8v8h-8v8h-8zM8 8h8v8h-8zM24 16h8v16h-8z"

/** 尺寸由调用方给（className），头像本身只管浅灰圆底 + 标记（比画布白一阶，不糊在背景里）。 */
export function AssistantAvatar({ className = "" }: { readonly className?: string }) {
  return (
    <span className={`flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-avatar ${className}`}>
      <svg viewBox="0 0 32 32" aria-hidden="true" className="size-[58%]">
        <path d={MARK} fill="#111111" fillRule="evenodd" />
      </svg>
    </span>
  )
}
