/**
 * @pi/shared-types — 两端共用的契约与纯函数。
 *
 * 主进程、preload、渲染进程都只从这一份定义读类型；SDK 类型一律 import type，不重复声明。
 *
 * 规划模块（见 docs/知识中心/技术方案.md §4.1 / §7）：
 *   S1→S5  frame.ts   applyFrame / isBase / ViewFrame / DocFrame
 *   S5     ipc.ts     IpcMap（请求/响应）
 *   S5     push.ts    PushMap：view / doc / task.graph / host.status
 *   S5     domain.ts  ConversationSummary / ToolInfo / KbSource / BuildState
 *   S5     errors.ts  IpcError + 错误码 + 映射助手
 *   S5     schemas.ts TypeBox IPC 校验 schema
 *   S6     guards.ts  pi.live / pi.inbox / app.* 的运行时守卫
 *
 * 约束：本包不得依赖 pi-durable（渲染进程要能引用它）。
 */
export {}
