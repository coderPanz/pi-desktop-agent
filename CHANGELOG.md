# 变更记录

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

## [未发布]

### 新增

- 桌面聊天界面：消息列表（回答走 Markdown，用户消息走气泡，重置/压缩显示为分隔线）、
  工具卡（状态、输出摘要、嵌套调用）、工具结果回看（本轮结束后 `pi.live.tools` 会被清空，
  只能从会话记录里看）、审批条、排队显示、生成中流式文本、生成/压缩失败横幅，
  以及新建/分叉/压缩/重置入口
- 渲染进程按职责拆开：`docs.ts`（从副本读 `pi.*` 文档，逐字段当不可信数据）、`useHost.ts`、
  `components/{MarkdownText,ToolCard,MessageList,ApprovalBar,Composer}.tsx`；`App.tsx` 只管布局与回调
- 桌面接线：主进程持有 `HarnessHost`（`apps/desktop/src/main/runtime.ts`），`IpcRouter` 覆盖 13 个通道，
  帧与审批走推送，`before-quit` 按「停推送 → 结算审批 → 停帧 → 关 Harness」的顺序收尾（顺序固定在 `DesktopRuntime.close()`）
- `@pi/core` 新增两块纯 Node 逻辑：`ApprovalBroker`（等答复的 Promise + `app.approvals` 审计镜像 + 超时/取消 + 清理重启残留）
  与 `IpcRouter`（逐通道校验、错误压成 `IpcResult`）；两者只依赖 Harness/Storage，可在普通 Node 里测
- 契约扩展：IPC 加 `approval.list` / `approval.respond`，推送加 `approval`，新增 `PiBridge`（preload 只暴露
  `invoke` / `subscribe`，不暴露 `ipcRenderer`）
- 桌面最小页：会话列表、条目、工具状态、审批「允许/拒绝」、提交与中断，外加一行验收用的
  `seq / 重连 / 丢弃` 调试条
- `PI_DATA_DIR` 覆盖数据根：桌面排障与自测不碰真实 `userData`

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

- 侧栏会话改为树形结构：按 `parent.conversationId` 把扁平列表拼成森林（`lib/conversationTree.ts`，纯函数、有单测），
  子会话缩进挂在父会话下；有子会话的行显示折叠箭头（`aria-expanded`），选中子会话时父链自动展开，
  折叠状态只存在界面内存（重启回到全展开）。分叉来源从「← #N」改为 `title` 提示，行里靠缩进表达层级
- 侧栏会话行支持删除：悬停/聚焦出现垃圾桶图标，二次确认后删除，删除的正是当前会话时切回根会话；
  运行中的会话与根会话不给删除入口
- 删除是**物理删除、不可恢复**（`storage/purge.ts`）：SDK 的 `Storage` 只有 `commit()`、没有删除接口，
  所以自己开一条 SQLite 连接，在 `BEGIN IMMEDIATE` 事务里级联删掉该会话的条目 / 任务 / 提交 /
  会话作用域文档与文档版本 / `record_ids` 登记行；`durable_metadata.next_id / next_seq` 一行不碰，
  id 不会被重用、seq 不回退。保护条件：根会话、未结束的任务、未结算的提交、有子会话（分叉或被 task 拥有）一律拒绝。
  内存库（`--memory` / 测试）没有 SQL 后端，退回把 id 写进 session 级 `app.trash` 从列表移除
- `conv.delete` 删完顺手 `FrameHub.close(id)` 停掉该会话的 watch；`AGENT.md §4` 补记「唯一写者」的唯一例外
- 回归：真文件库上验对话/条目/任务/文档/登记行全删干净、无孤儿版本、`harness.conversation` 查不到；
  有未结束任务时拒绝且一行不删；根会话与有子会话的会话拒绝、子会话删掉后父会话可删；删掉最大会话后
  新会话 id 继续增大、计数器不变。内存库那条仍验「退回列表移除 + 重复删除幂等」

