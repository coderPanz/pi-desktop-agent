/**
 * @pi/shared-docs — `app.*` 文档与条目定义，只在主进程 import
 *
 * 为什么单独成包：kind 一旦写入库就是契约，必须集中放在一处、有版本号、有迁移入口，
 * 而不是散在 `handlers/` 里随用随写。渲染进程不引用本包（它依赖 `pi-durable`）。
 *
 * 已实现（S5）：
 *   settings.ts   app.settings    会话无关的应用偏好
 *   approvals.ts  app.approvals   待审批副作用与最近决定
 *   entries.ts    app.ui_action / app.approval  应用条目 kind
 *   workspace.ts  app.workspace   界面侧会话状态（可回卷、按 asOf 分叉）
 *   trash.ts      app.trash       被删除（从列表移除）的会话 id
 *   pins.ts       app.pins        侧栏置顶的会话 id
 *   title.ts      app.title       侧栏标题（第一条用户消息 / 它的 AI 摘要）
 *   activity.ts   app.activity    会话最近一次活跃的墙钟时间（「最近」排序与时间节点）
 *
 * 后续（S7–S9，用到再写，现在写就是猜）：app.kb / app.smartui；app.subapps 已在子应用 M1 中落地。
 */
export type { AppLocale, AppSettings, AppTheme } from "./settings.ts"
export { AppSettingsDoc } from "./settings.ts"

export type { AppApprovals, ApprovalDecision, ApprovalRequest } from "./approvals.ts"
export { AppApprovalsDoc } from "./approvals.ts"

export type { ApprovalData, UiActionData } from "./entries.ts"
export { ApprovalEntry, UiActionEntry } from "./entries.ts"

export type { AppWorkspace } from "./workspace.ts"
export { AppWorkspaceDoc } from "./workspace.ts"

export type { AppTrash } from "./trash.ts"
export { AppTrashDoc } from "./trash.ts"

export type { AppPins } from "./pins.ts"
export { AppPinsDoc } from "./pins.ts"

export type { AppTitle } from "./title.ts"
export { AppTitleDoc } from "./title.ts"

export type { AppActivity } from "./activity.ts"
export { AppActivityDoc } from "./activity.ts"
export type { AppChanges } from "./changes.ts"
export { AppChangesDoc } from "./changes.ts"

export type { AppSubapp, AppSubapps } from "@pi/shared-types"
export { AppSubappsDoc } from "./subapps.ts"