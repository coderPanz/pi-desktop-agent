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
 *
 * 后续（S7–S9，用到再写，现在写就是猜）：app.kb / app.toolbox / app.smartui
 */
export type { AppLocale, AppSettings, AppTheme } from "./settings.ts"
export { AppSettingsDoc } from "./settings.ts"

export type { AppApprovals, ApprovalDecision, ApprovalRequest } from "./approvals.ts"
export { AppApprovalsDoc } from "./approvals.ts"

export type { ApprovalData, UiActionData } from "./entries.ts"
export { ApprovalEntry, UiActionEntry } from "./entries.ts"

export type { AppWorkspace } from "./workspace.ts"
export { AppWorkspaceDoc } from "./workspace.ts"
