/**
 * 应用自己的条目 kind（`app.*`）。
 *
 * 跟 SDK 的 `pi.*` 并列，但归应用管：`pi.*` 的条目带 `model` 字段、会喂给模型；
 * 这里的条目只给界面和审计看，不带 `model`，不进模型上下文。
 *
 * `v` 是数据版本：改字段就升它并写迁移，否则旧数据读不出来。
 */
import { defineEntry } from "@earendil-works/pi-durable"

import type { JsonValue } from "@pi/shared-types"

/**
 * 用户点了智能 UI 上的某个动作。
 *
 * `requestId` 是幂等的关键：同一次点击的重试要复用它，否则会写出两条 submission。
 */
export type UiActionData = {
  v: 1
  uiId: string
  actionId: string
  requestId: string
  payload: JsonValue
}

/** 一次审批的结果，用于审计与回放。 */
export type ApprovalData = {
  v: 1
  approvalId: string
  callId: string
  tool: string
  decision: "approved" | "denied" | "expired"
}

/** 两个 kind 都是落盘契约：改名等于旧数据读不出来。 */
export const UiActionEntry = defineEntry<UiActionData>("app.ui_action")
export const ApprovalEntry = defineEntry<ApprovalData>("app.approval")
