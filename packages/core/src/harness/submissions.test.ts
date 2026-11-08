import assert from "node:assert/strict"
import { test } from "node:test"

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context"
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai"
import { MemoryStorage } from "@earendil-works/pi-durable"
import type { SubmissionRecord } from "@earendil-works/pi-durable"

import { HarnessHost } from "./host.ts"
import { createPiRegistry } from "./registry.ts"
import { latestInputSubmission, materializeSubmission } from "./submissions.ts"

function record(fields: object): SubmissionRecord {
  return { id: 3, conversationId: 1, type: "input", status: "unanswered", reason: "model_error", ...fields } as SubmissionRecord
}

test("提交投影保留终态的可读详情，任意错误对象不直接传到界面", () => {
  assert.equal(materializeSubmission(record({ detail: "凭证无效" }))?.status, "unanswered")
  const view = materializeSubmission(record({ detail: "凭证无效" }))
  assert.equal(view?.status === "unanswered" ? view.message : undefined, "凭证无效")
  const bad = materializeSubmission(record({ detail: { arbitrary: "不要发送" } }))
  assert.equal(bad?.status === "unanswered" ? bad.message : undefined, "本次输入未得到回答（model_error）。")
  assert.equal(materializeSubmission(record({ type: "write", status: "done", entry: 2 })), undefined)
})

test("最终重试失败持久化为可见终态，分页跳过 write 提交仍能读回失败", { timeout: 10000 }, async () => {
  const storage = new MemoryStorage()
  const faux = fauxProvider({ models: [{ id: "test" }], tokensPerSecond: Infinity })
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const requesting = new Promise<void>(resolve => { started = resolve })
  const error = fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 TEST_RETRY_EXHAUSTED" })
  faux.setResponses([
    async () => { started(); await gate; return error },
    error,
  ])
  const models = createModels()
  models.setProvider(faux.provider)
  const model = faux.getModel()
  const host = await HarnessHost.open({
    storage, models, registry: createPiRegistry(),
    agent: { model: { provider: model.provider, modelId: model.id } },
    settings: { retry: { maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 1 } },
  })
  try {
    const submission = await host.root.submit({ type: "input", content: "hello" }, ctx)
    await requesting
    const queued = await host.root.submit({ type: "input", content: "queued", whenBusy: "followUp" }, ctx)
    release()
    const settled = await submission.wait(ctx)
    assert.equal(settled.status, "unanswered")
    assert.equal((await queued.status(ctx)).status, "queued")
    assert.equal(faux.state.callCount, 2)
    for (let i = 0; i < 55; i++) {
      await host.root.submit({ type: "write", entry: { kind: "test.note", data: { i } } }, ctx)
    }
    const view = await latestInputSubmission(storage, host.root.id, ctx)
    assert.equal(view?.id, submission.id)
    assert.equal(view?.status, "unanswered")
    assert.equal(view?.status === "unanswered" ? view.message : undefined, "503 TEST_RETRY_EXHAUSTED")
  } finally {
    release()
    await host.close()
  }
})
