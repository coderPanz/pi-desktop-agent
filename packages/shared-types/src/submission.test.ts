import assert from "node:assert/strict"
import { test } from "node:test"

import type { ViewSnapshot } from "./frame.ts"
import type { InputSubmissionView } from "./submission.ts"
import { mergeSubmissionView, submissionFailure } from "./submission.ts"

const failed: InputSubmissionView = { id: 10, conversationId: 1, entryId: 9, status: "unanswered", reason: "no_model", message: "未配置模型" }
const snapshot: ViewSnapshot = { conversation: { id: 1 }, entries: [{ id: 9, conversationId: 1, kind: "pi.user" }], docs: {} }

test("live 清空后仍显示终态错误，下个输入开始或成功后清除旧错误", () => {
  assert.equal(submissionFailure(failed, snapshot), "未配置模型")
  const next = mergeSubmissionView(failed, { id: 11, conversationId: 1, status: "placed" })
  assert.equal(submissionFailure(next, snapshot), undefined)
  assert.equal(submissionFailure({ id: 11, conversationId: 1, status: "done" }, snapshot), undefined)
})

test("后续排队输入不遮住当前轮次失败，迟到的当前轮次失败能替换排队状态", () => {
  const queued: InputSubmissionView = { id: 11, conversationId: 1, status: "queued" }
  assert.equal(mergeSubmissionView(failed, queued), failed)
  assert.equal(mergeSubmissionView(queued, failed), failed)
})

test("初次读取的旧提交、旧状态及空结果不能覆盖推送终态", () => {
  assert.equal(mergeSubmissionView(failed, { id: 8, conversationId: 1, status: "done" }), failed)
  assert.equal(mergeSubmissionView(failed, { id: 10, conversationId: 1, status: "placed" }), failed)
  assert.equal(mergeSubmissionView(failed, undefined), failed)
  const placed: InputSubmissionView = { id: 11, conversationId: 1, status: "placed" }
  assert.equal(mergeSubmissionView(placed, { ...placed, status: "queued" }), placed)
})

test("切换会话不沿用旧提交，停止/重置不显示生成失败", () => {
  const other: InputSubmissionView = { id: 3, conversationId: 2, status: "placed" }
  assert.equal(mergeSubmissionView(failed, other), other)
  assert.equal(submissionFailure({ ...failed, reason: "aborted" }, snapshot), undefined)
  assert.equal(submissionFailure({ ...failed, reason: "reset" }, snapshot), undefined)
  assert.equal(submissionFailure(failed, { ...snapshot, entries: [] }), undefined)
  assert.equal(submissionFailure({ ...failed, conversationId: 2 }, snapshot), undefined)
  assert.equal(submissionFailure(failed, undefined), undefined)
})