- 聊天里的代码块接入语法高亮（`shiki@4.6.0`）：`lib/highlight.ts` 用 `createHighlighterCoreSync` +
  `createJavaScriptRegexEngine` 建单例（不用 Oniguruma 的 wasm，CSP 不需要开 `'wasm-unsafe-eval'`），
  装了 ts/tsx/js/jsx/json/bash/python/html/css/yaml/markdown/diff，`sh`/`shell`/`yml`/`md` 等别名落到同一套语法，
  结果按 `(lang, code)` 缓存最近 64 条；不认识的语言原样渲染
- `lib/codeHighlight.ts`：rehype 插件只换 `pre > code` 的内容，保留我们自己的 `pre`（圆角、浅灰底、滚动），
  Shiki 的 `pre` 自带背景色会被丢；文本末尾停在未闭合围栏时跳过最后一块（流式每 32ms 重分词会烧 CPU），闭合即上色
- `components/CodeBlock.tsx`：代码块外壳——左上语言标签、右上复制（取渲染后 `textContent`，换行缩进不走样）、
  1.5s 后回到「复制」；`Markdown.tsx` 的 `pre` 覆盖改用它，`pre` 的上下间距移交外壳
- 修 `rehypeStreamReveal` 的老 bug：`plain`（代码块不进场）原来只看当前节点，高亮后的
  `pre > code > span.line > span` 会被再切一遍词；现在整棵子树继承
- 回归：语言/别名可高亮、未知语言不高亮、缓存命中、闭合块带标签与颜色、无标签块显示 `text`、
  流式中最后一块不上色而闭合后上色、代码块里不出现进场 span

- 侧栏标题不再写死「会话 #N」：显示会话里**第一条用户消息**；不超过 10 个字直接用原文，
  超过就先显示截断的原文、后台用当前模型压成 10 字以内（**保持原文语言，不做翻译**；`agent/summarize.ts` 的
  `createTitleSummarizer` + `cleanTitle`，一次性 `completeSimple`，不流式、不重试），
  成功写进 conversation 级 `app.title`（含生成自哪条条目 `from`）并用新推送通道 `conv.title` 通知界面
- `SessionManager.list()` 带上 `title`：`app.title` 命中且 `from` 对得上就不再问模型；同一条会话 + 同一条条目
  只问一次（失败也只记一次，不反复烧模型）；第一条用户消息在进程内缓存，列表不必每次回头翻条目
- 界面：`ConversationRow` 显示标题（`undefined` 时退回 `会话 #N`），完整 id 与分叉来源挂在 `title` 提示上；
  `useHost` 订阅 `conv.title` 就地替换那一行，不重拉整份列表；`App` 在条目数变化时刷新列表，
  让用户消息落盘后标题立刻出现
- 回归：字数按 code point 算（emoji/生僻字不劈开）、截断加省略号、模型输出清洗（引号/前缀/句末标点）；
  短消息不调模型、长消息先截断再摘要并推送、摘要落盘后列表直接用且不重复调用、摘要失败只记一次、
  没有用户消息的会话没有标题

### 变更

- 会话区滚动改为「贴底跟随」（`useStickToBottom`）：只有用户本来就在底部时才跟着流式内容走，往上翻就保持不动，
  底部浮动「回到最新」按钮；离开底部超过 16px 才算走开、回到 64px 内才恢复跟随（滞回，避免底部边缘抖动）；
  自己发消息、重置、切会话仍直接贴底。跟随靠 `ResizeObserver` 监听内容高度 —— 流式文本是逐帧揭示的，列表 props 并不是每次都变
- 桌面聊天界面的 AI 流式输出改为「逐词进场」：新到的词按字（中文）/ 按词（拉丁）从略大、略偏移、略模糊的状态由外向内收束落定（`rehypeStreamReveal` + `.pi-stream-word`）；
  落定边界按 520ms 节拍推进（大于动画总时长），已落定的文字只摘动画类、span 结构保留，因此不重播、不重新折行；代码块与历史消息不参与动画，`prefers-reduced-motion` 下直接呈现终态
