import type { ConversationId, ConversationSummary } from "@pi/shared-types"

import { conversationTree } from "../lib/conversationTree.ts"
import type { ConversationNode } from "../lib/conversationTree.ts"
import { ConversationRow } from "./ConversationRow.tsx"
import type { ConversationRowActions } from "./ConversationRow.tsx"

export type ConversationTreeProps = {
  readonly items: readonly ConversationSummary[]
  readonly selected: ConversationId | undefined
  readonly collapsed: ReadonlySet<ConversationId>
  readonly actions: ConversationRowActions
  /** 算相对时间的「现在」，由侧栏统一走动后传进来。 */
  readonly now: number
}

/** 侧栏会话树：扁平列表按 `parent.conversationId` 拼成森林后逐层画，折叠状态由调用方持有。 */
export function ConversationTree({ items, selected, collapsed, actions, now }: ConversationTreeProps) {
  return (
    <>
      {conversationTree(items).map(node => (
        <Branch key={node.item.id} node={node} depth={0} selected={selected} collapsed={collapsed} actions={actions} now={now} />
      ))}
    </>
  )
}

type BranchProps = {
  readonly node: ConversationNode
  readonly depth: number
  readonly selected: ConversationId | undefined
  readonly collapsed: ReadonlySet<ConversationId>
  readonly actions: ConversationRowActions
  readonly now: number
}

function Branch({ node, depth, selected, collapsed, actions, now }: BranchProps) {
  const { item, children } = node
  const folded = collapsed.has(item.id)

  return (
    <>
      <ConversationRow
        item={item}
        active={item.id === selected}
        deletable={!item.busy}
        deleteBlockedReason={item.busy ? "运行中不能删" : undefined}
        depth={depth}
        branch={children.length === 0 ? undefined : { collapsed: folded }}
        actions={actions}
        now={now}
      />
      {folded
        ? null
        : children.map(child => (
            <Branch key={child.item.id} node={child} depth={depth + 1} selected={selected} collapsed={collapsed} actions={actions} now={now} />
          ))}
    </>
  )
}
