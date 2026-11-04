/**
 * 把 SDK 的会话视图转成 IPC 上传输的 `ViewSnapshot`。
 *
 * 为什么要转：渲染进程不能依赖 `pi-durable`，所以需要一个地方把 SDK 结构换成
 * `@pi/shared-types` 声明的形状。只做两件事：挑字段、丢掉不合法的值。
 *
 * 坏条目、坏文档一律跳过、不抛错——界面宁可少显示一条，也不能被旧数据打崩。
 */
import { isJsonObject } from "@pi/shared-types"
import type { JsonObject, ViewConversation, ViewEntry, ViewSnapshot } from "@pi/shared-types"
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable"

/** 主入口：把一份视图整体转一遍（会话信息 + 条目 + 文档）。 */
export function materializeView(view: ConversationView): ViewSnapshot {
  const conversation = materializeConversation(view)
  const entries: ViewEntry[] = []
  for (const entry of view.entries) {
    const projected = materializeEntry(entry)
    if (projected !== undefined) entries.push(projected)
  }
  return { conversation, entries, docs: materializeDocs(view.docs) }
}

/** 只留 id、分叉来源、归属，其余字段不往线上带。 */
function materializeConversation(view: ConversationView): ViewConversation {
  const record = view.conversation
  const id = record.id
  const parent = record.parent
  const owner = record.owner
  return {
    id,
    ...(parent === undefined
      ? {}
      : { parent: { conversationId: parent.conversationId, at: parent.at } }),
    ...(owner === undefined
      ? {}
      : { owner: { conversationId: owner.conversationId, taskId: owner.taskId } }),
  }
}

/** id 或 kind 不合法就丢掉这条；可选字段没有就不写。 */
function materializeEntry(entry: EntryRecord): ViewEntry | undefined {
  if (typeof entry.id !== "number" || typeof entry.kind !== "string") return undefined
  // SDK 存下来的 model 一定是数组，这里只挡明显不是数组的值
  const model = Array.isArray(entry.model) ? entry.model : undefined
  return {
    id: entry.id,
    conversationId: entry.conversationId,
    kind: entry.kind,
    ...(model === undefined ? {} : { model }),
    ...(entry.data === undefined ? {} : { data: entry.data }),
    ...(entry.head === undefined ? {} : { head: entry.head }),
    ...(entry.byTaskId === undefined ? {} : { byTaskId: entry.byTaskId }),
  }
}

/** 只留能当 JSON 对象用的文档，其余跳过。 */
function materializeDocs(docs: Readonly<Record<string, JsonObject>>): Readonly<Record<string, JsonObject>> {
  const result: Record<string, JsonObject> = {}
  for (const [kind, value] of Object.entries(docs)) {
    if (isJsonObject(value)) result[kind] = value
  }
  return result
}
