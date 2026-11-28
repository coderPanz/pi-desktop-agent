# Pi Agent Desktop

本机 Agent 工作台：对话、工具执行、界面状态全部落在本机一个可恢复的存储里。
模型在你自己的文件与命令上干活，而你能随时打断、重启、追溯。

- **不是聊天外壳**：每次回答、每次工具调用都是已写入库状态；进程被杀之后能接着跑。
- **不是云端 Agent**：只做本机文件、本机 shell、本地知识库三件事；副作用由你审批。
- **不是封闭产品**：预留三个定制面——扩展（工具/Task/Hook）、文档（`app.*` 业务状态）、UI。

> 架构与决策：[tech.md](./docs/知识中心/技术方案.md) ｜ 路线图：[ROADMAP.md](./docs/知识中心/ROADMAP.md) ｜ 工程约定：[AGENT.md](./AGENT.md) ｜ 变更：[CHANGELOG.md](./CHANGELOG.md)

## 现在能用什么

| 能力 | 状态 |
|---|---|
| 终端交互（发消息 / 中断 / 排队 / 分叉 / 重置 / 压缩 / 诊断） | ✅ `pnpm cli` |
| 持久化与重启恢复（SQLite + WAL） | ✅ 普通重启及本地模型下的真实进程强杀恢复已验证；未完成模型请求可能重新发起，未知结果的旧写入/bash 调用不自动重放 |
| 帧协议与副本同步（`FrameHub` → `ViewFrame` / `ViewSnapshot`） | ✅ CLI 与桌面均已接入 |
| 契约（IPC / 推送 / 错误码 / `app.*` 文档） | ✅ 代码里，见 `packages/shared-types`、`packages/shared-docs` |
| 工具（读 / 列目录 / 检索 / 写 / 改 / bash + 三档审批） | ✅ `coding` 扩展：`read` `list_dir` `grep` `glob` `write` `edit` `bash`，CLI 与桌面均可审批 |
| 桌面接线（Harness / IPC / 帧推送 / 审批） | ✅ root 会话已跑通真实模型与工具审批 |
| 聊天界面（消息、工具卡、审批、排队、流式、Markdown） | ✅ Apple 风格浅色工作区；代码块用 Shiki 高亮（带语言标签与复制）；状态刷新与体验细节待补 |
| 会话管理（新建 / 分叉 / 压缩 / 重置 / 删除） | ✅ 侧栏第一行是「新建会话」，下面「最近」按活跃时间倒序（行右侧显示时间节点），按分叉关系显示为树、可折叠；行标题是第一条用户消息（超 10 字后台摘要一次，可手动重命名）；空会话不进列表（发第一条消息才带出）；行尾「…」菜单删除 / 置顶 / 重命名，删除是物理删除（不可恢复） |
| 默认启动 / 新建会话 / 终态失败提示 | ✅ 开发目录加载 `.env`，新建默认使用 root 模型，终态失败可跨重启展示 |
| 模型设置与密钥 | ✅ 环境变量优先；其次应用内配置。密钥经 Electron safeStorage 加密存 `userData`，不落 SQLite、不回显；保存后只影响新会话，空模型旧会话（含根）补默认模型 |

主进程持有 `HarnessHost`，渲染进程通过 `window.pi.invoke` 走 IPC、靠推送拿已提交状态。
CLI 与桌面共用 `@pi/core`。默认对话链路、宿主失效处理、强杀恢复与模型设置已接入；安装包验收仍见 ROADMAP。

## 快速开始

```bash
pnpm install                                  # 首次会下载 Electron 二进制（见「故障排查」）
cp .env.example .env                          # 填 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / ANTHROPIC_MODEL

pnpm cli                                      # 终端交互，数据落在 ./.data
pnpm cli --memory                             # 内存库，不写文件（验收与排障用）
pnpm cli --data-dir /tmp/pi-demo              # 指定数据根
PI_DATA_DIR=/tmp/pi-demo pnpm dev             # 桌面自动读根目录 .env，指定独立数据根
pnpm build && pnpm start                      # 桌面构建产物，同样自动加载 .env
pnpm cli -p "看一下 package.json 有哪些脚本"    # 一次性提问后退出
```

引擎要求：Node `>=22.19.0`、pnpm `>=10`（`packageManager: pnpm@10.30.3`）。

### 终端命令

