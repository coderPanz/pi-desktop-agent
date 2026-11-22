import { useEffect, useRef } from "react"
import { createPortal } from "react-dom"

/** 卡片宽度与「翻到上方」用的估算高度。 */
const WIDTH = 296
const HEIGHT = 168
const GAP = 10

export type ConversationDeleteCardProps = {
  /** 要删除的那一行的位置（视口坐标）：卡片贴在它右侧，箭头指向这一行。 */
  readonly anchor: DOMRect
  readonly onCancel: () => void
  readonly onConfirm: () => void
}

/**
 * 删除确认浮层：贴着那一行出现，说清楚「删了就没了」，再给 取消 / 删除。
 * 和「…」菜单一样走 `createPortal` + `fixed`：侧栏的 `backdrop-blur` 会给 fixed 后代造包含块，
 * 留在行内定位会被整体偏移；挂在 body 上也不会被滚动容器裁掉。
 */
export function ConversationDeleteCard({ anchor, onCancel, onConfirm }: ConversationDeleteCardProps) {
  const ref = useRef<HTMLDivElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)

  // 点外面 / 按 Esc 取消；列表滚动与窗口缩放时位置会失效，也直接收起
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && (ref.current?.contains(target) ?? false)) return
      onCancel()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel()
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    document.addEventListener("keydown", onKeyDown)
    window.addEventListener("scroll", onCancel, true)
    window.addEventListener("resize", onCancel)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true)
      document.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("scroll", onCancel, true)
      window.removeEventListener("resize", onCancel)
    }
  }, [onCancel])

  // 默认焦点给「取消」：手一抖按回车不会真删
  useEffect(() => {
    cancelButton.current?.focus()
  }, [])

  const spaceRight = window.innerWidth - anchor.right - GAP - 8
  const flipLeft = spaceRight < WIDTH
  const left = flipLeft ? Math.max(8, anchor.left - WIDTH - GAP) : anchor.right + GAP
  const top = Math.max(8, Math.min(anchor.top - 8, window.innerHeight - HEIGHT - 8))

  return createPortal(
    <div
      ref={ref}
      role="alertdialog"
      aria-label="确认删除会话"
      style={{ top, left, width: WIDTH }}
      className="fixed z-50 rounded-2xl border border-divider bg-surface p-4 shadow-control"
    >
      {/* 指向那一行的小箭头：贴着卡片左（或被翻到左侧时的右）边缘 */}
      <span
        aria-hidden="true"
        style={flipLeft ? { right: -5.5, top: 18 } : { left: -5.5, top: 18 }}
        className={`absolute size-2.5 rotate-45 border-divider bg-surface ${flipLeft ? "border-t border-r" : "border-b border-l"}`}
      />
      <p className="text-[14px] font-semibold text-primary">删除该会话？</p>
      <p className="mt-2 text-[12.5px] leading-6 text-secondary">
        删除后，这个会话的聊天记录会从本机数据里一并清除，且无法恢复。
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <button
          ref={cancelButton}
          type="button"
          className="rounded-lg border border-control-border bg-surface px-3.5 py-1.5 text-[12px] font-medium text-primary hover:bg-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          onClick={onCancel}
        >
          取消
        </button>
        <button
          type="button"
          className="rounded-lg bg-danger px-3.5 py-1.5 text-[12px] font-medium text-white hover:bg-danger/88 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger"
          onClick={onConfirm}
        >
          删除
        </button>
      </div>
    </div>,
    document.body,
  )
}
