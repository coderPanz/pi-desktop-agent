# Pi Agent Desktop

一个**本机 Agent 工作台**：对话、工具执行、知识沉淀、界面状态全部落在本机一个可恢复的存储里。
模型在你自己的文件与命令上干活，而你能随时打断、重启、追溯。

> 工程方案：[docs/技术方案.md](./docs/技术方案.md) ｜ 执行手册：[docs/开发步骤.md](./docs/开发步骤.md) ｜ 施工图：[docs/知识中心/V1开发路线.md](./docs/知识中心/V1开发路线.md)

## 一期定位（摘要）

- **不是聊天外壳**：每次回答、每次工具调用、每个任务都是已落盘状态；进程被杀之后能接着跑。
- **不是 RPA / 云端 Agent**：只做本机文件、本机 shell、本地知识库三件事；副作用由你审批。
- **不是封闭产品**：预留三个定制面——扩展（工具/Task/Hook）、文档（`app.*` 业务状态）、UI（TokUI 卡片）。

做：对话与流式、工具执行与审批、崩溃恢复、桌面界面、本地知识库、工具自举、生成式 UI。
不做：多用户协作、云端同步、移动端、插件市场、工具沙箱、向量检索、多窗口写入。

## 当前进度

| 阶段 | 主题 | 状态 |
|---|---|---|
| S0 | 工作区与最小 Agent 调用 | ✅ 归档脚本 G0 六项通过（命令见「运行」） |
| — | 存储门禁 G2（`node:sqlite`） | ✅ `pnpm gate` 通过（Electron 45 / Node 24.22） |
| — | 桌面壳 + preload 桥接 + 构建链 | ✅ 已冒烟（渲染进程加载、`window.pi` 注入、隔离生效） |
| S1 | 流式输出与状态订阅 | ⬜ 下一步 |
| S2 | 工具调用与可视化 | ⬜ |
| S3 | 中断、排队与多会话（`apps/cli`） | ⬜ |
| S4 | SQLite 持久化与崩溃恢复 | ⬜ |
| S5 | Electron 主进程与 IPC（HarnessHost） | ⬜ 骨架已就位 |
| S6 | 渲染进程 replica 与聊天 UI | ⬜ |
| S7 | 知识库（可与 S6 并行） | ⬜ |
| S8 | 工具自举闭环（可与 S6 并行） | ⬜ |
| S9 | 智能 UI | ⬜ |

## 目录

```
.
├─ apps/
│  ├─ cli/                    无 Electron 的终端入口（S3）
│  └─ desktop/                Electron 外壳
│     ├─ build/build.ts       构建与 dev 编排（main=ESM / preload=CJS / renderer=Vite）
│     ├─ electron-builder.yml 打包（S5 末尾冒烟）
│     └─ src/
│        ├─ main/             index.ts（窗口/单实例锁）、gate.ts（存储门禁 G2）
│        ├─ preload/          contextBridge（产物必须是 CJS）
│        └─ renderer/         React 19 + Tailwind 4
├─ packages/
│  ├─ core/                   纯 Node 运行时层（禁 import electron）—— S3 起
│  ├─ shared-types/           两端共用契约与纯函数（禁依赖 pi-durable）—— S5 起
│  ├─ shared-docs/            defineDoc / defineEntry —— S5 起
│  └─ extensions/             coding（S2）、kb（S7）、toolsmith（S8）、smartui（S9）
├─ docs/                      文档与证据（不打包、不 typecheck、不 lint）
│  ├─ 技术方案.md              V1 工程方案（为什么这么搭）
│  ├─ 开发步骤.md              实现流程（今天做什么、跑哪条命令、什么算做完）
│  ├─ 知识中心/                施工图：架构、SDK 参考、API、阶段 0–9
│  ├─ notes/                   原子笔记（durable/、node/）
│  └─ verify/                  阶段验收脚本归档（stage0 在此，prestudy/ 为学习期脚本）
└─ AGENT.md                   项目约定（尤其 notes/ 的原子笔记规则）
```

依赖方向只能向下：`renderer → shared-types`、`main → core → pi-durable`。
`packages/core`、`packages/extensions/*`、`apps/cli` 都不得 import `electron`（ESLint 已强制），
渲染进程不得 import `pi-durable` / `electron` / `node:*`。

## 运行

```bash
pnpm install          # 首次：会下载 Electron 二进制（见下方「网络」）
cp .env.example .env  # 填入 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / ANTHROPIC_MODEL

pnpm dev              # 开发模式：Vite dev server + esbuild watch + Electron
pnpm build            # 构建 dist/{main,preload,renderer}
pnpm start            # 跑已构建的产物（需先 build）
pnpm gate             # 存储门禁 G2：Electron 里的 Node 版本 + node:sqlite
pnpm cli              # 无头终端入口（S3 起可用）
pnpm typecheck        # 两套 tsconfig：Node 侧 + desktop 侧
pnpm lint             # ESLint（含两条导入边界）
```

归档在 `docs/verify/` 的阶段脚本不属于产品入口，直接跑：

```bash
pnpm exec tsx --env-file-if-exists=.env docs/verify/stage0-min-agent.ts
```

通过口径：非空回答、模型一致、同一 `requestId` 命中同一条 submission、`close()` 前无 running 任务、进程自然退出。

## 版本基线（精确锁定）

| 包 | 版本 | 说明 |
|---|---|---|
| `@earendil-works/pi-durable` | 1.4.0 | 单写者 Harness、Task、Document、Storage |
| `@earendil-works/pi-ai` | 1.4.0 | 模型目录 / 请求 / 凭证 |
| `@earendil-works/chord` | 1.4.0 | `Op` / `applyImmutable` / `SqliteDatabase` |
| `typebox` | 1.3.27 | 工具参数 + IPC 校验 |
| `electron` | 45.0.0 | 内置 Node **24.22.0**，`node:sqlite` 可用（已实测） |
| `react` / `react-dom` | 19.3.1 | 渲染进程 |
| `vite` / `@vitejs/plugin-react` | 7.3.7 / 5.2.0 | 渲染进程构建 |
| `tailwindcss` / `@tailwindcss/vite` | 4.3.3 | 样式 |
| `@jboltai/tokui` | 0.2.8 | 生成式 UI DSL（S9 才用；0.2.9 待比对后升级） |
| `electron-builder` | 26.18.0 | 打包（S5 冒烟） |

## 网络（重要）

本机无法直连 GitHub releases，Electron 二进制走 npmmirror。`.npmrc` 已写入：

```
electron_mirror=https://npmmirror.com/mirrors/electron/
```

若 `pnpm install` 后 `apps/desktop/node_modules/electron/dist` 缺失，说明二进制没下下来，执行：

```bash
cd apps/desktop/node_modules/electron && node install.js
```

换到能直连 GitHub 的网络时可删除 `.npmrc` 里那一行。

## 约定（写代码前必读）

1. **名字是契约**：Extension / Tool / Document kind / Entry kind / Task name 一旦落盘就不再改名。
2. **先提交后展示**：屏幕上出现的每一帧都来自已提交状态；渲染进程不做乐观插入。
3. **主进程是唯一写者**：Harness 只活在主进程，渲染进程只有只读副本。
4. **错误按范围分级**：存储失败（`SessionFailed`）必须重建整个 Harness；工具异常只影响单次调用。
5. **不写用不到的抽象**：没有第二个实现就不建接口；阶段文档说「阶段 N 再做」的就不要提前写。
