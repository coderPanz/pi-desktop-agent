# 变更记录

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

## [未发布]

### 变更

- 文档按「工程事实」重排：删除阶段教程式章节与工期预估（`docs/notes/` 原子笔记保留不变）；`V1开发路线.md` 改为 `ROADMAP.md`（现状、待办顺序、边界），
  技术方案删除分阶段方案、里程碑演示、实施顺序、开工检查表等教学章节（1311 行 → 854 行）
- `AGENT.md` §10 新增原子化笔记写入规则：只记可复用结论，不记长篇教程、学习路线与工期
- 技术方案的 §4.1 目录树、§9.1 根脚本按当前仓库实际内容重写（原内容列着已不存在的 `verify/stage*.ts`）
- §6.2 `app.*` 与 §7 IPC 改为指向 `shared-types` / `shared-docs` 代码，不再重复类型定义
- `AGENT.md` 重写为纯工程约定，去掉原子笔记规则

### 计划中

- 工具链：`@pi/ext-coding`（read_file / list_dir / write_file / bash + 三档审批）
- 桌面接线：主进程持有 `HarnessHost`、实现 `IpcMap` / `PushMap`、渲染进程副本与聊天界面
- 崩溃恢复五类场景的实测记录（`PI_CRASH_POINT`）

## [0.1.0] - 2026-11-02

### 新增

- 终端入口 `apps/cli`：真实装配 `storage → open → resume → root`，支持发消息、中断、排队、分叉、重置、压缩、诊断
- 参数与命令解析（`--memory` / `--data-dir` / `--conv` / `--partial-interval-ms` / `-p`）与斜杠命令
- 帧 → 终端渲染：流式只追加后缀，正在生成的回答与落盘回答不双显
- 契约包 `@pi/shared-types`：帧协议、命令通道、推送通道、错误码、业务视图模型，以及内置 kind 常量
- 文档包 `@pi/shared-docs`：`app.settings` / `app.approvals` / `app.workspace` 与 `app.ui_action` / `app.approval` 条目
- `core/harness/materialize.ts`：把 SDK 的会话视图投影成线协议副本，坏数据丢弃而不抛错
- `core` 错误分类：`UserError`（状态不满足前提）与 `ConfigError`（配置缺失），存储失败仍按致命处理
- CI：`.github/workflows/ci.yml`，`verify` 跑 typecheck / lint / test / smoke，`desktop` 验证构建产物
- `pnpm smoke`：端到端冒烟，不联网、不需要模型凭证

### 变更

- `createStorage` 按需加载 `node:sqlite`，内存库路径不再把 SQLite 拉进进程
- `FrameHub.open()` 返回投影后的副本（`snapshot`）而不是 SDK 视图；`ViewFrame` 改为来自契约包
- `ConversationSummary` 收敛到 `@pi/shared-types`，core 只做转出
- `packages/core` 移除对四个空扩展包的依赖
- README 改为使用说明（快速开始 / 命令 / 数据布局 / 契约位置 / 故障排查），路线留在 `docs/知识中心/ROADMAP.md`

### 修复

- 管道输入与 `Ctrl+D` 时 REPL 挂在未决的 `rl.question()` 上，导致进程无法退出
- 斜杠命令拼错被当成「启动失败」而非用户输入问题
- `/fork` 在无条目时被记为进程失败并返回非零退出码
