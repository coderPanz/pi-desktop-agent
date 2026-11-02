# Pi Agent Desktop
后续的聊天界面可接入： https://ai.explore.poker/ 的联想式卡片思维聊天界面

一个**本机 Agent 工作台**：对话、工具执行、知识沉淀、界面状态全部落在本机一个可恢复的存储里。
模型在你自己的文件与命令上干活，而你能随时打断、重启、追溯。

> 工程方案：[docs/知识中心/技术方案.md](./docs/知识中心/技术方案.md) ｜ 开发路线：[docs/知识中心/V1开发路线.md](./docs/知识中心/V1开发路线.md) ｜ 笔记：[docs/notes/](./docs/notes/) ｜ 项目约定：[AGENT.md](./AGENT.md)

## 一期定位

- **不是聊天外壳**：每次回答、每次工具调用、每个任务都是已落盘状态；进程被杀之后能接着跑。
- **不是 RPA / 云端 Agent**：只做本机文件、本机 shell、本地知识库三件事；副作用由你审批。
- **不是封闭产品**：预留三个定制面——扩展（工具/Task/Hook）、文档（`app.*` 业务状态）、UI（TokUI 卡片）。

做：对话与流式、工具执行与审批、崩溃恢复、桌面界面、本地知识库、工具自举、生成式 UI。
不做：多用户协作、云端同步、移动端、插件市场、工具沙箱、向量检索、多窗口写入。

## 当前状态

状态口径：**✅ 已实测通过** ｜ **🟡 代码已就绪、验收门未跑** ｜ **⬜ 未开始**

| 阶段 | 主题 | 状态 | 实情 |
|---|---|---|---|
| S0 | 工作区与最小 Agent 调用 | ✅ | G0 六项通过；脚本已移出工作区，`git checkout 40c5343 -- docs/verify` 可取回 |
| — | 存储门禁 G2（`node:sqlite`） | ✅ | `pnpm gate`：Electron 45.0.0 / Node 24.22.0，真实文件建表读写 + WAL 通过 |
| — | 桌面壳 + preload 桥接 + 构建链 | ✅ | `pnpm build` 产出 `dist/{main,preload,renderer}`；渲染页显示 `window.pi.debug.ping() → pong`；`contextIsolation`/`sandbox` 已开 |
| — | `packages/core` S3/S4 模块 | 🟡 | 11 个模块 + 25 条 `node:test`（含真实 SQLite 写入/重开读回）；**交互验收未做**，因为还没有 CLI 入口 |
| S1 | 流式输出与状态订阅 | ⬜ | `FrameHub` 已能对外推 `(convId, seq, ops)`，但没有任何消费方 |
| S2 | 工具调用与可视化 | ⬜ | `@pi/ext-coding` 仍是空壳，注册表可装 0 个扩展 |
| S3 | 中断、排队与多会话 | 🟡 | `SessionManager` 就绪（new/list/select/submit/abort/fork/reset/compact/inbox/view）；`apps/cli` 未接，G3 七场景未跑 |
| S4 | SQLite 持久化与崩溃恢复 | 🟡 | `createStorage` / `HarnessHost` / `FrameHub` / `inspect` / `crashPoint` 就绪；五类崩溃场景未跑 |
| S5 | Electron 主进程与 IPC | ⬜ | 只有窗口、单实例锁、安全配置；`HarnessHost` 未接进主进程，无 IPC 契约 |
| S6 | 渲染进程 replica 与聊天 UI | ⬜ | 渲染进程目前是一张骨架页 |
| S7 | 知识库 | ⬜ | 与 S6 并行 |
| S8 | 工具自举闭环 | ⬜ | 与 S6 并行 |
| S9 | 智能 UI | ⬜ | `@jboltai/tokui` 已锁版本，未接入 |

**下一步是接线，不是新写模块**：把 `apps/cli` 接上 `@pi/core`，用 `--memory` / `--data-dir` 跑完 G3 七场景，`SessionManager` 才算真的能停、能排队、能分叉——也是阶段 5 原样复用它的前提。

