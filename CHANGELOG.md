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

- `bash` 接入内核沙箱（macOS Seatbelt）：新增 `agent/sandbox.ts` 包住 `ExecutionEnv.exec`——
  字符串命令拼成 `sandbox-exec -D WS=<realpath> -D TMP=<tmpdir> -f profile <shell> -lc <cmd>` 的 argv 交给内层
  `NodeExecutionEnv`（超时/cwd/spill/kill/abort 全沿用 SDK）；策略 `(deny file-write*)` 打底、只放开工作区与临时目录，
  `(deny network*)` 默认拒网；profile 走 `-D` 参数而不是字符串拼接（防路径注入），落盘 0600 并在 `cleanup()` 删除
- 开关与失败策略：`PI_SANDBOX=seatbelt|off`（macOS 默认 seatbelt，其它平台默认 off）、`PI_SANDBOX_NET=allow|deny`（默认 deny）；
  `sandbox-exec` 缺失或 profile 写不出来时**直接报错拒绝执行**，不静默降级；启动日志（debug）打印 `sandbox mode/network`
- 回归（真文件系统、真子进程，非 macOS 跳过）：工作区内可写、工作区外被拒、软链绕过被拒、改 `~/.zshrc` 被拒、
  `sh -c 'sh -c …'` 与 argv 形式同样受限、网络被拒、`prepareSandbox` 的 profile 权限与清理、
  `createNodeEnvFactory`（Harness 实际使用的工厂）接线生效、`PI_SANDBOX=off` 确实还原无沙箱
- README「工具与审批」「已知限制」、技术方案安全边界一节按实际边界重写（读不拦、TMPDIR 可写、不防工作区内破坏）
- 新增 `docs/沙箱方案.md`：内核沙箱怎么起作用、实测结果、Phase 2（tools worker，让文件工具也进内核边界）的设计与代价

- 侧栏「最近」：新建会话改成菜单第一行的整行按钮，下面才是列表（`会话` 改叫 `最近`）；
  空会话不进列表——它是「新建会话」的草稿，发第一条消息（落盘有标题）后才出现在「最近」里；
  当前会话还没开始过时再点「新建会话」无效（按钮不置灰，只是不再新建第二个空草稿）；
  切走一个没说过话的草稿时顺手物理删掉它，不在库里留看不见的死记录
- 新增 conversation 级 `app.activity` 文档（`{ at }`，契约测试锁定 kind/version/scope/fork）：
  pi-durable 的会话记录没有时间戳，`conv.submit` / `conv.fork` 成功后由 `SessionManager.touch()` 写一次墙钟时间
- `ConversationSummary` 加 `updatedAt`；`SessionManager.list()` 改成倒序扫描（超过 limit 时留住最新的那批），
  按 `updatedAt` 倒序返回，没有时间节点的（旧会话、还没说过话）排在后面、彼此按 id 倒序
- 侧栏每行右侧显示时间节点（`lib/time.ts`：刚刚 / N分钟前 / N小时前 / N天前 / M月D日，跨年补年份；
  `useNow` 30 秒走一次，不用每秒重渲染），侧栏宽 244 → 264px
- 回归：列表按活跃时间倒序且带时间节点、没有活跃记录时退回 id 倒序；侧栏渲染带上时间与 `now` 入参

### 变更

- shell 环境改为允许清单，并强制关闭 SDK 默认的宿主环境继承；宿主、`shellEnv` 和每次 `exec.env` 中的
  模型 API Key、云凭证、代理认证及解释器启动钩子不再自动传给命令，即使显式关闭 Seatbelt 也保留过滤
- Seatbelt 改用非登录 shell（zsh 加 `-f`）；默认拒绝读取常见凭证目录及其软链真实目标、dotenv 文件
  （普通 `.env.example` 除外），拒绝改写本应用的策略目录；网络放行不会解除这些限制。
  这不是完整读取隔离，未列出的敏感文件、进程内文件工具与工作区内破坏仍是明确边界
- 新增 `pnpm test:sandbox` 与 macOS CI 任务：覆盖真实写入/软链/子进程/网络限制、凭证隔离、策略失效、
  清理、取消与超时；使用明确测试文件名避免测试缺失时零用例通过，网络测试只访问本地服务器

