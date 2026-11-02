import assert from "node:assert/strict"
import { test } from "node:test"

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { MemoryStorage, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable"
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai"

import { FrameHub, type ViewFrame } from "./frame-hub.ts"
import { HarnessHost } from "../harness/host.ts"
import { createPiRegistry } from "../harness/registry.ts"

const ctx = BACKGROUND_CONTEXT

async function openFixture() {
  const storage = new MemoryStorage()
  const models = createModels({ credentials: new InMemoryCredentialStore() })
  const host = await HarnessHost.open({ storage, models, registry: createPiRegistry() })
  const hub = new FrameHub(host.harness)
  return { host, hub }
}

/** 等到条件成立，最多等 `timeoutMs`。帧回调是异步投递的，不能同步断言。 */
async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error("等待帧超时")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function appendNote(host: HarnessHost, n: number): Promise<void> {
  const conversation = await host.harness.conversation(ROOT_CONVERSATION_ID, ctx)
  assert.ok(conversation !== undefined)
  await conversation.submit({ type: "write", entry: { kind: "test.note", data: { n } } }, ctx)
}

test("open 不重放历史：给出当前 value 与 seq 0", async () => {
  const { host, hub } = await openFixture()
  try {
    await appendNote(host, 1)

    const opened = await hub.open(ROOT_CONVERSATION_ID, ctx)
    assert.equal(opened.seq, 0)
    assert.equal(opened.convId, ROOT_CONVERSATION_ID)
    // 历史条目已在 value 里，但不是「补推的帧」。
    assert.equal(opened.value.entries.length, 1)
  } finally {
    await hub.closeAll()
    await host.close()
  }
})

test("每次提交推一帧，seq 单调 +1", async () => {
  const { host, hub } = await openFixture()
  try {
    const frames: ViewFrame[] = []
    hub.addSink((frame) => frames.push(frame))
    await hub.open(ROOT_CONVERSATION_ID, ctx)

    await appendNote(host, 1)
    await waitFor(() => frames.length === 1)

    await appendNote(host, 2)
    await waitFor(() => frames.length === 2)

    assert.deepEqual(
      frames.map((frame) => frame.seq),
      [1, 2],
    )
    assert.ok(frames.every((frame) => frame.convId === ROOT_CONVERSATION_ID))
    assert.ok(frames.every((frame) => Array.isArray(frame.ops)))

    assert.equal(hub.cursors().get(ROOT_CONVERSATION_ID), 2)
  } finally {
    await hub.closeAll()
    await host.close()
  }
})

test("重复 open 不新建 watch：seq 续着走", async () => {
  const { host, hub } = await openFixture()
  try {
    const frames: ViewFrame[] = []
    hub.addSink((frame) => frames.push(frame))

    await hub.open(ROOT_CONVERSATION_ID, ctx)
    await appendNote(host, 1)
    await waitFor(() => frames.length === 1)

    const again = await hub.open(ROOT_CONVERSATION_ID, ctx)
    assert.equal(again.seq, 1)
    assert.equal(again.value.entries.length, 1)

    await appendNote(host, 2)
    await waitFor(() => frames.length === 2)
    assert.equal(frames[1]?.seq, 2)
  } finally {
    await hub.closeAll()
    await host.close()
  }
})

test("移除 sink 后不再收到帧；关掉的会话不再推进", async () => {
  const { host, hub } = await openFixture()
  try {
    const frames: ViewFrame[] = []
    const remove = hub.addSink((frame) => frames.push(frame))
    await hub.open(ROOT_CONVERSATION_ID, ctx)

    await appendNote(host, 1)
    await waitFor(() => frames.length === 1)

    remove()
    await hub.close(ROOT_CONVERSATION_ID)
    await appendNote(host, 2)
    await new Promise((resolve) => setTimeout(resolve, 30))

    assert.equal(frames.length, 1)
    assert.equal(hub.cursors().size, 0)
  } finally {
    await hub.closeAll()
    await host.close()
  }
})

test("sink 抛错不会打断其他 sink", async () => {
  const { host, hub } = await openFixture()
  const errors: unknown[] = []
  const failing = new FrameHub(host.harness, { onError: (error) => errors.push(error) })
  try {
    const frames: ViewFrame[] = []
    failing.addSink(() => {
      throw new Error("坏 sink")
    })
    failing.addSink((frame) => frames.push(frame))
    await failing.open(ROOT_CONVERSATION_ID, ctx)

    await appendNote(host, 1)
    await waitFor(() => frames.length === 1)
    assert.equal(errors.length, 1)
  } finally {
    await failing.closeAll()
    await hub.closeAll()
    await host.close()
  }
})

test("会话不存在时 open 直接报错", async () => {
  const { host, hub } = await openFixture()
  try {
    await assert.rejects(
      async () => await hub.open(999 as typeof ROOT_CONVERSATION_ID, ctx),
      /会话不存在/,
    )
  } finally {
    await hub.closeAll()
    await host.close()
  }
})
