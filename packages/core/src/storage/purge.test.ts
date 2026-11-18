/**
 * 物理删除会话：SDK 的 `Storage` 没有删除接口，`createConversationPurge` 直接对 SQLite 文件做级联删除。
 * 这里用真文件库（内存库没有 SQL 后端）逐条验：删得干净、保护条件生效、id 与 seq 不被重用。
 */
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { Models } from "@earendil-works/pi-ai"
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable"
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node"

import { HarnessHost } from "../harness/host.ts"
import { createPiRegistry } from "../harness/registry.ts"
import { SessionManager } from "../session/manager.ts"
import { createStorage } from "./create-storage.ts"
import { createConversationPurge } from "./purge.ts"

/** 这些用例不调模型：`Harness.open` 只需 `getAuth` 存在。 */
const NO_MODELS = { getAuth: () => undefined } as unknown as Models
const ctx = BACKGROUND_CONTEXT

type Fixture = {
  readonly manager: SessionManager
  readonly host: HarnessHost
  readonly file: string
  readonly close: () => Promise<void>
}

async function fixture(): Promise<Fixture> {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-purge-"))
  const target = { kind: "file", file: path.join(dir, "purge.sqlite") } as const
  const storage = await createStorage(target)
  const host = await HarnessHost.open({ storage, registry: createPiRegistry(), models: NO_MODELS })
  const manager = await SessionManager.open({ harness: host.harness, storage, purge: createConversationPurge(target) })
  return {
    manager,
    host,
    file: target.file,
    close: async () => {
      await manager.closeWatches()
      await host.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/** 直接读库核对残留（这是唯一能「看见行没了」的方式）。 */
async function rows(file: string, sql: string, ...params: readonly number[]): Promise<readonly Record<string, unknown>[]> {
  const database = await openNodeSqliteDatabase(file)
  try {
    return await database.all(sql, ...params)
  } finally {
    await database.close()
  }
}

async function count(file: string, table: string, where: string, ...params: readonly number[]): Promise<number> {
  const rowsRead = await rows(file, `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...params)
  return Number(rowsRead[0]?.["n"] ?? 0)
}

/** 记一条笔记：`type: "write"` 只写条目，不问模型。 */
async function appendNote(host: HarnessHost, conversationId: number): Promise<void> {
  const conversation = await host.harness.conversation(conversationId as never, ctx)
  assert.ok(conversation !== undefined)
  await conversation.submit({ type: "write", entry: { kind: "test.note", data: { n: 1 } } }, ctx)
}

test("物理删除：会话、条目、任务、文档与登记行一起消失，之后按 id 打不开", async () => {
  const { manager, host, file, close } = await fixture()
  try {
    const created = await manager.create(ctx)
    await appendNote(host, created.id)

    assert.equal(await count(file, "conversations", "id = ?", created.id), 1)
    assert.ok((await count(file, "entries", "conversation_id = ?", created.id)) > 0, "应有条目")
    assert.ok((await count(file, "documents", "scope_kind = 'conversation' AND owner_id = ?", created.id)) > 0, "应有会话文档")

    await manager.delete(created.id, ctx)

    assert.equal(await count(file, "conversations", "id = ?", created.id), 0)
    assert.equal(await count(file, "entries", "conversation_id = ?", created.id), 0)
    assert.equal(await count(file, "tasks", "conversation_id = ?", created.id), 0)
    assert.equal(await count(file, "submissions", "conversation_id = ?", created.id), 0)
    assert.equal(await count(file, "documents", "scope_kind = 'conversation' AND owner_id = ?", created.id), 0)
    const revisions = await rows(
      file,
      "SELECT COUNT(*) AS n FROM document_revisions WHERE document_id NOT IN (SELECT id FROM documents)",
    )
    assert.equal(Number(revisions[0]?.["n"] ?? 0), 0, "文档版本不能留下孤儿")
    const records = await rows(file, "SELECT COUNT(*) AS n FROM record_ids WHERE id = ?", created.id)
    assert.equal(Number(records[0]?.["n"] ?? 0), 0, "登记行也要删，否则 id 的归属记录一直留着")

    assert.equal(await host.harness.conversation(created.id, ctx), undefined, "库里已经查不到这个会话")
    assert.ok(!(await manager.list(ctx)).some(item => item.id === created.id), "列表里也不再有它")
  } finally {
    await close()
  }
})

test("有未结束的任务时拒绝删除", async () => {
  const { manager, file, close } = await fixture()
  try {
    const created = await manager.create(ctx)
    // 没有模型的情况下造不出一轮真实生成，这里直接插一行 running 任务来验保护条件
    const database = await openNodeSqliteDatabase(file)
    try {
      await database.run(
        `INSERT INTO tasks (id, conversation_id, kind, status, abort_requested, background, record)
         VALUES (90001, ?, 'test', 'running', 0, 0, '{}')`,
        created.id,
      )
    } finally {
      await database.close()
    }

    await assert.rejects(() => manager.delete(created.id, ctx), /未结束的任务/u)
    assert.equal(await count(file, "conversations", "id = ?", created.id), 1, "拒绝时一行都不能删")
  } finally {
    await close()
  }
})

test("根会话与有分叉子会话的会话都不能删；子会话删掉后父会话可以删", async () => {
  const { manager, host, file, close } = await fixture()
  try {
    await assert.rejects(() => manager.delete(ROOT_CONVERSATION_ID, ctx), /根会话/u)

    const parent = await manager.create(ctx)
    await appendNote(host, parent.id)
    await manager.select(parent.id, ctx)
    const child = await manager.fork(ctx, undefined, {})

    await assert.rejects(() => manager.delete(parent.id, ctx), /先删子会话/u)
    assert.equal(await count(file, "conversations", "id = ?", parent.id), 1)

    await manager.delete(child.id, ctx)
    await manager.delete(parent.id, ctx)
    assert.equal(await count(file, "conversations", "id = ?", parent.id), 0)
    assert.equal(await count(file, "conversations", "id = ?", child.id), 0)
  } finally {
    await close()
  }
})

test("删掉最大的会话也不会让 id 被重用、seq 回退", async () => {
  const { manager, file, close } = await fixture()
  try {
    const first = await manager.create(ctx)
    const second = await manager.create(ctx)
    assert.ok(second.id > first.id)

    // 计数器在删除前后必须一样：删行不能让 id 被重用、seq 回退
    const before = await rows(file, "SELECT next_id, next_seq FROM durable_metadata")
    await manager.delete(second.id, ctx)

    const after = await rows(file, "SELECT next_id, next_seq FROM durable_metadata")
    assert.deepEqual({ ...after[0] }, { ...before[0] }, "计数器一行都不能碰")

    const third = await manager.create(ctx)
    assert.ok(third.id > second.id, `新会话的 id 必须继续增大：${String(third.id)} > ${String(second.id)}`)
  } finally {
    await close()
  }
})
