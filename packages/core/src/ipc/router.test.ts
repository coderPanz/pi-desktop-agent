/**
 * IPC 路由：每通道落到真 Harness 上，重点验三件事——
 * 帧 seq 连续、错误码不糊、入参当不可信。
 */
import assert from "node:assert/strict"
import { test } from "node:test"

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { Models } from "@earendil-works/pi-ai"
import type { ConversationId } from "@earendil-works/pi-durable"
import { AppWorkspaceDoc } from "@pi/shared-docs"
import type { HostInfo, ViewFrame } from "@pi/shared-types"

import { ApprovalBroker } from "../approvals/broker.ts"
import { FrameHub } from "../frames/frame-hub.ts"
import { HarnessHost } from "../harness/host.ts"
import { createPiRegistry } from "../harness/registry.ts"
import { SessionManager } from "../session/manager.ts"
import { createStorage } from "../storage/create-storage.ts"
import { IpcRouter } from "./router.ts"

/** 这些用例不调模型：`Harness.open` 只需 `getAuth` 存在。 */
const NO_MODELS = { getAuth: () => undefined } as unknown as Models

const INFO: HostInfo = {
  appVersion: "0.0.0-test",
  electron: undefined,
  node: process.versions.node,
  chrome: undefined,
  platform: process.platform,
  dataDir: "/tmp/pi-test",
  rootConversationId: 1,
  model: undefined,
}

type Fixture = {
  readonly router: IpcRouter
  readonly host: HarnessHost
  readonly hub: FrameHub
  readonly frames: ViewFrame[]
}

async function fixture(): Promise<Fixture> {
  const storage = await createStorage({ kind: "memory" })
  const host = await HarnessHost.open({
    storage,
    registry: createPiRegistry(),
    models: NO_MODELS,
  })
  const manager = await SessionManager.open({ harness: host.harness, storage })
  const frames: ViewFrame[] = []
  const hub = new FrameHub(host.harness)
  hub.addSink((frame) => frames.push(frame))
  const approvals = new ApprovalBroker({ harness: host.harness, onChange: () => {} })
  const router = new IpcRouter({
    harness: host.harness,
    manager,
    hub,
    approvals,
    info: INFO,
  })
  return { router, host, hub, frames }
}

/** 取成功值；失败就让断言把错误码打出来。 */
function valueOf(
  result: { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } },
): unknown {
  assert.equal(result.ok, true, result.ok ? "" : `${result.error.code}: ${result.error.message}`)
  return result.ok ? result.value : undefined
}

test("app.info 原样返回主进程给的信息", async () => {
  const { router, host } = await fixture()
  const result = await router.handle("app.info", {})
  assert.deepEqual(valueOf(result), INFO)
  await host.close()
})

test("app.status 给出调度与计数", async () => {
  const { router, host } = await fixture()
  const result = await router.handle("app.status", {})
  const status = valueOf(result) as { scheduling: string; tasks: number; submissions: number }
  assert.equal(status.scheduling, "running")
  assert.equal(typeof status.tasks, "number")
  assert.equal(typeof status.submissions, "number")
  await host.close()
})

test("conv.create 建会话，conv.list 能列到", async () => {
  const { router, host } = await fixture()
  const created = valueOf(await router.handle("conv.create", {})) as { conversationId: number }
  assert.ok(created.conversationId > 0)

  const listed = valueOf(await router.handle("conv.list", { limit: 10 })) as readonly {
    id: number
  }[]
  assert.ok(
    listed.some((item) => item.id === created.conversationId),
    "新建的会话应在列表里",
  )
  await host.close()
})

test("conv.open 返回副本与起始帧号，之后每帧 +1", async () => {
  const { router, host, frames } = await fixture()
  const created = valueOf(await router.handle("conv.create", {})) as { conversationId: number }
  const id = created.conversationId

  const opened = valueOf(await router.handle("conv.open", { conversationId: id })) as {
    convId: number
    seq: number
    snapshot: { entries: readonly unknown[] }
  }
  assert.equal(opened.convId, id)
  assert.equal(opened.seq, 0, "首帧编号从 0 开始")
  assert.equal(opened.snapshot.entries.length, 0)

  // 写一条条目（reset 会落一条 pi.reset），应当推来 seq = 1。
  const conversation = await host.harness.conversation(id as ConversationId, BACKGROUND_CONTEXT)
  await conversation!.reset(undefined, BACKGROUND_CONTEXT)

  assert.equal(frames.length, 1, "应收到一帧")
  const frame = frames[0]!
  assert.equal(frame.convId, id)
  assert.equal(frame.seq, 1)
  assert.ok(frame.ops.length > 0)

  // 再打开同一个会话：不重放历史，给的是当前副本和当前序号。
  const reopened = valueOf(await router.handle("conv.open", { conversationId: id })) as {
    seq: number
    snapshot: { entries: readonly unknown[] }
  }
  assert.equal(reopened.seq, 1, "重复 open 不能把序号打回 0")
  assert.equal(reopened.snapshot.entries.length, 1, "历史已经在副本里，靠帧补会重复")

  await host.close()
})

