import assert from "node:assert/strict"
import { test } from "node:test"

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { MemoryStorage, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable"
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai"

import { inspectHarness } from "./inspect.ts"
import { HarnessHost } from "../harness/host.ts"
import { createPiRegistry, summarizeRegistry } from "../harness/registry.ts"

const ctx = BACKGROUND_CONTEXT

async function openHost(): Promise<HarnessHost> {
  const models = createModels({ credentials: new InMemoryCredentialStore() })
  return await HarnessHost.open({ storage: new MemoryStorage(), models, registry: createPiRegistry() })
}

test("空闲时摘要为 0 任务，且不含条目内容", async () => {
  const host = await openHost()
  try {
    const conversation = await host.harness.conversation(ROOT_CONVERSATION_ID, ctx)
    assert.ok(conversation !== undefined)
    await conversation.submit(
      { type: "write", entry: { kind: "test.note", data: { secret: "不该出现在诊断里" } } },
      ctx,
    )

    const summary = await inspectHarness(host.harness, ctx)
    assert.equal(summary.scheduling, "running")
    assert.equal(summary.counts.tasks, 0)
    assert.equal(summary.counts.running, 0)
    // inspect() 只看未结算的提交：已经 done 的被动写不会出现在这里。
    assert.equal(summary.counts.submissions, 0)
    assert.deepEqual(summary.submissions, [])

    // 脱敏：摘要里不该出现条目数据。
    assert.equal(JSON.stringify(summary).includes("不该出现在诊断里"), false)
  } finally {
    await host.close()
  }
})

test("注册表摘要只列名字", async () => {
  const registry = createPiRegistry()
  const summary = summarizeRegistry(registry.snapshot())

  assert.deepEqual(summary.extensions, [])
  assert.deepEqual(summary.tools, [])
  // 内置任务存在，但它们是框架的实现细节，这里只确认是字符串。
  assert.ok(summary.tasks.every((name) => typeof name === "string"))
})
