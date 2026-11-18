/**
 * 物理删除会话： sdk 没有提供 api 直接原生实现
 */
import type { SqliteExecutor } from "@earendil-works/chord/sqlite"
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node"

import { UserError } from "../errors.ts"
import type { StorageTarget } from "./create-storage.ts"

/** 删掉了多少行；日志与用例看它。 */
export type PurgeReport = {
  readonly entries: number
  readonly tasks: number
  readonly submissions: number
  readonly documents: number
  readonly documentRevisions: number
  readonly conversations: number
}

/** 一次会话物理删除；不支持的存储（内存库）没有这个能力。 */
export type ConversationPurge = (conversationId: number) => Promise<PurgeReport>

/** 默认前缀下的表名。改名等于和 SDK 的 schema 脱钩，升级 pi-durable 时要回来对一遍。 */
const TABLE = {
  metadata: "durable_metadata",
  recordIds: "record_ids",
  conversations: "conversations",
  entries: "entries",
  tasks: "tasks",
  submissions: "submissions",
  documents: "documents",
  documentRevisions: "document_revisions",
} as const

/** 该会话名下的文档：会话作用域的直接归属 + 它任务作用域的。 */
const OWN_DOCUMENTS = `(${TABLE.documents}.scope_kind = 'conversation' AND ${TABLE.documents}.owner_id = ?)
  OR (${TABLE.documents}.scope_kind = 'task' AND ${TABLE.documents}.owner_id IN (
    SELECT id FROM ${TABLE.tasks} WHERE conversation_id = ?
  ))`

/** 文件库才有物理删除；内存库（测试、`--memory`）返回 undefined，调用方退回「从列表移除」。 */
export function  createConversationPurge(target: StorageTarget): ConversationPurge | undefined {
  if (target.kind !== "file") return undefined
  const file = target.file

  return async (conversationId: number) => {
    const database = await openNodeSqliteDatabase(file, { busyTimeoutMs: 5_000 })
    try {
      return await database.transaction(async tx => {
        // 子会话保护-有问完成的任务禁止删除
        await assertDeletable(tx, conversationId)
        const report = await count(tx, conversationId)
        await remove(tx, conversationId)
        return report
      })
    } finally {
      await database.close()
    }
  }
}

/** 保护：有子会话、未结束的任务、未结算的提交，一律不做。 */
async function assertDeletable(tx: SqliteExecutor, conversationId: number): Promise<void> {
  const forked = await tx.get<{ id: number }>(
    `SELECT id FROM ${TABLE.conversations}
     WHERE json_extract(record, '$.parent.conversationId') = ? LIMIT 1`,
    conversationId,
  )
  if (forked !== undefined) throw new UserError(`会话 #${String(conversationId)} 被会话 #${String(forked.id)} 分叉，先删子会话。`)
  
  const owned = await tx.get<{ id: number }>(
    `SELECT id FROM ${TABLE.conversations}
     WHERE owner_conversation_id = ?
        OR owner_task_id IN (SELECT id FROM ${TABLE.tasks} WHERE conversation_id = ?)
     LIMIT 1`,
    conversationId,
    conversationId,
  )
  if (owned !== undefined) throw new UserError(`会话 #${String(conversationId)} 还有子会话 #${String(owned.id)}，先删子会话。`)
  
  const running = await tx.get<{ id: number }>(
    `SELECT id FROM ${TABLE.tasks} WHERE conversation_id = ? AND status <> 'terminal' LIMIT 1`,
    conversationId,
  )
  if (running !== undefined) {
    throw new UserError(`会话 #${String(conversationId)} 还有未结束的任务，先停止再删除。`)
  }

  const queued = await tx.get<{ id: number }>(
    `SELECT id FROM ${TABLE.submissions}
     WHERE conversation_id = ? AND status IN ('queued', 'placed') LIMIT 1`,
    conversationId,
  )
  if (queued !== undefined) {
    throw new UserError(`会话 #${String(conversationId)} 还有排队中的提交，先处理再删除。`)
  }
}

async function count(tx: SqliteExecutor, conversationId: number): Promise<PurgeReport> {
  const one = async (sql: string, ...params: readonly number[]): Promise<number> => {
    const row = await tx.get<{ n: number }>(sql, ...params)
    return row?.n ?? 0
  }
  return {
    entries: await one(`SELECT COUNT(*) AS n FROM ${TABLE.entries} WHERE conversation_id = ?`, conversationId),
    tasks: await one(`SELECT COUNT(*) AS n FROM ${TABLE.tasks} WHERE conversation_id = ?`, conversationId),
    submissions: await one(`SELECT COUNT(*) AS n FROM ${TABLE.submissions} WHERE conversation_id = ?`, conversationId),
    documents: await one(`SELECT COUNT(*) AS n FROM ${TABLE.documents} WHERE ${OWN_DOCUMENTS}`, conversationId, conversationId),
    documentRevisions: await one(
      `SELECT COUNT(*) AS n FROM ${TABLE.documentRevisions} WHERE document_id IN (
         SELECT id FROM ${TABLE.documents} WHERE ${OWN_DOCUMENTS})`,
      conversationId,
      conversationId,
    ),
    conversations: await one(`SELECT COUNT(*) AS n FROM ${TABLE.conversations} WHERE id = ?`, conversationId),
  }
}

/** 级联删除。先登记表、再文档版本、最后数据行：每条都靠仍在的前提行做子查询。 */
async function remove(tx: SqliteExecutor, conversationId: number): Promise<void> {
  await tx.run(
    `DELETE FROM ${TABLE.recordIds} WHERE
       (record_type = 'conversation' AND id = ?)
       OR (record_type = 'entry' AND id IN (SELECT id FROM ${TABLE.entries} WHERE conversation_id = ?))
       OR (record_type = 'task' AND id IN (SELECT id FROM ${TABLE.tasks} WHERE conversation_id = ?))
       OR (record_type = 'submission' AND id IN (SELECT id FROM ${TABLE.submissions} WHERE conversation_id = ?))
       OR (record_type = 'document' AND id IN (SELECT id FROM ${TABLE.documents} WHERE ${OWN_DOCUMENTS}))`,
    conversationId,
    conversationId,
    conversationId,
    conversationId,
    conversationId,
    conversationId,
  )
  await tx.run(
    `DELETE FROM ${TABLE.documentRevisions} WHERE document_id IN (
       SELECT id FROM ${TABLE.documents} WHERE ${OWN_DOCUMENTS})`,
    conversationId,
    conversationId,
  )
  await tx.run(`DELETE FROM ${TABLE.documents} WHERE ${OWN_DOCUMENTS}`, conversationId, conversationId)
  await tx.run(`DELETE FROM ${TABLE.submissions} WHERE conversation_id = ?`, conversationId)
  await tx.run(`DELETE FROM ${TABLE.tasks} WHERE conversation_id = ?`, conversationId)
  await tx.run(`DELETE FROM ${TABLE.entries} WHERE conversation_id = ?`, conversationId)
  await tx.run(`DELETE FROM ${TABLE.conversations} WHERE id = ?`, conversationId)
}
