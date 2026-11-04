/**
 * 审批中枢：等答复、超时、取消、文档镜像。
 *
 * 用真 Harness + 内存库：审批要落 `app.approvals`，这是它唯一的持久副作用。
 */
import assert from "node:assert/strict"
import { test } from "node:test"

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { Models } from "@earendil-works/pi-ai"
import type { ConversationId } from "@earendil-works/pi-durable"
import { AppApprovalsDoc } from "@pi/shared-docs"
import type { ApprovalView } from "@pi/shared-types"

import { ApprovalBroker } from "./broker.ts"
import { createPiRegistry } from "../harness/registry.ts"
import { HarnessHost } from "../harness/host.ts"
import { createStorage } from "../storage/create-storage.ts"

/** 这些用例不调模型：`Harness.open` 只需 `getAuth` 存在（它要 bind 一下）。 */
const NO_MODELS = { getAuth: () => undefined } as unknown as Models

async function openHarness(): Promise<{ host: HarnessHost; conversationId: ConversationId }> {
  const storage = await createStorage({ kind: "memory" })
  const host = await HarnessHost.open({
    storage,
    registry: createPiRegistry(),
    models: NO_MODELS,
  })
  const conversation = await host.harness.createConversation(
    { ownership: { kind: "ownerless" } },
    BACKGROUND_CONTEXT,
  )
  return { host, conversationId: conversation.id }
}

const REQUEST = {
  tool: "bash",
  summary: "bash: mkdir -p demo",
  conversationId: 1,
  callId: "call-1",
}

/** 读到文档里的 pending（审批的审计镜像）。 */
async function storedPending(
  brokerHost: HarnessHost,
  conversationId: ConversationId,
): Promise<readonly { id: string }[]> {
  const doc = await brokerHost.harness.snapshot(
    AppApprovalsDoc,
    conversationId,
    BACKGROUND_CONTEXT,
  )
  return doc?.pending ?? []
}

test("请求进来先落一片 pending，答复后清空并记下 latest", async () => {
  const { host, conversationId } = await openHarness()
  const pushed: ApprovalView[][] = []
  const broker = new ApprovalBroker({
    harness: host.harness,
    onChange: (_id, pending) => pushed.push([...pending]),
  })

  const pending = broker.request(
    { ...REQUEST, conversationId: conversationId as number },
    { signal: undefined },
  )

  // 入队即刻可查：界面收到推送就点按钮，不能扑空。
  const listed = await broker.list(conversationId as number)
  assert.equal(listed.length, 1)
  assert.equal(listed[0]?.summary, REQUEST.summary)
  assert.equal(listed[0]?.conversationId, conversationId)

  const decision = broker.respond(listed[0]!.id, true)
  assert.equal(decision, "approved")
  assert.equal(await pending, true)
  assert.deepEqual(await broker.list(conversationId as number), [])

  const doc = await host.harness.snapshot(AppApprovalsDoc, conversationId, BACKGROUND_CONTEXT)
  assert.equal(doc?.pending.length, 0)
  assert.equal(doc?.latest?.decision, "approved")
  assert.ok(pushed.length >= 2, "推送至少要覆盖新增与清除两次")

  await host.close()
})

test("拒绝按拒绝结算", async () => {
  const { host, conversationId } = await openHarness()
  const broker = new ApprovalBroker({ harness: host.harness, onChange: () => {} })

  const pending = broker.request({ ...REQUEST, conversationId: conversationId as number }, { signal: undefined })
  const [first] = await broker.list(conversationId as number)
  broker.respond(first!.id, false)

  assert.equal(await pending, false)
  await host.close()
})

test("超时按拒绝结算，pending 不残留", async () => {
  const { host, conversationId } = await openHarness()
  const broker = new ApprovalBroker({
    harness: host.harness,
    onChange: () => {},
    timeoutMs: 20,
  })

  const answered = broker.request({ ...REQUEST, conversationId: conversationId as number }, { signal: undefined })
  assert.equal(await answered, false)
  assert.deepEqual(await broker.list(conversationId as number), [])
  assert.equal((await storedPending(host, conversationId)).length, 0)

  await host.close()
})

test("会话被取消时立刻结算，不留挂起", async () => {
  const { host, conversationId } = await openHarness()
  const broker = new ApprovalBroker({ harness: host.harness, onChange: () => {} })

  const controller = new AbortController()
  const answered = broker.request({ ...REQUEST, conversationId: conversationId as number }, { signal: controller.signal })
  assert.equal((await broker.list(conversationId as number)).length, 1)

  controller.abort()
  assert.equal(await answered, false)
  assert.deepEqual(await broker.list(conversationId as number), [])

  await host.close()
})

test("已经取消的信号不再登记", async () => {
  const { host, conversationId } = await openHarness()
  const broker = new ApprovalBroker({ harness: host.harness, onChange: () => {} })

  const controller = new AbortController()
  controller.abort()
  assert.equal(await broker.request({ ...REQUEST, conversationId: conversationId as number }, { signal: controller.signal }), false)
  assert.deepEqual(await broker.list(conversationId as number), [])

  await host.close()
})

test("回答不存在的请求返回 expired，不抛错", async () => {
  const { host } = await openHarness()
  const broker = new ApprovalBroker({ harness: host.harness, onChange: () => {} })
  assert.equal(broker.respond("nope", true), "expired")
  await host.close()
})

test("closeAll 把所有挂起的请求结算掉", async () => {
  const { host, conversationId } = await openHarness()
  const broker = new ApprovalBroker({ harness: host.harness, onChange: () => {} })

  const first = broker.request({ ...REQUEST, conversationId: conversationId as number }, { signal: undefined })
  const second = broker.request(
    { ...REQUEST, conversationId: conversationId as number, callId: "call-2" },
    { signal: undefined },
  )
  broker.closeAll()

  assert.equal(await first, false)
  assert.equal(await second, false)
  assert.deepEqual(await broker.list(conversationId as number), [])
  await host.close()
})

test("list 清理残留：清掉崩溃后没人等的 pending", async () => {
  const { host, conversationId } = await openHarness()
  const broker = new ApprovalBroker({ harness: host.harness, onChange: () => {} })

  // 模拟上一次进程崩溃：文档里留着一条已经没人在等答复的请求。
  await host.harness.commit(async (tx) => {
    const doc = await tx.doc(AppApprovalsDoc, conversationId)
    doc.pending = [
      { id: "ghost", callId: "c", tool: "bash", summary: "bash: 上次没答完", createdAt: 1 },
    ]
  }, BACKGROUND_CONTEXT)

  assert.equal((await storedPending(host, conversationId)).length, 1)
  assert.deepEqual(await broker.list(conversationId as number), [])
  assert.equal((await storedPending(host, conversationId)).length, 0, "重启前残留的审批应被清掉")

  await host.close()
})
