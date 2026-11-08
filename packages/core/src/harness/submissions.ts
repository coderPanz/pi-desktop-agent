import type { Context } from "@earendil-works/chord"
import type { ConversationId, Cursor, Storage, SubmissionRecord } from "@earendil-works/pi-durable"
import type { InputSubmissionView } from "@pi/shared-types"

/** 只投影已持久化的记录；不从 live 文档猜终态，也不把原始 detail 对象发往界面。 */
export function materializeSubmission(record: SubmissionRecord): InputSubmissionView | undefined {
  if (record.type !== "input") return undefined
  const identity = {
    id: record.id,
    conversationId: record.conversationId,
    ...(record.entry === undefined ? {} : { entryId: record.entry }),
  }
  if (record.status !== "unanswered") return { ...identity, status: record.status }
  const message = typeof record.detail === "string" && record.detail.trim() !== ""
    ? record.detail
    : record.reason === "no_model"
      ? "未配置可用模型：请检查 ANTHROPIC_MODEL / ANTHROPIC_API_KEY，修改配置后重启应用。"
      : `本次输入未得到回答（${record.reason}）。`
  return { ...identity, status: "unanswered", reason: record.reason, message }
}

/** 写入类提交和未开始的排队输入不能遮住当前/最近已开始输入的结算结果。 */
export async function latestInputSubmission(
  storage: Storage,
  conversationId: ConversationId,
  context: Context,
): Promise<InputSubmissionView | undefined> {
  let cursor: Cursor | undefined
  let queued: InputSubmissionView | undefined
  do {
    const page = await storage.scanSubmissions({ conversationId, order: "descending" }, 50, cursor, context)
    for (const record of page.items) {
      const view = materializeSubmission(record)
      if (view === undefined) continue
      if (view.status !== "queued") return view
      queued ??= view
    }
    cursor = page.next
  } while (cursor !== undefined)
  return queued
}
