/**
 * @pi/core — 纯 Node 运行时层（禁止 import electron）。
 *
 * 规划模块（按阶段落地，见 技术方案二.md §4.1）：
 *   S3  agent/models.ts、agent/env.ts、session/manager.ts
 *   S4  paths.ts、storage/create-storage.ts、
 *       harness/{open-harness,registry,host}.ts、frames/frame-hub.ts、diagnostics/inspect.ts
 *   S5  harness/materialize.ts、agent/credentials.ts、frames/doc-hub.ts
 *
 * 现在为空：阶段 0 只需要 verify/lib 里的最小客户端。不提前写用不到的抽象。
 */
export {}