```
/new            新建会话          /list           列出会话
/switch <id>    切换会话          /fork           从最新条目分叉
/abort          中断当前回答      /reset [说明]   清空上下文
/compact [说明] 压缩上下文        /inspect        打印诊断摘要
/help           帮助             /quit           退出（Ctrl+D 同效）
```

`Ctrl+C` 只中断当前回答，不退出进程。其他输入一律作为消息提交给模型。

### 工具与审批

模型能用的工具：`read`、`list_dir`、`grep`、`glob`、`write`、`edit`、`bash`。

### 项目上下文

`coding` 扩展会把工作区的约定注入 system prompt（每次请求前渲染，不落库）：

- `AGENTS.md`（截到 4000 字，模型需要全文可自己 `read`）
- `package.json` 的项目名与脚本（最多 20 条，提示「用 bash 执行」）
- 顶层结构（最多 40 项，跳过 `node_modules`/`.git`/构建产物）

按文件 mtime 缓存，改了约定下次请求就生效；工作区什么都没有时不注入（不占上下文）。

`grep` / `glob` 是只读检索：只遍历工作区（跳过 `node_modules`、`.git`、构建产物与软链）、
跳过二进制与超大文件，默认按字面子串匹配（`regex: true` 才当正则）。它们与 `read`/`list_dir` 一样直接放行，
崩溃后可安全重跑。会遵守工作区**根** `.gitignore` 的常见规则（注释、目录、名字、锚定路径、`*`/`**`/`?`）；
**不支持 `!` 取反**，嵌套 `.gitignore` 不生效——这类情况按“多扫”处理，不会漏扫。

检索有上限：最多 5000 个文件、单文件 512KB、200 条结果；命中被截断时会在 `diagnostics` 里说明。

工作区（`<数据根>/workspace`）是工具的根目录：相对路径按它解析，`read`/`list_dir`/`write`/`edit` 的路径必须落在它里面（越界路径与指向外面的软链一律拒绝），`bash` 的起点 cwd 也是它。

`bash` 再叠一层**内核沙箱**（macOS Seatbelt，`packages/core/src/agent/sandbox.ts`）：命令的整棵进程树都跑在
`sandbox-exec` 的策略下——写只允许工作区与临时目录，网络默认拒绝，`cd ..` 后再写、`sh -c 'sh -c …'`、
通过软链绕出去都会被内核拒掉（`Operation not permitted`）。开关：`PI_SANDBOX=seatbelt|off`（macOS 默认开）、
`PI_SANDBOX_NET=allow`（默认 deny）。沙箱不可用（缺 `sandbox-exec`）时**拒绝执行 bash**，不静默降级。
命令环境只继承 PATH、HOME、语言、临时目录等运行变量，不继承宿主模型 API Key、云凭证、代理或解释器启动钩子；
PATH 会在系统目录后补常见安装位置（Homebrew、`~/.local/bin`、nvm/fnm 各版本、`~/Library/pnpm` 等，只取真实存在的目录），
这样从 Finder 启动的打包应用也能找到 `node` / `pnpm`，但**不执行任何 rc 脚本**；
此过滤在 `PI_SANDBOX=off` 时也保留。Seatbelt 使用非登录 shell（zsh 加 `-f`），不自动加载用户登录配置。
读取额外屏蔽 `~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.azure`、`~/.kube`、`~/.config/gcloud`、`~/.config/gh`
及 `.env` / `.env.*`（普通 `.env.example` 除外）；凭证目录软链的真实目标也屏蔽。
因此 git/云工具不能直接借用这些本机登录态，`PI_SANDBOX_NET=allow` 也不会解除读取限制。
方案与边界见 [`docs/沙箱方案.md`](docs/沙箱方案.md)。

审批分三档：

| 档 | 工具 | 行为 |
|---|---|---|
| `allow` | `read`、`list_dir`、`grep`、`glob`、工作区内 `write` / `edit`、只读命令（`ls` / `cat` / `git status` …） | 直接执行 |
| `ask` | 其余命令（含 `bash` 写重定向、`git push` 等） | 终端提示 `审批请求：… 允许这一次执行吗？[y/N]`，输 `y` 放行 |
| `deny` | 抹盘、关机、根级删除、fork 炸弹 | 不执行，给模型一条拒绝说明 |

**coding 流程默认信任工作区**：`write` / `edit` 不再逐个弹审批，改完由用户 review。
放宽的只是「问不问人」，边界没变——路径仍按工作区校验，工作区外的写入照样被拒（绝对路径、`..` 逃逸都实测拒绝）。
`bash` 仍走三档：它能跑任意命令，没有等价的内核保证，所以保留事前确认。
需要恢复逐个确认时，给扩展传 `trustWorkspaceWrites: false`。