- 流式文本加一层「开闸」节奏（`useStreamReveal`）：模型突发的一大段按 32ms / 最多 6 字摊平，基准 34 字/秒、积压按 600ms 时间常数追上（显示最多落后约 0.3 秒的量），
  文字连续落下而不是一坨坨蹦出；动画幅度同时收小（1.28 倍缩放、1.4px 模糊），高速输出时不再晃眼
- `MarkdownText` 的 `components` 表提到模块级：原先每次渲染新建匿名函数，等于换元素类型，整棵 Markdown 子树在每个 token 到来时都会被卸载重建

- 桌面 UI 改为 Apple 风格的浅色工作区：雾灰半透明侧栏、白色对话区域、系统字体、克制的蓝色控件、细分割线与轻阴影；macOS 使用融合标题栏、原生红黄绿按钮与 Vibrancy
- 统一输入、审批、工具卡、Markdown 和错误提示的视觉层级；保留全部入口与业务行为，对话独立滚动、输入区固定在底部，支持减少动态效果偏好
- 增加 UI 静态渲染回归（入口/禁用状态、消息去重、Markdown 转义、工具/审批/排队展示）；测试显式使用桌面 TSX 配置，避免 Node 测试误用经典 JSX 转换

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

- 桌面 `dev/start` 在主进程加载根目录 `.env`，导出的环境变量优先；加载页面前登记可信窗口，避免首批 IPC 被误拒绝
- root 缺模型时在恢复任务前补配置，保留已有模型与历史；桌面「新建」和 CLI `/new` 默认取 root 模型，修正 `agent` 覆盖的 SDK 嵌套入参
- 终态生成失败不再随 `pi.live` 清空而消失：新增 `conv.submission` 读取与 `submission` 已提交状态推送；重启可恢复错误，后续排队输入不遮住当前失败，下次输入开始后清除旧错误
- 回归检查新增桌面纯 Node 装配、本地网关请求、重试耗尽与配置/终态恢复测试，`pnpm test` 覆盖桌面主进程测试文件

- 打包配置：主进程内联 `@earendil-works/*` 会破坏它们的 ESM 循环引用，运行时表现为
  `InMemoryCredentialStore is not a constructor`（生成任务 faulted、提交 `unanswered`）；
  main 改为把这些包留在外部，preload 仍全内联（沙箱里没有 node_modules）
- 启动顺序：先建窗口再注册 IPC，渲染进程会抢跑并报 `No handler registered for 'pi:invoke'`；
  改成先装配运行时与 handler、再开窗
- `@pi/ext-coding` 的审批请求补 `conversationId` / `callId`：宿主靠它写对会话文档、推对窗口，
  并在取消时精确清理
- 界面：只有工具调用、没有文本的 `pi.assistant` 条目不再渲染成空的「助手」；调试条的 docs 计数改为真实文档数

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
- 帧 → 终端渲染：流式只追加后缀，正在生成的回答与已确定的回答不双显
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

- 打包配置：主进程内联 `@earendil-works/*` 会破坏它们的 ESM 循环引用，运行时表现为
  `InMemoryCredentialStore is not a constructor`（生成任务 faulted、提交 `unanswered`）；
  main 改为把这些包留在外部，preload 仍全内联（沙箱里没有 node_modules）
- 启动顺序：先建窗口再注册 IPC，渲染进程会抢跑并报 `No handler registered for 'pi:invoke'`；
  改成先装配运行时与 handler、再开窗
- `@pi/ext-coding` 的审批请求补 `conversationId` / `callId`：宿主靠它写对会话文档、推对窗口，
  并在取消时精确清理
- 界面：只有工具调用、没有文本的 `pi.assistant` 条目不再渲染成空的「助手」；调试条的 docs 计数改为真实文档数

- 管道输入与 `Ctrl+D` 时 REPL 挂在未决的 `rl.question()` 上，导致进程无法退出
- 斜杠命令拼错被当成「启动失败」而非用户输入问题
- `/fork` 在无条目时被记为进程失败并返回非零退出码
