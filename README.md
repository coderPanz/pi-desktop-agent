# Pi Agent Desktop

本机 Agent 工作台：对话、工具执行、界面状态全部落在本机一个可恢复的存储里。
模型在你自己的文件与命令上干活，而你能随时打断、重启、追溯。

- **不是聊天外壳**：每次回答、每次工具调用都是已落盘状态；进程被杀之后能接着跑。
- **不是云端 Agent**：只做本机文件、本机 shell、本地知识库三件事；副作用由你审批。
- **不是封闭产品**：预留三个定制面——扩展（工具/Task/Hook）、文档（`app.*` 业务状态）、UI。

> 架构与决策：[tech.md](./docs/知识中心/技术方案.md) ｜ 路线图：[ROADMAP.md](./docs/知识中心/ROADMAP.md) ｜ 工程约定：[AGENT.md](./AGENT.md) ｜ 变更：[CHANGELOG.md](./CHANGELOG.md)

## 现在能用什么

| 能力 | 状态 |
|---|---|
| 终端交互（发消息 / 中断 / 排队 / 分叉 / 重置 / 压缩 / 诊断） | ✅ `pnpm cli` |
| 持久化与重启恢复（SQLite + WAL，重开同一数据根接着用） | ✅ |
| 帧协议与副本同步（`FrameHub` → `ViewFrame` / `ViewSnapshot`） | ✅ 契约已落地，消费方是 CLI |
| 契约（IPC / 推送 / 错误码 / `app.*` 文档） | ✅ 代码里，见 `packages/shared-types`、`packages/shared-docs` |
| 工具（读写文件 / bash / 审批） | ⬜ 扩展包为空，注册表当前装 0 个工具 |
| 桌面界面（Harness 接线 / IPC / 聊天 UI） | ⬜ 主进程只有窗口与安全配置 |

桌面应用目前**还不能对话**：主进程尚未持有 `HarnessHost`，`window.pi` 只有 `debug.ping`。
需要完整能力时先用终端入口；两者的运行时是同一套 `@pi/core`。

## 快速开始

```bash
pnpm install                                  # 首次会下载 Electron 二进制（见「故障排查」）
cp .env.example .env                          # 填 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / ANTHROPIC_MODEL

pnpm cli                                      # 终端交互，数据落在 ./.data
pnpm cli --memory                             # 内存库，不落盘（验收与排障用）
pnpm cli --data-dir /tmp/pi-demo              # 指定数据根
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

约定：**存储失败不降级**到内存库——失败必须显式可见，否则「数据没落盘」会被误当成「功能正常」。
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

**kind 一旦落盘就是契约**：`pi.user` / `pi.assistant` / `app.settings` 这类字符串改名等于让旧数据读不出来。
`packages/shared-docs/src/contracts.test.ts` 用断言把这些值钉住，改它必须是有意识的决定。

### 三层运行时

1. **storage → open → resume → root**：启动顺序固定且可日志化（`PI_LOG_LEVEL=debug`）。
2. **SessionManager**：会话操作（submit / abort / fork / reset / compact / inbox / view），只返回数据、不打印，CLI 与将来的 IPC 共用。
3. **FrameHub**：把「会话视图变了」变成 `(convId, seq, ops)`，`open()` 不补发历史，每会话 seq 单调 +1。

## 配置

`.env`（不入库）里的变量：

| 变量 | 必需 | 说明 |
|---|---|---|
| `ANTHROPIC_API_KEY` | 是 | 网关 API key，每次请求时解析 |
| `ANTHROPIC_BASE_URL` | 否 | 默认 `https://api.anthropic.com` |
| `ANTHROPIC_MODEL` | 是 | 网关支持的模型 id。缺它会直接报错，不猜模型 |
| `PI_LOG_LEVEL` | 否 | `debug` 时把启动链路打到 stderr |
| `PI_CRASH_POINT` | 否 | 崩溃埋点（`after-submit` / `during-tool` / …），命中即 `SIGKILL` |
| `PI_DEV_SERVER_URL` | 否 | 由 `pnpm dev` 注入 |

模型网关走 Anthropic Messages 协议，并自带两个请求头（`user-agent: claude-cli/…`、`x-app: cli`）——
非 Claude Code 的客户端会被网关 403。

## 开发

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm smoke   # 提交前例行
```

改动前请读 [AGENT.md](./AGENT.md)（名字是契约、先提交后展示、主进程唯一写者、错误按范围分级）。
ci 在 `.github/workflows/ci.yml`：`verify` 跑四项检查，`desktop` 单独验证构建产物。

core 的分层与边界见 [`packages/core/README.md`](./packages/core/README.md)。

## 故障排查

**模型调用 403 / 401**：网关只认 Claude Code 的客户端标识。先用 `curl` 带上同样的头验证，
再怀疑代码；`baseUrl` 要不要带 `/v1` 用 `curl` 定，不要猜。

**`pnpm install` 后 Electron 二进制缺失**（`apps/desktop/node_modules/electron/dist` 不存在）：
本机无法直连 GitHub releases，`.npmrc` 已切到 npmmirror。

```bash
cd apps/desktop/node_modules/electron && node install.js
```

**`--memory` 与 `--data-dir` 同时传**：互斥，参数解析会直接报错——前者不落盘、后者要落盘。

**桌面窗口白屏**：主进程 `did-finish-load` / `did-fail-load` 会打日志；`PI_DEV_SERVER_URL` 未注入时
加载的是 `dist/renderer/index.html`，需要先 `pnpm build`。

## 已知限制

- 桌面应用还不能对话：无 `HarnessHost`、无 IPC 契约实现、渲染进程是骨架页。
- 工具链未接通：`packages/extensions/*` 是空包，注册表装 0 个扩展，模型没有工具可用。
- `pnpm package` 从未跑过；Electron 打包后 `node:sqlite` 的 ABI 与 asar 内动态 import 都未验证。
- V1 不做：多窗口写同一会话、云端同步、多进程打开同一 SQLite、插件市场、移动端。
