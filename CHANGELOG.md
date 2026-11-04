# 变更记录

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

## [未发布]

### 新增

- `@pi/ext-coding`（扩展名 `coding`）：`read` / `list_dir` / `write` / `edit` / `bash` 五个工具。
  `read`/`write`/`edit`/`bash` 直接复用 `@earendil-works/pi-durable/tools`（截断续读、图片降级、输出 spill、同路径写入串行都是 SDK 已经做对的事），
  扩展只补 `list_dir`、路径边界与审批
- 路径边界两道关（`packages/extensions/coding/src/paths.ts`、`guard.ts`）：词法判定用 `path.resolve` + `path.relative`
  （不用 `startsWith`），再加真实路径判定——目标（或它最近的已存在祖先）与工作区根都 `canonicalPath` 后再比较，
  挡住指向工作区外的软链；纯函数有单测，软链越界有真文件系统用例
- 三档审批（`policy.ts` + `beforeTool` Hook）：`allow` / `ask` / `deny`；灾难性写法（抹盘、关机、根级删除、fork 炸弹）直接拒绝，
  只读命令放行，其余询问。审批带 120s 超时，超时与无答复通道都按拒绝处理
- CLI 审批通道（`apps/cli/src/approvals.ts`）：REPL 与审批共用同一条 stdin——只有一个消费者，
  审批请求排进同一队列，下一行就是答复；输入关闭（EOF）时未答复的审批全部结算为拒绝，不留挂起的 Promise
- `PI_LOG_LEVEL=debug` 启动时打印注册表摘要（扩展名 / 工具名 / 任务名），验收装配看这一行

### 变更

- 文档按「工程事实」重排：删除阶段教程式章节与工期预估（`docs/notes/` 原子笔记保留不变）；`V1开发路线.md` 改为 `ROADMAP.md`（现状、待办顺序、边界），
  技术方案删除分阶段方案、里程碑演示、实施顺序、开工检查表等教学章节（1311 行 → 854 行）
- `AGENT.md` §10 新增原子化笔记写入规则：只记可复用结论，不记长篇教程、学习路线与工期
- 技术方案的 §4.1 目录树、§9.1 根脚本按当前仓库实际内容重写（原内容列着已不存在的 `verify/stage*.ts`）
- §6.2 `app.*` 与 §7 IPC 改为指向 `shared-types` / `shared-docs` 代码，不再重复类型定义
- `AGENT.md` 重写为纯工程约定，去掉原子笔记规则
- 工具名契约按实现落定：`read` / `write` / `edit` / `bash`（沿用 SDK）+ 自建 `list_dir`；
  原先文档里的 `read_file` / `write_file` 作废（尚未上线，无已有会话受影响）
- `write`、`edit`、`bash` 标记 `executionMode: "sequential"`，避免同一轮里写盘与执行命令交叠
- `pnpm test` 的 glob 补上 `packages/extensions/*/src/**/*.test.ts`：扩展的用例原先跑不到
- README 增加「工具与审批」一节；ROADMAP 工具链一项转为已完成，待办从桌面接线开始

### 修复

- 审批等待接入 `context.abortSignal`：会话中断或关闭时立刻按拒绝返回，不再等到 120s 超时。
  之前不认信号：`Scheduler.join()` 关闭时只 `abort()` 再 `await invocation.done`，abort 只是信号，
  卡在钩子里的等待会让 `host.close()` 一直等到超时
- 审批超时计时器最初 `unref()`：事件循环空闲时计时器被跳过，超时形同不存在，等待方永不返回
- CLI：审批已结束（被取消/超时/已答）时再输入，提示「本次输入未生效」，不再谎报「已拒绝」

### 计划中

- 桌面接线：主进程持有 `HarnessHost`、实现 `IpcMap` / `PushMap`、渲染进程副本与聊天界面；
  Electron 侧审批（`app.approvals` pending + 事件门）也在这里接
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