test("conv.open 未知会话是 NOT_FOUND", async () => {
  const { router, host } = await fixture()
  const result = await router.handle("conv.open", { conversationId: 999 })
  assert.equal(result.ok, false)
  assert.equal(result.ok ? "" : result.error.code, "NOT_FOUND")
  await host.close()
})

test("入参当不可信：空文本、类型不对一律 INVALID_ARGUMENT", async () => {
  const { router, host } = await fixture()
  const created = valueOf(await router.handle("conv.create", {})) as { conversationId: number }

  const empty = await router.handle("conv.submit", {
    conversationId: created.conversationId,
    text: "   ",
  })
  assert.equal(empty.ok, false)
  assert.equal(empty.ok ? "" : empty.error.code, "INVALID_ARGUMENT")

  const notObject = await router.handle("conv.list", "oops")
  assert.equal(notObject.ok, false)
  assert.equal(notObject.ok ? "" : notObject.error.code, "INVALID_ARGUMENT")

  const badBusy = await router.handle("conv.submit", {
    conversationId: created.conversationId,
    text: "hi",
    whenBusy: "later",
  })
  assert.equal(badBusy.ok, false)
  assert.equal(badBusy.ok ? "" : badBusy.error.code, "INVALID_ARGUMENT")

  const badId = await router.handle("conv.open", { conversationId: 0 })
  assert.equal(badId.ok, false)
  assert.equal(badId.ok ? "" : badId.error.code, "INVALID_ARGUMENT")

  await host.close()
})

test("conv.fork 在空会话上明确报错，而不是造出一个空分叉", async () => {
  const { router, host } = await fixture()
  const created = valueOf(await router.handle("conv.create", {})) as { conversationId: number }
  const result = await router.handle("conv.fork", { conversationId: created.conversationId })
  assert.equal(result.ok, false)
  assert.equal(result.ok ? "" : result.error.code, "INVALID_ARGUMENT")
  await host.close()
})

test("doc.get 读 app.* 文档；未知 kind 报错", async () => {
  const { router, host } = await fixture()
  const created = valueOf(await router.handle("conv.create", {})) as { conversationId: number }
  const id = created.conversationId

  // 没创建过就是 undefined，不是报错。
  const missing = await router.handle("doc.get", { conversationId: id, kind: "app.workspace" })
  assert.equal(missing.ok, true)
  assert.equal(missing.ok ? missing.value : "x", undefined)

  await host.harness.commit(async (tx) => {
    const doc = await tx.doc(AppWorkspaceDoc, id as ConversationId)
    doc.pinned = ["src/a.ts"]
  }, BACKGROUND_CONTEXT)

  const found = await router.handle("doc.get", { conversationId: id, kind: "app.workspace" })
  assert.equal(found.ok, true)
  assert.deepEqual(found.ok ? found.value : undefined, {
    pinned: ["src/a.ts"],
    view: "chat",
  })

  const unknown = await router.handle("doc.get", { conversationId: id, kind: "app.nope" })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.ok ? "" : unknown.error.code, "INVALID_ARGUMENT")

  await host.close()
})

test("审批评审通道：列表、答复、重复答复返回终态", async () => {
  const { router, host } = await fixture()
  const created = valueOf(await router.handle("conv.create", {})) as { conversationId: number }
  const id = created.conversationId

  assert.deepEqual(valueOf(await router.handle("approval.list", { conversationId: id })), [])

  const unknown = await router.handle("approval.respond", { id: "nope", approved: true })
  assert.equal(unknown.ok, true)
  assert.deepEqual(unknown.ok ? unknown.value : undefined, { decision: "expired" })

  const badFlag = await router.handle("approval.respond", { id: "nope", approved: "yes" })
  assert.equal(badFlag.ok, false)
  assert.equal(badFlag.ok ? "" : badFlag.error.code, "INVALID_ARGUMENT")

  await host.close()
})
