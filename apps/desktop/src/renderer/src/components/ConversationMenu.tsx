import { useEffect, useRef } from "react"
import { createPortal } from "react-dom"

import { Icon } from "./Icon.tsx"

/** 菜单宽度与「底部空间不够就翻上去」的估算高度：三项 + 内边距。 */
const WIDTH = 156
const HEIGHT = 116
const GAP = 6

export type ConversationMenuProps = {
  /** 触发按钮的位置（视口坐标）：菜单贴在它右下方。 */
  readonly anchor: DOMRect
  readonly pinned: boolean
  /** 运行中的会话与根会话不给删除入口。 */
  readonly deletable: boolean
  readonly onDelete: () => void
  readonly onPin: () => void
  readonly onRename: () => void
  readonly onClose: () => void
}

/**
 * 会话行右侧「…」的下拉菜单：删除 / 置顶 / 重命名。
 *
 * 用 fixed 定位而不是行内 absolute：列表是可滚动的 `overflow-y-auto`，
 * 行内绝对定位的菜单会在列表底部被裁掉。代价是它不会跟着滚动，所以滚动/缩放时直接收起。
 */
export function ConversationMenu({ anchor, pinned, deletable, onDelete, onPin, onRename, onClose }: ConversationMenuProps) {
  const ref = useRef<HTMLDivElement>(null)

  // 点外面、按 Esc、列表滚动、窗口缩放：收起（fixed 定位不跟随滚动）
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      // 触发按钮自己负责开关，交给它的 onClick
      if (target instanceof Element && target.closest("[data-conversation-menu]") !== null) return
      if (target instanceof Node && (ref.current?.contains(target) ?? false)) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    document.addEventListener("keydown", onKeyDown)
    window.addEventListener("scroll", onClose, true)
    window.addEventListener("resize", onClose)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true)
      document.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("scroll", onClose, true)
      window.removeEventListener("resize", onClose)
    }
  }, [onClose])

  // 以「…」自己为锚：左边缘对齐按钮左边缘、紧贴按钮下沿；右边/下边越界就往反方向挪
  const top = anchor.bottom + GAP + HEIGHT > window.innerHeight ? Math.max(8, anchor.top - HEIGHT - GAP) : anchor.bottom + GAP
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - WIDTH - 8))

  // 渲染到 body：侧栏带 backdrop-blur，会给 fixed 后代造一个新的包含块，
  // 留在行内定位会被一起偏移，于是菜单就“飞”到离按钮很远的地方。
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="会话操作"
      style={{ top, left, width: WIDTH }}
      className="fixed z-50 rounded-xl border border-divider bg-surface/97 p-1 shadow-control backdrop-blur-xl"
    >
      <Item
        icon="trash"
        label="删除"
        danger
        disabled={!deletable}
        hint={deletable ? "从库里彻底删除，不可恢复" : "运行中的会话与根会话不能删除"}
        onClick={onDelete}
      />
      <Item
        icon="pin"
        label={pinned ? "取消置顶" : "置顶"}
        hint={pinned ? "取消后按活跃时间排" : "排到「最近」最前面"}
        onClick={onPin}
      />
      <Item icon="pencil" label="重命名" hint="改侧栏显示的名字" onClick={onRename} />
    </div>,
    document.body,
  )
}

function Item(props: {
  readonly icon: "trash" | "pin" | "pencil"
  readonly label: string
  readonly hint: string
  readonly danger?: boolean
  readonly disabled?: boolean
  readonly onClick: () => void
}) {
  return (
    <button
      role="menuitem"
      type="button"
      disabled={props.disabled ?? false}
      title={props.hint}
      className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] ${props.danger === true ? "text-danger" : "text-secondary"} ${props.disabled === true ? "opacity-40" : "hover:bg-hover hover:text-primary"}`}
      onClick={props.onClick}
    >
      <Icon name={props.icon} className="size-3.5" />
      {props.label}
    </button>
  )
}