## 目录

```
.
├─ apps/
│  ├─ cli/                        无 Electron 终端入口（S3）—— 目前只有占位文件
│  │  └─ src/main.ts
│  └─ desktop/                    Electron 外壳
│     ├─ build/build.ts           构建编排：main=ESM(mjs) / preload=CJS(cjs) / renderer=Vite
│     ├─ vite.config.ts           root=src/renderer，base=./，Tailwind 4 + React
│     ├─ electron-builder.yml     打包（asar，排除 node_modules）
│     ├─ tsconfig.json
│     └─ src/
│        ├─ main/index.ts         单实例锁 + 安全窗口四项 + macOS 生命周期
│        ├─ main/gate.ts          存储门禁 G2（node 版本 + node:sqlite 真实读写）
│        ├─ preload/index.ts      contextBridge 暴露 window.pi（当前只有 debug.ping）
│        └─ renderer/             React 19 + Tailwind 4 骨架页（index.html 带 CSP）
├─ packages/
│  ├─ core/                       纯 Node 运行时层（禁 import electron）
│  │  └─ src/
│  │     ├─ index.ts              公共导出（25 个）
│  │     ├─ agent/models.ts       gateway provider、createModelRegistry、pickModel
│  │     ├─ agent/env.ts          NodeExecutionEnv 工厂（每次调用新建，不做单例）
│  │     ├─ session/manager.ts    会话操作：只返回数据，不打印
│  │     ├─ paths.ts              WorkspacePaths + ensureWorkspacePaths
│  │     ├─ storage/create-storage.ts  文件库(node:sqlite) / 内存库
│  │     ├─ harness/open-harness.ts    storage → open → resume → root（顺序写死）
│  │     ├─ harness/registry.ts       装配内置扩展 + 注册表摘要
│  │     ├─ harness/host.ts           HarnessHost（close 幂等）
│  │     ├─ frames/frame-hub.ts       多会话 watch → 每会话单调 seq → sink
│  │     ├─ diagnostics/inspect.ts    脱敏诊断摘要
│  │     ├─ dev/crash-point.ts        PI_CRASH_POINT 命中等价 SIGKILL
│  │     └─ **/*.test.ts              同目录 node:test（25 条）
│  ├─ shared-types/               两端共用契约（禁依赖 pi-durable）—— 占位
│  ├─ shared-docs/                app.* 文档定义 —— 占位
│  └─ extensions/                 coding(S2) / kb(S7) / toolsmith(S8) / smartui(S9) —— 占位
├─ docs/
│  ├─ 知识中心/
│  │  ├─ 技术方案.md              文件结构、设计决策、数据模型、IPC 契约、验收门
│  │  └─ V1开发路线.md            S0–S9 路线、依赖关系、里程碑、风险登记
│  └─ notes/                     原子笔记（durable/ 12 篇、Electron/ 1 篇、node/ 1 篇）
├─ AGENT.md                       项目约定（尤其 notes/ 的原子笔记规则）
├─ pnpm-workspace.yaml            apps/* + packages/* + packages/extensions/*
├─ tsconfig.base.json             strict + noUncheckedIndexedAccess + bundler
├─ tsconfig.json                  Node 侧：packages/** + apps/cli/src
└─ eslint.config.mjs              两条导入边界（见下）
```

`dist/`、`release/`、`.data/`、`node_modules/` 均不入库（见 `.gitignore`）。

## 分层与导入边界

```
renderer ──▶ shared-types                     （只读副本 + IPC，不碰存储）
preload  ──▶ shared-types
main     ──▶ core ──▶ shared-docs / shared-types ──▶ extensions/*
core     ──▶ pi-durable / pi-ai / chord       （禁止 import electron）
```

边界由 ESLint `no-restricted-imports` 固化，不靠人记：

