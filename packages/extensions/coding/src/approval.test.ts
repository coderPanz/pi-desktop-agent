import assert from "node:assert/strict"
import { test } from "node:test"

import { requestApproval } from "./approval.ts"

const REQUEST = { tool: "bash", summary: "bash: rm -rf ./build" }

test("没有答复通道按拒绝处理", async () => {
  assert.equal(await requestApproval(REQUEST, undefined), false)
})

test("人点了批准才执行", async () => {
  assert.equal(await requestApproval(REQUEST, () => true), true)
  assert.equal(await requestApproval(REQUEST, () => false), false)
})

test("答复抛错按拒绝处理", async () => {
  assert.equal(
    await requestApproval(REQUEST, () => {
      throw new Error("终端断了")
    }),
    false,
  )
})

test("超时按拒绝处理，并且不拖住进程", async () => {
  const started = Date.now()
  const never = (): Promise<boolean> => new Promise<boolean>(() => {})
  assert.equal(await requestApproval(REQUEST, never, { timeoutMs: 20 }), false)
  assert.ok(Date.now() - started < 1000, "超时后必须立刻返回")
})

test("已经取消的调用不再问人", async () => {
  const controller = new AbortController()
  controller.abort()
  let asked = false
  const approver = (): boolean => {
    asked = true
    return true
  }
  assert.equal(await requestApproval(REQUEST, approver, { signal: controller.signal }), false)
  assert.equal(asked, false)
})

test("等待中被取消立刻按拒绝返回，不等超时", async () => {
  const controller = new AbortController()
  const never = (): Promise<boolean> => new Promise<boolean>(() => {})
  const started = Date.now()
  const pending = requestApproval(REQUEST, never, { timeoutMs: 60_000, signal: controller.signal })
  controller.abort()
  assert.equal(await pending, false)
  assert.ok(Date.now() - started < 1000, "取消后必须立刻返回")
})
