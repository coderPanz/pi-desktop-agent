/**
 * 侧栏的树：会话本来就是一个森林（根会话 + 从某条消息分叉出来的子会话），
 * `parent.conversationId` 就是边。这里只把扁平列表拼成嵌套结构，不改任何数据。
 *
 * 纯函数，不依赖 React：边界（父会话不在列表里、成环）都在这里收掉，
 * 递归组件只管画。
 */
import type { ConversationId, ConversationSummary } from "@pi/shared-types"

export type ConversationNode = {
  readonly item: ConversationSummary
  readonly children: readonly ConversationNode[]
}

/** 扁平列表 → 森林。父会话不在列表（被删/被移除）或自己指向自己时，当作顶层，别把会话弄丢。 */
export function conversationTree(items: readonly ConversationSummary[]): readonly ConversationNode[] {
  const ids = new Set(items.map(item => item.id))
  const parents = new Map<ConversationId, ConversationSummary[]>()
  const roots: ConversationSummary[] = []

  for (const item of items) {
    const parentId = item.parent?.conversationId
    if (parentId === undefined || parentId === item.id || !ids.has(parentId)) {
      roots.push(item)
      continue
    }
    const siblings = parents.get(parentId)
    if (siblings === undefined) parents.set(parentId, [item])
    else siblings.push(item)
  }

  const visited = new Set<ConversationId>()
  const build = (item: ConversationSummary): ConversationNode => {
    visited.add(item.id)
    const children = (parents.get(item.id) ?? []).filter(child => !visited.has(child.id))
    return { item, children: children.map(build) }
  }

  const nodes = roots.map(build)
  // 兜底：数据损坏成环（A 的父是 B、B 的父是 A）时没有根，这些会话也要显示出来
  for (const item of items) {
    if (!visited.has(item.id)) nodes.push(build(item))
  }
  return nodes
}

/** 从顶层到 `id` 的父链（不含自己，顺序由内向外）；用来保证选中的会话始终展开可见。 */
export function conversationAncestors(
  items: readonly ConversationSummary[],
  id: ConversationId | undefined,
): readonly ConversationId[] {
  if (id === undefined) return []
  const byId = new Map(items.map(item => [item.id, item]))
  const ancestors: ConversationId[] = []
  const seen = new Set<ConversationId>([id])
  let current: ConversationSummary | undefined = byId.get(id)
  while (current?.parent !== undefined) {
    const parentId = current.parent.conversationId
    if (seen.has(parentId)) break
    seen.add(parentId)
    ancestors.push(parentId)
    current = byId.get(parentId)
  }
  return ancestors
}