| 范围 | 禁止 import | 原因 |
|---|---|---|
| `apps/desktop/src/renderer/**` | `electron`、`@earendil-works/pi-durable`、`node:*`、`@pi/core`、`@pi/shared-docs` | 渲染进程不得持有 Harness，一律走 `window.pi` |
| `packages/**`、`apps/cli/**` | `electron` | core / 扩展 / CLI 必须能被纯 Node 脚本验收 |

## 运行

```bash
pnpm install          # 首次会下载 Electron 二进制（网络问题见下方「网络」）
cp .env.example .env   # 填 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / ANTHROPIC_MODEL
```

| 命令 | 作用 | 本次复验 |
|---|---|---|
| `pnpm dev` | Vite dev server + esbuild watch + 拉起 Electron（主进程/preload 改动整进程重启，renderer 走 HMR） | 未复验（会开窗口） |
| `pnpm build` | 一次性构建 `dist/{main,preload,renderer}` | ✅ 通过 |
| `pnpm start` | 跑已构建产物（需先 `pnpm build`） | 未复验（会开窗口） |
| `pnpm gate` | 存储门禁 G2：Electron 内置 Node 版本 + `node:sqlite` 真实建库读写 | ✅ 通过 |
| `pnpm test` | core 的 `node:test`（25 条，纯 Node，不联网、不需要 `.env`） | ✅ 25/25 |
| `pnpm typecheck` | 两套 tsconfig：Node 侧（packages + cli）+ desktop 侧（含 renderer） | ✅ 通过 |
| `pnpm lint` | ESLint，含上面两条导入边界 | ✅ 通过 |
| `pnpm cli` | 无头终端入口 | 🟡 目前只加载空 `main.ts`，无输出（exit 0） |
| `pnpm package` | electron-builder 打包 dmg/nsis | ⬜ 未跑过 |

`pnpm test` 覆盖的内容（全部基于 `MemoryStorage` 或临时目录里的真实 SQLite 文件）：

- `paths`：默认布局、相对根、根外工作区、目录创建幂等
- `storage`：真实文件写入 → `close()` → 重开读回；父目录自动创建；内存库不落盘
- `session/manager`：root 起始、新建/切换/列表、fork 继承 parent、无条目时 fork 显式失败、reset 写 `pi.reset`、忙判定与 inbox、watch 缓存、queue modes、`close()` 幂等
- `frames/frame-hub`：open 不重放历史、每会话 seq 单调 +1、重复 open 续号、移除 sink / 关闭会话后不再推、坏 sink 被隔离、会话不存在时报错
- `diagnostics/inspect`：空闲摘要计数、条目数据不出现在摘要里

## 配置

`.env`（不入库）里的变量：

| 变量 | 必需 | 说明 |
|---|---|---|
| `ANTHROPIC_API_KEY` | 是 | 网关 API key；`createModelRegistry` 通过 `envApiKeyAuth` 在每次请求时解析 |
| `ANTHROPIC_BASE_URL` | 否 | 默认 `https://api.anthropic.com`；自建网关时填自己的地址 |
| `ANTHROPIC_MODEL` | 是 | 网关支持的模型 id。缺它会直接报错，不猜模型 |
| `PI_CRASH_POINT` | 否 | 崩溃埋点名（`after-submit` / `during-tool` / `after-tool-result` / `mid-generation` / `between-phases`），命中即 `SIGKILL` |
| `PI_DEV_SERVER_URL` | 否 | 由 `pnpm dev` 注入；主进程据此决定 `loadURL` 还是 `loadFile` |

模型网关走 Anthropic Messages 协议，自带两个请求头（`user-agent: claude-cli/…`、`x-app: cli`）——非 Claude Code 的客户端会被网关 403。

## 状态落在哪里

`core/paths.ts` 定义数据布局，根路径由调用方注入（Electron 用 `app.getPath("userData")`，CLI 用 `--data-dir`）：

```
<root>/
├─ session.sqlite     pi-durable 单文件库（WAL）
├─ workspace/         模型可读写的工作区（工具默认 cwd）
├─ tools/             自举工具安装目录（S8）
└─ logs/              结构化日志（S5）
```

