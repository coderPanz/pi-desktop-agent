/** 侧栏树的拼装是纯函数：嵌套、顺序、孤儿、成环都在这里收口。 */
import assert from "node:assert/strict"
import { test } from "node:test"

import type { ConversationSummary } from "@pi/shared-types"

import { conversationAncestors, conversationTree } from "../renderer/src/lib/conversationTree.ts"

function conversation(id: number, parentId?: number): ConversationSummary {
  return {
    id,
    parent: parentId === undefined ? undefined : { conversationId: parentId, at: 1 },
    busy: false,
    queued: 0,
    title: undefined,
    pinned: false,
    updatedAt: undefined,
  }
}

/** 展开成 [id, depth] 便于断言形状。 */
function flatten(nodes: ReturnType<typeof conversationTree>, depth = 0): readonly (readonly [number, number])[] {
  return nodes.flatMap(node => [[node.item.id, depth] as const, ...flatten(node.children, depth + 1)])
}

test("按 parent 拼成森林：根在前，子会话挂在父下面，顺序保持", () => {
  const tree = conversationTree([conversation(1), conversation(7, 1), conversation(8, 1), conversation(9, 7)])
  assert.deepEqual(flatten(tree), [[1, 0], [7, 1], [9, 2], [8, 1]])
})

test("父会话不在列表里时当作顶层，不丢会话", () => {
  const tree = conversationTree([conversation(7, 99)])
  assert.deepEqual(flatten(tree), [[7, 0]])
})

test("自己指向自己或数据成环也不会死循环", () => {
  assert.deepEqual(flatten(conversationTree([conversation(7, 7)])), [[7, 0]])
  const cycle = flatten(conversationTree([conversation(2, 3), conversation(3, 2)]))
  assert.deepEqual(cycle.map(([id]) => id).sort(), [2, 3])
  assert.equal(cycle.length, 2, "成环的会话各出现一次")
})

test("父链用于展开：从内向外，缺失/成环就停", () => {
  const items = [conversation(1), conversation(7, 1), conversation(9, 7)]
  assert.deepEqual(conversationAncestors(items, 9), [7, 1])
  assert.deepEqual(conversationAncestors(items, 1), [])
  assert.deepEqual(conversationAncestors(items, undefined), [])
  assert.deepEqual(conversationAncestors([conversation(2, 3), conversation(3, 2)], 2), [3])
})
