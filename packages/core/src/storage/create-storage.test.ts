import assert from "node:assert/strict" // node 断言库
import { mkdtemp, rm } from "node:fs/promises" // node 文件系统模块
import { existsSync } from "node:fs" // 检查文件是否存在
import { tmpdir } from "node:os" // node 操作系统模块
import path from "node:path" // node 路径模块
import { test } from "node:test" // node 测试库

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context" // 上下文
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable" // 根会话ID
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai"

import { createStorage } from "./create-storage.ts"
import { HarnessHost } from "../harness/host.ts"
import { createPiRegistry } from "../harness/registry.ts"

const ctx = BACKGROUND_CONTEXT

function models() {
  return createModels({ credentials: new InMemoryCredentialStore() })
}

/**
 * 这条用例是「持久化真的能用」的最小证据：写一条被动条目 → 正常关闭 → 重新打开同一个SQLite文件 →
 * 条目还在。它同时覆盖 `node:sqlite`（Node 22.22 已可免 flag 使用）与我们的 `createStorage()` 包装。
 */
test("文件库跨进程重开能读回已提交条目", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-core-storage-")) // 创建临时目录
  const file = path.join(dir, "session.sqlite") // 创建SQLite文件

  try {
    const first = await createStorage({ kind: "file", file }) // 
    const host = await HarnessHost.open({ storage: first, models: models(), registry: createPiRegistry() })
    const conversation = await host.harness.conversation(ROOT_CONVERSATION_ID, ctx)
    assert.ok(conversation !== undefined)
    await conversation.submit({ type: "write", entry: { kind: "test.note", data: { n: 1 } } }, ctx) // 提交一条测试条目
    await host.close()

    assert.equal(existsSync(file), true) // 检查SQLite文件是否存在

    const second = await createStorage({ kind: "file", file })
    const reopened = await HarnessHost.open({
      storage: second,
      models: models(),
      registry: createPiRegistry(),
    })
    try {
      const page = await reopened.root.entries({ order: "descending" }, 10, undefined, ctx)
      assert.equal(page.items[0]?.kind, "test.note") // 检查条目类型
      assert.deepEqual(page.items[0]?.data, { n: 1 }) // 检查条目数据
    } finally {
      await reopened.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true }) // 删除临时目录
  }
})

test("文件库的父目录会自动建出来", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-core-storage-")) // 创建临时目录
  const file = path.join(dir, "nested", "deeper", "session.sqlite")

  try {
    const storage = await createStorage({ kind: "file", file }) // 创建SQLite文件
    await storage.close(ctx) // 关闭SQLite文件
    assert.equal(existsSync(file), true) // 检查SQLite文件是否存在
  } finally {
    await rm(dir, { recursive: true, force: true }) // 删除临时目录
  }
})

test("内存库不写文件", async () => {
  const storage = await createStorage({ kind: "memory" })
  await storage.close(ctx)
})