- 助手在消息头里显示的名字从「助手」改为 **WorkPi**，并加粗（`font-bold` + `text-primary`，原来 12px/medium/次要色）
- 根会话现在也能删：`SessionManager.delete()` 去掉根会话保护（仍在「运行中」「有子会话」时拒绝）。
  根会话是 SDK 的 reserved id `1`，`purge` 会连 `record_ids` 登记行一起删，所以下次启动 `harness.root()`
  能用同一个 id 重新建一个空根会话；`SessionManager` 在开机时把根会话的模型记成 `#defaultModel`，
  新建会话按「显式指定 → 根会话当前模型 → 默认模型」取，根会话被删也不会让新会话没模型
- 界面的选中会话不再钉在根会话上：`useHost` 加 `loaded`，起始会话改成「列表拉到之后：根会话还在就选它，
  否则选「最近」第一条，一条都没有就留空」；删除当前会话时先刷新列表再清空选中，由同一个 effect 重新挑一条
  （顺序反了会拿旧列表把删掉的会话又选回来）
- 侧栏行的删除入口不再因为「是根会话」而置灰，只有「运行中」禁用
- 会话行右侧的删除按钮改为「…」下拉菜单（`ConversationMenu`）：**删除 / 置顶 / 重命名**。
  菜单以「…」为锚（左边缘对齐按钮、紧贴下沿，越界自动翻到上方/往里挪），用 `fixed` + `createPortal` 挂到
  `document.body`——侧栏带 `backdrop-blur` 会给 fixed 后代造新的包含块，留在行内会被整体偏移到离按钮很远的地方；
  点外面、按 Esc、列表滚动、窗口缩放都收起；运行中/根会话的删除项禁用，禁用时在项右侧直接写出原因
  （「根会话不能删」/「运行中不能删」——禁用的 `<button>` 不会弹 `title`，光靠悬浮提示等于没提示）。
  「…」图标加大到 20px、颜色从 tertiary 提到 secondary，`Icon` 新增 `strokeWidth` 入参（圆点直径就是描边宽度，`more` 用 2.8）
- 删除确认从「行内替换成一行文字 + 两个小按钮」改成贴着那一行的浮层卡片（`ConversationDeleteCard`）：
  「删除该会话？」+ 一句后果说明（聊天记录从本机一并清除、无法恢复）+ 取消 / 删除两个按钮，
  卡片左侧有小箭头指向该行；同样 `createPortal` 到 body，点外面 / Esc / 滚动都收起，默认焦点给「取消」
- 重命名在行内变成输入框：Enter 保存、Esc 取消、点别处保存；主进程 `conv.rename` 把名字写进
  conversation 级 `app.title` 并把 `from` 对齐第一条用户消息——这样后台摘要不会再覆盖它，
  上限 24 字（新常量 `RENAME_MAX_CHARS`），没有用户消息的会话拒绝重命名
- 置顶：新增 session 级 `app.pins` 文档（`{ pinned: number[] }`，契约测试锁定 kind/version/scope），
  `conv.pin` 置顶/取消置顶；`SessionManager.list()` 把置顶的排最前（置顶内部仍按活跃时间），
  `ConversationSummary` 加 `pinned`，置顶的行在标题前显示图钉
- 回归：`list` 的置顶排序与 `pinned` 标记、重命名覆盖标题且去除首尾空白、空会话拒绝重命名；
  侧栏行渲染的「…」菜单（`aria-haspopup="menu"`、按钮不嵌套）、时间节点、置顶图钉
- 助手回答的正文排版收紧：`MarkdownText` 正文 14px/28px → **15px/24px**（字号大一档、行高从 2.0 收到 1.6，中文一屏多看两三行）；行内代码 13 → 13.5px、表格 12 → 13px、小标题（h4–h6）14 → 15px 跟着对齐，代码块仍是 13px/20px
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

- 沙箱准备阶段必须确认工作区、临时目录和家目录是真实目录，拒绝文件系统根作为工作区；
  profile 写入失败会清理临时目录，环境清理先终止受管理进程，任一清理失败仍执行另一项并保留错误
- 文件路径检查在真实根、祖先解析失败、权限错误、断链或取消时拒绝，不再退回词法放行；
  去掉共享环境 id 的根缓存与固定八层祖先上限，仍允许安全的新文件、深层新目录和内部软链

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
