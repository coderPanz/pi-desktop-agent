import assert from "node:assert/strict"
import { test } from "node:test"

import { CliEventQueue, createTerminalApprover, parseApprovalAnswer } from "./approvals.ts"

const REQUEST = { tool: "bash", summary: "bash: rm -rf ./build" }

test("队先进先出地交出输入行", async () => {
  const queue = new CliEventQueue()
  queue.pushLine("first")
  queue.pushLine("second")

  const first = await queue.take()
  const second = await queue.take()
  assert.deepEqual(first, { kind: "line", line: "first" })
  assert.deepEqual(second, { kind: "line", line: "second" })
})

test("没有事件时 take 等到有人推", async () => {
  const queue = new CliEventQueue()
  const waited = queue.take()
  queue.pushLine("late")
  assert.deepEqual(await waited, { kind: "line", line: "late" })
})

test("审批请求排进同一个队列，答复后 resolve", async () => {
  const queue = new CliEventQueue()
  const answer = queue.requestApproval(REQUEST)

  const event = await queue.take()
  assert.equal(event?.kind, "approval")
  assert.equal(event?.kind === "approval" ? event.request.summary : "", REQUEST.summary)

  if (event?.kind === "approval") event.settle(true)
  assert.equal(await answer, true)
})

test("重复 settle 不会第二次生效", async () => {
  const queue = new CliEventQueue()
  const answer = queue.requestApproval(REQUEST)
  const event = await queue.take()
  if (event?.kind !== "approval") throw new Error("应为审批事件")

  assert.equal(event.settle(false), true)
  assert.equal(event.settle(true), false)
  assert.equal(await answer, false)
})

test("输入关闭时未答复的审批一律拒绝", async () => {
  const queue = new CliEventQueue()
  const answer = queue.requestApproval(REQUEST)
  queue.close()
  assert.equal(await answer, false)
})

test("关闭后晚到的答复不会生效", async () => {
  const queue = new CliEventQueue()
  const answer = queue.requestApproval(REQUEST)
  const event = await queue.take()
  if (event?.kind !== "approval") throw new Error("应为审批事件")

  queue.close()
  assert.equal(await answer, false)
  // 审批已由 close() 结算，这一行不再是“一次拒绝”。
  assert.equal(event.settle(true), false)
})

test("输入关闭后再来的审批直接拒绝，不会挂住", async () => {
  const queue = new CliEventQueue()
  queue.close()
  assert.equal(await queue.requestApproval(REQUEST), false)
})

test("关闭后 take 返回 undefined", async () => {
  const queue = new CliEventQueue()
  const waited = queue.take()
  queue.close()
  assert.equal(await waited, undefined)
  assert.equal(await queue.take(), undefined)
})

test("非交互输入不产生审批事件，直接拒绝", async () => {
  const queue = new CliEventQueue()
  const approver = createTerminalApprover({ queue, interactive: false })
  assert.equal(await approver(REQUEST), false)
  // 队列里什么都不该留下。
  queue.close()
  assert.equal(await queue.take(), undefined)
})

test("交互输入把审批交给人", async () => {
  const queue = new CliEventQueue()
  const approver = createTerminalApprover({ queue, interactive: true })
  const answer = approver(REQUEST)
  const event = await queue.take()
  if (event?.kind !== "approval") throw new Error("应为审批事件")
  event.settle(true)
  assert.equal(await answer, true)
})

test("只认明确的肯定", () => {
  for (const line of ["y", "Y", "yes", " YES ", "是"]) {
    assert.equal(parseApprovalAnswer(line), true, line)
  }
  for (const line of ["", "n", "no", "1", "approve", "不是"]) {
    assert.equal(parseApprovalAnswer(line), false, line)
  }
})