非交互（管道输入、`-p`、`pnpm smoke`）时 `ask` 一律按**拒绝**处理：没人能回答的问题不该假装有人回答。

## 命令一览

| 命令 | 作用 |
|---|---|
| `pnpm cli` | 终端入口（无 Electron） |
| `pnpm smoke` | 端到端冒烟：真实装配 + 跑几条 REPL 命令，不联网、不需要凭证 |
| `pnpm typecheck` | 两套 tsconfig：Node 侧（packages + cli）+ desktop 侧（含 renderer） |
| `pnpm lint` | ESLint，含两条导入边界 |
| `pnpm gate` | 存储门禁：Electron 内置 Node 版本 + `node:sqlite` 真实建库读写 |
| `pnpm dev` | Vite dev server + esbuild watch + 拉起 Electron |
| `pnpm build` | 构建 `dist/{main,preload,renderer}` |
| `pnpm start` | 跑已构建产物（需先 `build`） |
| `pnpm package` | electron-builder 出 dmg/nsis（需要网络下载工具） |
| `pnpm package:dir` | 只出未压缩 `.app`，约 2 分钟，适合开发与验收 |

### 本轮改动卡片

每次提交后，消息列表末尾会出现「本轮改动」卡片：

- git 仓库：显示 `N 个文件 +x −y`，展开看文件行，**点某个文件才拉 patch**（diff 现算，不落盘）
- 非 git 仓库：列出本轮触达的路径，并提示「当前工作区不在 git 仓库，无法显示 diff」
- 点文件名即进入**内联编辑态**（读出来就能改），停止输入约 1 秒自动保存（连续打字 5 秒强制落盘一次，
  内容没变不写）；`>512KB` 的文件不自动保存，改为 `⌘S` 手动保存；再点一次收起。
  只允许工作区内、文本、≤2MB；自动保存用 mtime 做乐观锁，磁盘被 Agent 改过时暂停保存并提示冲突，
  由用户选择「覆盖磁盘」或「重新加载」。写盘是「临时文件 + rename」的原子替换，
  中途失败/磁盘满不会留下半截文件
- 每个文件可「撤销」到本轮基线（两步确认）：已跟踪文件回到基线版本，**本轮新增的文件会被删除**；
  非 git 工作区不支持撤销

基线用 `git stash create` 记录（干净时回退 `HEAD`），每轮只存一个 hash，不存 diff。

## 数据布局

数据根由调用方注入（CLI 用 `--data-dir`，桌面用 `app.getPath("userData")`）：

```
<root>/
├─ session.sqlite    对话与文档（WAL 单文件库）
├─ workspace/        模型可读写的工作区（工具默认 cwd）
├─ tools/            自举工具安装目录
└─ logs/             结构化日志
```

约定：**存储失败不降级**到内存库——失败必须显式可见，否则「数据没写入库」会被误当成「功能正常」。
一个库文件只允许一个 Harness（单写者），这里不做跨进程锁。

## 架构

```
renderer ──▶ shared-types                     （只读副本 + IPC，不碰存储）
preload  ──▶ shared-types
main     ──▶ core ──▶ shared-docs / shared-types ──▶ extensions/*
core     ──▶ pi-durable / pi-ai / chord       （禁止 import electron）
cli      ──▶ core / shared-types
```

边界由 ESLint `no-restricted-imports` 机器强制，不靠人记：

| 范围 | 禁止 import | 原因 |
|---|---|---|
| `apps/desktop/src/renderer/**` | `electron`、`node:*`、`pi-durable`、`@pi/core`、`@pi/shared-docs` | 渲染进程不得持有 Harness，一律走 `window.pi` |
| `packages/**`、`apps/cli/**` | `electron` | core / 扩展 / CLI 必须能被纯 Node 脚本验收 |

### 契约在哪里

| 契约 | 位置 |
|---|---|
| 帧协议、副本结构、内置 kind 常量 | `packages/shared-types/src/frame.ts` |
| 命令通道（`invoke` ↔ `handle`） | `packages/shared-types/src/ipc.ts` |
| 推送通道（`send` ↔ `on`） | `packages/shared-types/src/push.ts` |
| 业务视图模型（会话摘要 / 工具展示 / 宿主状态） | `packages/shared-types/src/domain.ts` |
| 错误码与封套 | `packages/shared-types/src/errors.ts` |
| `app.*` 文档与条目定义 | `packages/shared-docs/src/*` |