**注意当前实情**：布局与 `createStorage()` 都已经可用并有测试，但主进程还没接线，所以现在跑桌面应用**不会**产生 `.data/` 或任何落盘文件。落盘是 S5 的事。

## 版本基线（精确锁定）

| 包 | 版本 | 用途 |
|---|---|---|
| `@earendil-works/pi-durable` | 1.4.0 | 单写者 Harness、Task、Document、Storage |
| `@earendil-works/pi-ai` | 1.4.0 | 模型目录 / 请求 / 凭证 |
| `@earendil-works/chord` | 1.4.0 | `Op` / `applyImmutable` / `SqliteDatabase` / `Context` |
| `typebox` | 1.3.27 | 工具参数 + IPC 校验 |
| `electron` | 45.0.0 | 内置 Node **24.22.0**，`node:sqlite` 可用（`pnpm gate` 实测） |
| `react` / `react-dom` | 19.3.1 | 渲染进程 |
| `vite` / `@vitejs/plugin-react` | 7.3.7 / 5.2.0 | 渲染进程构建 |
| `tailwindcss` / `@tailwindcss/vite` | 4.3.3 | 样式 |
| `esbuild` | 0.28.2 | main / preload 构建 |
| `@jboltai/tokui` | 0.2.8 | 生成式 UI DSL（S9 才用） |
| `react-markdown` / `remark-gfm` | 10.1.0 / 4.0.1 | 消息渲染（S6 才用） |
| `electron-builder` | 26.18.0 | 打包 |
| `typescript` / `tsx` / `eslint` | 5.9.3 / 4.23.15 / 9.39.5 | 构建与检查 |

引擎要求：Node `>=22.19.0`、pnpm `>=10`（`packageManager: pnpm@10.30.3`）。
`pi-durable` 是 experimental，升级即破坏——版本锁死，SDK 用法收敛在 `core/harness/**`。

## 开发约定（写代码前必读）

1. **名字是契约**：Extension / Tool / Document kind / Entry kind / Task name / provider id 一旦落盘就不再改名（`PROVIDER_ID = "gateway"` 就是这样一个值）。
2. **先提交后展示**：屏幕上出现的每一帧都来自已提交状态；渲染进程不做乐观插入。
3. **主进程是唯一写者**：Harness 只活在主进程，渲染进程只有只读副本。
4. **错误按范围分级**：存储失败（`SessionFailed`）必须重建整个 Harness；工具异常只影响单次调用。
5. **不写用不到的抽象**：没有第二个实现就不建接口；路线文档标着「S N 再做」的就不要提前写。
6. **文档与代码冲突时以代码为准**，并顺手改文档；不在文档里写未核实的行为。

## 网络（重要）

本机无法直连 GitHub releases，Electron 二进制走 npmmirror。`.npmrc` 已写入：

```
electron_mirror=https://npmmirror.com/mirrors/electron/
```

若 `pnpm install` 后 `apps/desktop/node_modules/electron/dist` 缺失，说明二进制没下下来：

```bash
cd apps/desktop/node_modules/electron && node install.js
```

换到能直连 GitHub 的网络时可删掉 `.npmrc` 里那行，或用 `ELECTRON_MIRROR` 覆盖。

## 已知限制

- 桌面应用还不能对话：主进程没有 `HarnessHost`，渲染进程没有 replica，`window.pi` 只有 `debug.ping`。
- `packages/core` 的 S5 三块（`harness/materialize`、`agent/credentials`、`frames/doc-hub`）**故意没写**——它们依赖 `@pi/shared-docs` 的 `app.*` 定义，现在写只能靠猜。
- `apps/cli`、`shared-types`、`shared-docs`、四个扩展包都还是空壳（`export {}`），文件头写着各自的施工清单。
- `pnpm dev` / `pnpm start` / `pnpm package` 本次没有复验（前两个会开窗口，最后一个需要先跑通打包冒烟）。
