import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import type { TestContext } from "node:test"

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context"
import type { SubmissionId } from "@earendil-works/pi-durable"
import type { IpcChannel, IpcResult, InputSubmissionView, PushChannel, PushMap } from "@pi/shared-types"

import { DesktopRuntime } from "./runtime.ts"

function value<K extends IpcChannel>(result: IpcResult<K>) {
  assert.ok(result.ok, result.ok ? "" : result.error.message)
  return result.value
}

async function fixture(t: TestContext, mode: "ok" | "no-model" | "unauthorized", memory = true) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-desktop-test-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const calls: string[] = []
  const server = createServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += chunk
    const input = JSON.parse(body)
    calls.push(input.model)
    if (mode === "unauthorized") {
      response.writeHead(401, { "content-type": "application/json" })
      response.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "TEST_INVALID_KEY" } }))
      return
    }
    const events = [
      ["message_start", { message: { id: "test-msg", type: "message", role: "assistant", model: input.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
      ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "NEW_OK" } }],
      ["content_block_stop", { index: 0 }],
      ["message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }],
      ["message_stop", {}],
    ] as const
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.end(events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join(""))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const address = server.address()
  assert.ok(address !== null && typeof address !== "string")

  const environment = {
    ANTHROPIC_MODEL: mode === "no-model" ? undefined : "desktop-test-model",
    ANTHROPIC_API_KEY: "local-test-key",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
  }
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]))
  for (const [key, entry] of Object.entries(environment)) {
    if (entry === undefined) delete process.env[key]
    else process.env[key] = entry
  }
  t.after(() => {
    for (const [key, entry] of Object.entries(previous)) {
      if (entry === undefined) delete process.env[key]
      else process.env[key] = entry
    }
  })

  const statuses: InputSubmissionView[] = []
  const publish = <K extends PushChannel>(channel: K, payload: PushMap[K]): void => {
    if (channel === "submission") statuses.push(payload as InputSubmissionView)
  }
  const options = { dataDir: dir, memory, publish, appVersion: "test", platform: process.platform, versions: { electron: undefined, node: process.versions.node, chrome: undefined } }
  const runtime = await DesktopRuntime.open(options)
  t.after(() => runtime.close())
  return { runtime, statuses, calls, options }
}

test("桌面真实装配：IPC 新建后请求本地模型并得到回答及持久化提交状态", { timeout: 10000 }, async (t) => {
  const { runtime, statuses, calls } = await fixture(t, "ok")
  const created = value(await runtime.router.handle("conv.create", {}))
  const opened = value(await runtime.router.handle("conv.open", created))
  assert.deepEqual(opened.snapshot.docs["pi.agent"]?.model, { provider: "gateway", modelId: "desktop-test-model" })
  const submitted = value(await runtime.router.handle("conv.submit", { ...created, text: "hello" }))
  const submission = await runtime.host.harness.submission(submitted.submissionId as SubmissionId, ctx)
  assert.ok(submission)
  assert.equal((await submission.wait(ctx)).status, "done")
  assert.deepEqual(calls, ["desktop-test-model"])
  const latest = value(await runtime.router.handle("conv.submission", created))
  assert.equal(latest?.status, "done")
  assert.ok(statuses.some(status => status.id === submitted.submissionId && status.status === "done"))
  const view = value(await runtime.router.handle("conv.open", created))
  assert.equal(view.snapshot.entries.at(-1)?.kind, "pi.assistant")
  assert.deepEqual(view.snapshot.docs["pi.live"], {})
})

test("无模型的终态通过提交推送与 IPC 可见，不依赖 live；未知会话返回 NOT_FOUND", { timeout: 10000 }, async (t) => {
  const { runtime, statuses, calls } = await fixture(t, "no-model")
  const id = runtime.info.rootConversationId
  assert.equal(value(await runtime.router.handle("conv.submission", { conversationId: id })), undefined)
  const submitted = value(await runtime.router.handle("conv.submit", { conversationId: id, text: "hello" }))
  const submission = await runtime.host.harness.submission(submitted.submissionId as SubmissionId, ctx)
  assert.ok(submission)
  assert.equal((await submission.wait(ctx)).status, "unanswered")
  const latest = value(await runtime.router.handle("conv.submission", { conversationId: id }))
  assert.equal(latest?.status, "unanswered")
  if (latest?.status === "unanswered") {
    assert.equal(latest.reason, "no_model")
    assert.match(latest.message, /未配置可用模型/)
  }
  assert.deepEqual(value(await runtime.router.handle("conv.open", { conversationId: id })).snapshot.docs["pi.live"], {})
  assert.ok(statuses.some(status => status.status === "unanswered" && status.reason === "no_model"))
  assert.equal(calls.length, 0)
  const unknown = await runtime.router.handle("conv.submission", { conversationId: 9999 })
  assert.ok(!unknown.ok)
  assert.equal(unknown.error.code, "NOT_FOUND")
})

test("模型最终失败在 live 清空和文件库重开后仍可读取，关闭后不再推送", { timeout: 15000 }, async (t) => {
  const { runtime, statuses, options } = await fixture(t, "unauthorized", false)
  const id = runtime.info.rootConversationId
  const submitted = value(await runtime.router.handle("conv.submit", { conversationId: id, text: "hello" }))
  const submission = await runtime.host.harness.submission(submitted.submissionId as SubmissionId, ctx)
  assert.ok(submission)
  await submission.wait(ctx)
  const before = value(await runtime.router.handle("conv.submission", { conversationId: id }))
  assert.equal(before?.status, "unanswered")
  if (before?.status === "unanswered") {
    assert.equal(before.reason, "model_error")
    assert.match(before.message, /TEST_INVALID_KEY/)
  }
  assert.deepEqual(value(await runtime.router.handle("conv.open", { conversationId: id })).snapshot.docs["pi.live"], {})
  await runtime.close()
  const count = statuses.length
  const reopened = await DesktopRuntime.open({ ...options, publish: () => {} })
  try {
    const after = value(await reopened.router.handle("conv.submission", { conversationId: id }))
    assert.deepEqual(after, before)
    assert.equal(statuses.length, count)
  } finally {
    await reopened.close()
  }
})