**kind 一旦写入库就是契约**：`pi.user` / `pi.assistant` / `app.settings` 这类字符串改名等于让旧数据读不出来。
修改这些值必须核对已保存数据的兼容性，并提供迁移或明确接受旧数据不可读；不新增测试文件。

### 三层运行时

1. **storage → open → root/补配置 → resume**：恢复任务前先准备模型，启动顺序可日志化（`PI_LOG_LEVEL=debug`）。
2. **SessionManager**：会话操作（submit / abort / fork / reset / compact / inbox / view），只返回数据、不打印，CLI 与桌面 IPC 共用。
3. **FrameHub**：把「会话视图变了」变成 `(convId, seq, ops)`，`open()` 不补发历史，每会话 seq 单调 +1。

## 配置

CLI 与未打包桌面会加载根目录 `.env`（不入库），已导出的环境变量优先。

桌面还可以在右上角「模型」里填模型 id、网关地址和 API Key：
环境变量优先（此时面板锁定）；没有环境变量时用应用内配置，密钥用 Electron safeStorage 加密存到
`<数据根>/model-key.bin`（0600），不写 SQLite、不回显。保存后**只影响新会话**，已有会话保持原模型；
缺模型的旧会话（含根会话）会补一次默认模型，不覆盖已有选择。系统密钥链不可用时明确报错，不会退回明文。

`.env` 里的变量：

| 变量 | 必需 | 说明 |
|---|---|---|
| `ANTHROPIC_API_KEY` | 是 | 网关 API key，每次请求时解析 |
| `ANTHROPIC_BASE_URL` | 否 | 默认 `https://api.anthropic.com` |
| `ANTHROPIC_MODEL` | 是 | 网关支持的模型 id。不猜模型；缺配置或模型不可用时不能生成回答 |
| `PI_LOG_LEVEL` | 否 | `debug` 时把启动链路打到 stderr |
| `PI_FAIL_STORAGE_COUNT` | 否 | 开发验收用：前 n 次提交输入时故意落库失败，以验证失效与重启恢复；注入后写标记，重启不再注入 |
| `PI_CRASH_POINT` | 否 | 开发故障注入：`after-submit` / `during-tool` / `after-tool-result` / `mid-generation` / `between-phases`；命中真实运行阶段后强杀进程，恢复前必须清除该变量 |
| `PI_DEV_SERVER_URL` | 否 | 由 `pnpm dev` 注入 |

模型网关走 Anthropic Messages 协议，并自带两个请求头（`user-agent: claude-cli/…`、`x-app: cli`）——
非 Claude Code 的客户端会被网关 403。

## 开发

```bash
pnpm typecheck && pnpm lint && pnpm smoke && pnpm build   # 提交前例行
```

改动前请读 [AGENT.md](./AGENT.md)（名字是契约、先提交后展示、主进程唯一写者、错误按范围分级）。
CI 在 `.github/workflows/ci.yml`：`verify` 跑类型检查、lint 与 CLI 冒烟，`desktop` 验证构建产物。
项目不维护 `.test.*`、`.spec.*` 或专用测试 fixture，不为功能自动补测试文件或测试 npm/CI 任务；
涉及存储恢复、工具副作用和安全边界时，另做必要的手动验证，未验证能力明确标注。

core 的分层与边界见 [`packages/core/README.md`](./packages/core/README.md)；
终端入口的参数、REPL 命令与退出码见 [`apps/cli/README.md`](./apps/cli/README.md)。

## 故障排查

**模型调用 403 / 401**：网关只认 Claude Code 的客户端标识。先用 `curl` 带上同样的头验证，
再怀疑代码；`baseUrl` 要不要带 `/v1` 用 `curl` 定，不要猜。

**`pnpm install` 后 Electron 二进制缺失**（`apps/desktop/node_modules/electron/dist` 不存在）：
本机无法直连 GitHub releases，`.npmrc` 已切到 npmmirror。

```bash
cd apps/desktop/node_modules/electron && node install.js
```

**`--memory` 与 `--data-dir` 同时传**：互斥，参数解析会直接报错——前者不写文件、后者要写文件。

**桌面窗口白屏**：主进程 `did-finish-load` / `did-fail-load` 会打日志；`PI_DEV_SERVER_URL` 未注入时
加载的是 `dist/renderer/index.html`，需要先 `pnpm build`。

