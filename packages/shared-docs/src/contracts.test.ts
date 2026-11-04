import assert from "node:assert/strict"
import { test } from "node:test"

import { isJsonValue } from "@pi/shared-types"

import { AppApprovalsDoc } from "./approvals.ts"
import { ApprovalEntry, UiActionEntry } from "./entries.ts"
import { AppSettingsDoc } from "./settings.ts"
import { AppWorkspaceDoc } from "./workspace.ts"

/**
 * kind 是写入库契约：这些断言的价值不在于「现在的值对不对」，而在于**改它必须是有意识的**。
 * 改这个测试的前提是想清楚了旧数据怎么办（迁移，或者接受读不出来）。
 */
test("文档 kind 与作用域是契约值", () => {
  const settings = AppSettingsDoc.definition
  assert.equal(settings.kind, "app.settings")
  assert.equal(settings.version, 1)
  assert.equal(settings.scope, "session")

  const approvals = AppApprovalsDoc.definition
  assert.equal(approvals.kind, "app.approvals")
  assert.equal(approvals.scope, "conversation")
  assert.equal(approvals.history, "latest")
  assert.equal(approvals.fork, "current")

  const workspace = AppWorkspaceDoc.definition
  assert.equal(workspace.kind, "app.workspace")
  assert.equal(workspace.history, "rewindable")
  assert.equal(workspace.fork, "asOf")
})

test("条目 kind 是契约值", () => {
  assert.equal(UiActionEntry.kind, "app.ui_action")
  assert.equal(ApprovalEntry.kind, "app.approval")
})

test("初值都是严格 JSON，且不共享引用", () => {
  const first = AppWorkspaceDoc.definition.initial()
  const second = AppWorkspaceDoc.definition.initial()
  assert.notEqual(first, second)
  assert.deepEqual(first, { pinned: [], view: "chat" })
  assert.equal(isJsonValue(first), true)

  assert.deepEqual(AppSettingsDoc.definition.initial(), {
    theme: "system",
    locale: "zh-CN",
    verboseTools: false,
  })
  assert.deepEqual(AppApprovalsDoc.definition.initial(), { pending: [] })
})

test("checkpoint 策略：小改动记增量，攒够一批再落整帧", () => {
  const policy = AppSettingsDoc.definition.checkpointWhen
  assert.equal(policy(AppSettingsDoc.definition.initial(), [], { deltasSinceBase: 0 }), false)
  assert.equal(policy(AppSettingsDoc.definition.initial(), [], { deltasSinceBase: 64 }), true)
})
