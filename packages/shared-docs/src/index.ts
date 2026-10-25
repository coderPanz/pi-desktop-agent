/**
 * @pi/shared-docs — defineDoc / defineEntry 定义，只在主进程 import。
 *
 * 规划模块（见 技术方案二.md §6.2）：
 *   S5  settings.ts   app.settings（session, latest）
 *   S5  approvals.ts  app.approvals（conversation, latest）
 *   S5  entries.ts    defineEntry：app.ui_action / app.approval
 *   S5  migrations.ts version 升级助手（只增不删）
 *   S6  workspace.ts  app.workspace（conversation, rewindable / asOf）
 *   S7  kb.ts         app.kb（session, latest）
 *   S8  toolbox.ts    app.toolbox（session, latest）
 *   S9  smartui.ts    app.smartui（conversation, latest）
 *
 * 注意：kind 一旦写进存储就不能改；checkpointWhen 是 1.4.0 的必填字段。
 */
export {}
