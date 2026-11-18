import { useState } from "react"

import type { ConversationId, ConversationSummary } from "@pi/shared-types"

import { Icon } from "./Icon.tsx"

export type ConversationRowActions = {
  readonly select: (id: ConversationId) => void
  readonly delete: (id: ConversationId) => void
  /** 折叠/展开子会话；没有子会话的行不会调它。 */
  readonly toggle: (id: ConversationId) => void
}

/** 有子会话时给出，`collapsed` 决定箭头方向。 */
export type ConversationBranch = { readonly collapsed: boolean }

export type ConversationRowProps = {
  readonly item: ConversationSummary
  readonly active: boolean
  /** 正在运行的会话与根会话不给删除入口：中断归「停止」，根会话是界面兜底。 */
  readonly deletable: boolean
  /** 层级，0 为顶层；只影响缩进。 */
  readonly depth: number
  readonly branch: ConversationBranch | undefined
  readonly actions: ConversationRowActions
}

/** 树的每一行：折叠箭头 + 选中区 + 删除区并列（按钮不能嵌套），删除走二次确认。 */
export function ConversationRow({ item, active, deletable, depth, branch, actions }: ConversationRowProps) {
  const [confirming, setConfirming] = useState(false)

  return (
    <div className={`group flex items-start gap-0.5 rounded-lg ${INDENT[depth] ?? INDENT[INDENT.length - 1]} ${active ? "bg-selection" : "hover:bg-hover"}`}>
      {branch === undefined ? (
        <span className="w-5 shrink-0" aria-hidden="true" />
      ) : (
        <button
          aria-label={`${branch.collapsed ? "展开" : "折叠"}会话 #${item.id} 的子会话`}
          aria-expanded={!branch.collapsed}
          className="mt-2.5 flex size-5 shrink-0 items-center justify-center rounded text-tertiary hover:bg-hover hover:text-primary"
          onClick={() => actions.toggle(item.id)}
        >
          <Icon name="chevron" className={`size-3 transition-transform ${branch.collapsed ? "" : "rotate-90"}`} />
        </button>
      )}

      {confirming ? (
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 py-2.5 pr-3">
          <span className="truncate text-[12px] text-secondary">删除 #{item.id}？</span>
          <button
            className="rounded-md bg-danger-soft px-2 py-1 text-[12px] font-medium text-danger hover:bg-danger/15"
            title="从库里彻底删除，不可恢复"
            onClick={() => {
              setConfirming(false)
              actions.delete(item.id)
            }}
          >
            删除
          </button>
          <button
            className="rounded-md px-2 py-1 text-[12px] text-secondary hover:bg-hover hover:text-primary"
            onClick={() => setConfirming(false)}
          >
            取消
          </button>
        </div>
      ) : (
        <>
          <button
            data-conversation-id={item.id}
            data-depth={depth}
            aria-pressed={active}
            title={hintOf(item)}
            className={`flex min-w-0 flex-1 items-start gap-2.5 py-2.5 pr-1 text-left ${active ? "text-accent" : "text-secondary"}`}
            onClick={() => actions.select(item.id)}
          >
            {/* 图标表示「这一条自己是不是分叉」，子会话由左侧箭头表示 */}
            <Icon name={item.parent === undefined ? "message" : "branch"} className="mt-0.5" />
            <span className="min-w-0 flex-1">
              {/* 显示会话标题（第一条用户消息 / 它的摘要）；完整 id 与分叉来源挂在 title 提示上 */}
              <span className="block truncate text-[13px] font-medium">
                {item.title ?? `会话 #${item.id}`}
              </span>
              {item.busy || item.queued > 0 ? (
                <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-secondary">
                  {item.busy ? <span>忙</span> : null}
                  {item.queued > 0 ? <span>排队 {item.queued}</span> : null}
                </span>
              ) : null}
            </span>
          </button>
          {/* 悬停/键盘聚焦时才出现，平时不占视觉份量。 */}
          {deletable ? (
            <button
              aria-label={`删除会话 #${item.id}`}
              title="删除会话（不可恢复）"
              className="mt-1 mr-1 rounded-md p-1.5 text-tertiary opacity-0 group-hover:opacity-100 hover:bg-danger-soft hover:text-danger focus-visible:opacity-100"
              onClick={() => setConfirming(true)}
            >
              <Icon name="trash" className="size-3.5" />
            </button>
          ) : null}
        </>
      )}
    </div>
  )
}

/** 悬浮提示：标题之外还想知道它是第几号、从哪儿分叉的。 */
function hintOf(item: ConversationSummary): string {
  return [
    `会话 #${item.id}`,
    item.parent === undefined ? undefined : `从会话 #${item.parent.conversationId} 分叉`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ")
}

/** 每层缩进 12px 的固定档位：类名必须是字面量，Tailwind 才扫得到。 */
const INDENT = ["pl-2", "pl-5", "pl-8", "pl-11", "pl-14", "pl-16"] as const
