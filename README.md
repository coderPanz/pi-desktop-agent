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
| 持久化与普通重启恢复（SQLite + WAL） | ✅ 历史与文件已实测恢复；执行中强杀恢复尚未验收 |
| 帧协议与副本同步（`FrameHub` → `ViewFrame` / `ViewSnapshot`） | ✅ CLI 与桌面均已接入 |
| 契约（IPC / 推送 / 错误码 / `app.*` 文档） | ✅ 代码里，见 `packages/shared-types`、`packages/shared-docs` |
| 工具（读 / 列目录 / 写 / 改 / bash + 三档审批） | ✅ `coding` 扩展，CLI 与桌面均可审批 |
| 桌面接线（Harness / IPC / 帧推送 / 审批） | ✅ root 会话已跑通真实模型与工具审批 |
| 聊天界面（消息、工具卡、审批、排队、流式、Markdown） | ✅ Apple 风格浅色工作区；代码块用 Shiki 高亮（带语言标签与复制）；状态刷新与体验细节待补 |
| 会话管理（新建 / 分叉 / 压缩 / 重置 / 删除） | ✅ 侧栏按分叉关系显示为树，可折叠；删除是物理删除（不可恢复） |
| 默认启动 / 新建会话 / 终态失败提示 | ✅ 开发目录加载 `.env`，新建默认使用 root 模型，终态失败可跨重启展示 |

主进程持有 `HarnessHost`，渲染进程通过 `window.pi.invoke` 走 IPC、靠推送拿已提交状态。
CLI 与桌面共用 `@pi/core`。默认对话链路已跑通；存储失败恢复、执行中强杀与安装包验收仍见 ROADMAP。

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

模型能用的工具：`read`、`list_dir`、`write`、`edit`、`bash`。

工作区（`<数据根>/workspace`）是工具的根目录：相对路径按它解析，`read`/`list_dir`/`write`/`edit` 的路径必须落在它里面（越界路径与指向外面的软链一律拒绝），`bash` 的起点 cwd 也是它。但这不是沙箱：`bash` 里 `cd ..` 能碰到外面，那一步靠审批。

审批分三档：

| 档 | 工具 | 行为 |
|---|---|---|
| `allow` | `read`、`list_dir`、只读命令（`ls` / `cat` / `git status` …） | 直接执行 |
| `ask` | `write`、`edit`、其余命令 | 终端提示 `审批请求：… 允许这一次执行吗？[y/N]`，输 `y` 放行 |
| `deny` | 抹盘、关机、根级删除、fork 炸弹 | 不执行，给模型一条拒绝说明 |

非交互（管道输入、`-p`、`pnpm smoke`）时 `ask` 一律按**拒绝**处理：没人能回答的问题不该假装有人回答。

## 命令一览

| 命令 | 作用 |
|---|---|
| `pnpm cli` | 终端入口（无 Electron） |
| `pnpm smoke` | 端到端冒烟：真实装配 + 跑几条 REPL 命令，不联网、不需要凭证 |
| `pnpm test` | 单元测试（契约、core、CLI 解析与渲染） |
| `pnpm typecheck` | 两套 tsconfig：Node 侧（packages + cli）+ desktop 侧（含 renderer） |
| `pnpm lint` | ESLint，含两条导入边界 |
| `pnpm gate` | 存储门禁：Electron 内置 Node 版本 + `node:sqlite` 真实建库读写 |
| `pnpm dev` | Vite dev server + esbuild watch + 拉起 Electron |
| `pnpm build` | 构建 `dist/{main,preload,renderer}` |
| `pnpm start` | 跑已构建产物（需先 `build`） |
| `pnpm package` | electron-builder 打包 dmg/nsis（尚未冒烟） |

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
`packages/shared-docs/src/contracts.test.ts` 用断言锁定这些值，改它必须是有意识的决定。

### 三层运行时

1. **storage → open → root/补配置 → resume**：恢复任务前先准备模型，启动顺序可日志化（`PI_LOG_LEVEL=debug`）。
2. **SessionManager**：会话操作（submit / abort / fork / reset / compact / inbox / view），只返回数据、不打印，CLI 与桌面 IPC 共用。
3. **FrameHub**：把「会话视图变了」变成 `(convId, seq, ops)`，`open()` 不补发历史，每会话 seq 单调 +1。

## 配置

CLI 与未打包桌面会加载根目录 `.env`（不入库），已导出的环境变量优先。修改 `.env` 后重启应用。
root 缺模型时启动会补配置，已有模型选择不覆盖；新建会话默认取 root 模型，分叉沿用父会话配置。

`.env` 里的变量：

| 变量 | 必需 | 说明 |
|---|---|---|
| `ANTHROPIC_API_KEY` | 是 | 网关 API key，每次请求时解析 |
| `ANTHROPIC_BASE_URL` | 否 | 默认 `https://api.anthropic.com` |
| `ANTHROPIC_MODEL` | 是 | 网关支持的模型 id。不猜模型；缺配置或模型不可用时不能生成回答 |
| `PI_LOG_LEVEL` | 否 | `debug` 时把启动链路打到 stderr |
| `PI_CRASH_POINT` | 否 | 已定义检查点名称与 `SIGKILL` 函数，但运行链路尚未调用；仅设置变量不会触发 |
| `PI_DEV_SERVER_URL` | 否 | 由 `pnpm dev` 注入 |

模型网关走 Anthropic Messages 协议，并自带两个请求头（`user-agent: claude-cli/…`、`x-app: cli`）——
非 Claude Code 的客户端会被网关 403。

## 开发

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm smoke   # 提交前例行
```

改动前请读 [AGENT.md](./AGENT.md)（名字是契约、先提交后展示、主进程唯一写者、错误按范围分级）。
ci 在 `.github/workflows/ci.yml`：`verify` 跑四项检查，`desktop` 单独验证构建产物。

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

## 已知限制

- 打包后的应用不自动寻找开发仓库 `.env`，需显式注入环境配置；安装包的配置入口与运行行为尚未验收。
- 已有会话的非空模型配置不被环境变量覆盖；更换模型仍缺少桌面设置入口。旧版留下的非 root 空模型会话尚不自动迁移，可使用新建会话。
- 会话列表的忙碌/排队状态不会随任务结束自动刷新。
- 「删除会话」是物理删除、不可恢复：`pi-durable` 没有删除接口，这里自己开一条 SQLite 连接在事务里级联删掉
  条目 / 任务 / 提交 / 文档（`packages/core/src/storage/purge.ts`）。根会话、正在运行、还有子会话的会话不可删除；
  `--memory` 与测试用的内存库没有 SQL 后端，退回「从列表移除」。
- 宿主尚未监听 `HarnessHost.closed` 的存储失败结果，界面没有完整的不可用/恢复状态。
- 桌面主进程把 `@earendil-works/*` 留在打包产物外面（esbuild 内联会破坏它们的 ESM 循环引用，
  实测 `InMemoryCredentialStore is not a constructor`）；打包时需要确认 electron-builder 带上这些依赖。
- `bash` 本身可以 `cd` 到工作区外（边界检查只管 cwd 的起点），靠审批阑住；V1 不宣称沙箱。
- `pnpm package` 从未跑过；Electron 打包后 `node:sqlite` 的 ABI 与 asar 内动态 import 都未验证。
- V1 不做：多窗口写同一会话、云端同步、多进程打开同一 SQLite、插件市场、移动端。