**存储失败**：桌面进入不可用状态，停止发送、审批和会话操作，保留已加载历史副本，并提供「重启应用」入口。
CLI 会主动结束等待并以失败码退出。重启是重新打开存储，不是重试单次写入或降级到内存库；
如果工具结果未知，应先检查工作区副作用再决定是否执行新操作。

## 已知限制

- 打包后的应用不自动寻找开发仓库 `.env`，需显式注入环境配置；安装包的配置入口与运行行为尚未验收。
- 已有会话的非空模型配置不被环境变量覆盖；更换模型仍缺少桌面设置入口。旧版留下的非 root 空模型会话尚不自动迁移，可使用新建会话。
- 会话列表的忙碌/排队状态不会随任务结束自动刷新。
- 侧栏标题要花一次模型调用（只有第一条用户消息超过 10 字时）：没配模型或调用失败时退回截断的原文，不会重试。
- 时间节点是这份功能上线后自己记的（`app.activity`）：`pi-durable` 不存墙钟时间，所以更早的旧会话没有时间、
  排在「最近」末尾，等它再次提交输入后才有。
- 「删除会话」是物理删除、不可恢复：`pi-durable` 没有删除接口，这里自己开一条 SQLite 连接在事务里级联删掉
  条目 / 任务 / 提交 / 文档（`packages/core/src/storage/purge.ts`）。正在运行、还有子会话的会话不可删除；
  `--memory` 与测试用的内存库没有 SQL 后端，退回「从列表移除」。
- 根会话（SDK 的 reserved id `1`）也可以删：删除会连 `record_ids` 登记行一起清掉，下次启动 `harness.root()`
  用同一个 id 重新建一个空根会话。界面不依赖它必须存在（起始会话优先选它，不存在就退到「最近」第一条），
  新建会话的默认模型开机时就记住了，不依赖根会话的 agent 文档还在。
- 失效恢复只支持应用重启，不做进程内热重建；重启不能自动修复磁盘满、损坏的数据库等底层问题。
- 强杀恢复在本地模型与真实 SQLite 下验证，真实远程模型及安装包仍需单独验收；未完成模型请求可能重发，不能保证远端调用恰好一次。
- 桌面主进程把 `@earendil-works/*` 留在打包产物外面（esbuild 内联会破坏它们的 ESM 循环引用，
  实测 `InMemoryCredentialStore is not a constructor`），所以 `electron-builder.yml` 必须把生产
  `node_modules` 一起打进 asar；否则应用只能在仓库里跑，拷贝后就找不到依赖。
- `bash` 不是完整读取白名单：只额外屏蔽常见凭证目录和 dotenv，其他位置的敏感文件仍可能被读取并通过工具输出交给模型。
  禁止命令联网不等于杜绝信息外传。临时目录（包括较宽的 `/private/var/folders` 例外）仍可写，
  但本应用 `pi-sandbox-*` 策略目录不可被命令改写；工作区内破坏仍需审批、版本控制和备份。
- 内联编辑的手动保存阈值是 **512KB**：再大就只能 `⌘S`，此时没有自动保存兜底，忘记按会丢改动；
  应用内编辑上限 2MB，超过请用系统程序打开。
- 「本轮撤销」只按**最近一轮**的 git 基线：更早的轮次基线已被覆盖，不能逐轮回滚；非 git 工作区不可用。
- 文件工具仍是应用层检查，真实路径解析失败、断链或取消时拒绝操作，但检查与实际 I/O 之间仍有竞态窗口。
  进程收尾沿用 SDK 的进程组管理，不保证终止主动脱离进程组的程序；运行不可信插件需更强的隔离机制。
- 沙箱用的是 Apple 的 **deprecated API** `sandbox-exec`（macOS 26.2 实测可用）：将来被移除后需要走容器/VM 路线
  （`docs/沙箱方案.md` §3）。进程内文件工具（`write`/`edit`）走的是应用层路径边界，不在内核沙箱里
  （理由与 Phase 2 的 tools worker 计划见同一文档）。
- 打包状态：`pnpm package:dir` 约 2 分钟产出 `.app`（`npmRebuild: false`，只出应用不做 DMG）。
  已在产物内验证：`node:sqlite`、safeStorage 加密密钥、Seatbelt 沙箱、无 `.env` 的首次配置与真实对话、
  清除密钥后继续生成。DMG 仍受网络限制（下载 dmgbuild 超时），发布时再出。
- V1 不做：多窗口写同一会话、云端同步、多进程打开同一 SQLite、插件市场、移动端。
