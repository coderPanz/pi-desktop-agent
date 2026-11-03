import assert from "node:assert/strict"
import { test } from "node:test"

import { IpcError, toIpcErrorPayload } from "./errors.ts"

test("IpcError 带码转出", () => {
  assert.deepEqual(new IpcError("NOT_FOUND", "会话不存在").toPayload(), {
    code: "NOT_FOUND",
    message: "会话不存在",
  })
})

test("core 的 UserError 映射成 INVALID_ARGUMENT", () => {
  const error = new Error("当前会话没有可 fork 的条目")
  error.name = "UserError"
  assert.equal(toIpcErrorPayload(error).code, "INVALID_ARGUMENT")
})

test("SessionFailed 映射成 SESSION_FAILED（页面应进入恢复态）", () => {
  const error = new Error("storage failed")
  error.name = "SessionFailed"
  assert.equal(toIpcErrorPayload(error).code, "SESSION_FAILED")
})

test("未知异常与非 Error 都归到 UNKNOWN，且保留可读信息", () => {
  assert.deepEqual(toIpcErrorPayload(new Error("boom")), { code: "UNKNOWN", message: "boom" })
  assert.deepEqual(toIpcErrorPayload("字符串异常"), { code: "UNKNOWN", message: "字符串异常" })
})
