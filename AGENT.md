# 项目约定

## 1. 事实

- 本机 Agent 工作台。运行时：Node `>=22.19.0`、pnpm `>=10`；Electron 45 内置 Node 24。
- `packages/core` 是纯 Node 运行时层；`apps/cli` 与 `apps/desktop` 的主进程共用它。
- 依赖方向：`renderer → shared-types`；`main → core → shared-docs / shared-types`；`core → pi-durable / pi-ai / chord`。
- 两条导入边界由 ESLint `no-restricted-imports` 强制：
  - `apps/desktop/src/renderer/**` 不得 import `electron`、`node:*`、`pi-durable`、`@pi/core`、`@pi/shared-docs`。
  - `packages/**`、`apps/cli/**` 不得 import `electron`。

## 2. 名字是契约

Extension / Tool / Document kind / Entry kind / Task name / provider id 一旦落盘就不再改名。

- 内置条目的 kind 与文档 kind 定义在 `packages/shared-types/src/frame.ts`。
- `app.*` 文档与条目定义在 `packages/shared-docs/src/`。
- `packages/shared-docs/src/contracts.test.ts` 用断言钉住这些值：改它必须是有意识的决定，并配迁移或接受旧数据读不出来。

## 3. 先提交后展示

屏幕上、终端上出现的每一帧都来自已提交状态。渲染进程与 CLI 都不做乐观插入，也不自行拼接"看起来对"的文本。

## 4. 唯一写者

Harness 只活在主进程或 CLI 进程里。一个库文件只允许一个 Harness；渲染进程只有只读副本，通过 `IpcMap` 请求变更。

## 5. 错误按范围分级

- `UserError`：当前状态不满足操作前提（会话不存在、无可分叉条目）。说一句就继续，不算进程失败。
- `ConfigError`：配置缺失（无 `ANTHROPIC_MODEL`、无凭证）。必须改配置。
- `SessionFailed`：存储失败，Harness 已不可用。唯一正确的处理是重建 Harness，不能重试单次调用，也不能降级到内存库。

## 6. 契约写在代码里

线协议（帧 / IPC / 推送 / 错误码）只在 `packages/shared-types`，`app.*` 只在 `packages/shared-docs`。
文档只解释**为什么**这样定，不重复类型定义——两边各写一份必然漂移。

## 7. 不写用不到的抽象

没有第二个实现就不建接口；路线里标着未做的功能不要提前写。
空包就是空包，用一句说明现状即可，不要在里面堆"规划模块"清单。

## 8. 提交前必须通过

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm smoke
```

`pnpm smoke` 是唯一不联网、不需要凭证的端到端检查（真实装配 + REPL 命令），别跳过。

## 9. 文档

| 文件 | 只写什么 |
|---|---|
| `README.md` | 使用说明：快速开始、命令、数据布局、契约位置、故障排查、已知限制 |
| `CHANGELOG.md` | 按 Keep a Changelog 记录变更 |
| `AGENT.md` | 本文件：工程约定 |
| `docs/知识中心/` | 架构、关键决策（ADR）、数据模型、风险 |
| `docs/notes/` | 原子化笔记：一条可复用的结论（写入规则见 §10） |
| 源码注释 | 为什么这么写；不写“什么是 X”这类概念解释 |

- 不写教程、不写学习路线、不记录阶段计划与预计工期。
- 文档与代码冲突时**以代码为准**，并顺手改文档；不要在文档里写未核实的行为。

## 10. 原子化笔记（`docs/notes/`）

### 10.1 什么进笔记

只记**以后还会再查一次的结论**：某个 SDK 的真实行为、某个字段或类型到底是什么、某个取舍的理由。
判断标准是「三个月后我或别人会不会又去翻 `node_modules` 找同一个答案」——会，就写一篇。

概念澄清（例如「`NodeExecutionEnv` 是什么」「`ctx` 的作用」）是这类笔记的典型形态：
它回答的是一个具体问题，答案可核对，不是科普。

### 10.2 什么不进笔记

| 内容 | 应该写在哪 |
|---|---|
| 长篇教程、学习路线、阶段计划、预计工期 | **不写** |
| 学习过程、踩坑日记、命令流水 | **不写**（只留结论） |
| 代码实现细节、为什么这么写 | 源码注释 |
| 做什么、先做什么 | `docs/知识中心/ROADMAP.md` |
| 架构、决策、数据模型 | `docs/知识中心/技术方案.md` |
| 一次性排查 | 只把结论写进笔记或上面两处，不建排查日志 |

### 10.3 写入规则

1. **一篇一主题**：标题即主题，能被搜索命中；一篇里出现新主题就拆成新篇，原篇用相对路径链过去。
2. **结论先行**：第一句给结论，之后才是依据与边界。
3. **可验证**：涉及类型 / 函数 / 字段时引用真实签名，并标注来源（`packages/...` 或 `node_modules/@earendil-works/*/dist/*.d.ts`）。
4. **不臆测**：没读过的 API 不写；未核实的行为标「待验证」，验证后回来改。
5. **更新优于新建**：先搜同主题，有则改，不重复建档。
6. **过时即改**：结论变了就改笔记，不保留已被推翻的说法。
7. **命名与归档**：`<序号>. <中文标题>.md`，按主题放子目录（如 `durable/`、`electron/`、`sqlite/`）。
8. **链接**：笔记之间用相对路径；链接只用于主题跳转，不用于堆背景资料。

### 10.4 何时写

写代码时碰上一个「不看源码就说不清」的点，且有复用价值——就写。
不要把写笔记当成交付物：没有结论可写时，宁可不写。

## 11. 依赖与版本

全部依赖精确锁版（不用 `^`）。`pi-durable` 是 experimental，升级即可能破坏 API：SDK 用法收敛在 `packages/core/src/harness/**`，升级时只改这一层。
