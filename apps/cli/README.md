# @pi/cli

**不启动 Electron 的终端入口**：和桌面主进程消费同一套 `@pi/core`，把「排队 / 中断 / 分叉 / 恢复 / 审批」放在终端里复现。

定位不是给普通用户用的界面，而是**开发、验收与排障的第一条主线**——`pnpm dev` 白屏或状态对不上时，先用 `pnpm cli --memory` 判断问题在 core 还是界面层。

## 边界

| 规则 | 怎么保证 |
|---|---|
| **不 import `electron`** | `eslint.config.mjs` 对 `apps/cli/**/*.ts` 开 `no-restricted-imports`，违反即 lint 报错 |
| 只用纯 Node | 无 GUI 依赖，`pnpm smoke` 不需要凭证、不联网、不需要 `.env` |
| 不碰 React / 渲染进程 | 输出只有字符串与 `process.stdout.write`；格式化全在 `render.ts` |
| 不重复实现业务 | 会话、存储、审批判定都来自 `@pi/core` / `@pi/ext-coding`，本目录只管「读输入 → 调 API → 打印」 |

## 文件地图

| 文件 | 职责 | 关键点 |
|---|---|---|
| `src/main.ts` | 装配与主循环：参数 → 存储 → `HarnessHost` → `SessionManager` → `FrameHub` → 渲染器 | 收尾顺序固定：`hub.closeAll()` → `manager.closeWatches()` → `host.close()` |
| `src/args.ts` | 参数解析、`HELP_TEXT` | 非法参数一律抛 `UsageError`，退出码 2；不静默回落默认值 |
| `src/commands.ts` | REPL 行解析：`/` 开头是命令，其余是消息 | 拼错抛 `CommandError`，**不会**被当成消息发给模型 |
| `src/approvals.ts` | 单消费者事件队列 + 终端审批通道 | 用户输入与审批请求共用一条 stdin，见下节 |
| `src/render.ts` | `ConversationRenderer`：把 `ViewFrame` 打成终端文本 | 只补后缀、不整段重画；正在生成的回答优先于已落库的那条 |

## 运行

```bash
pnpm cli                                   # REPL，数据落在 ./.data
pnpm cli --memory                          # 内存库，不写文件（验收与排障首选）
pnpm cli --data-dir /tmp/pi-demo           # 指定数据根
pnpm cli -p "看一下 package.json 有哪些脚本"  # 一次性提问，打印回答后退出
pnpm cli --conv 3                          # 直接从会话 #3 开始
pnpm smoke                                 # 管道喂几条命令的端到端冒烟
```

根脚本 `pnpm cli` 实际执行 `tsx --env-file-if-exists=.env apps/cli/src/main.ts`，所以根目录 `.env` 会被自动加载。

### 参数

| 参数 | 说明 |
|---|---|
| `-p, --prompt <text>` | 一次性模式：提交、等结算、退出 |
| `--data-dir <path>` | 数据根，默认 `.data`，内含 `session.sqlite` / `workspace` / `tools` / `logs` |
| `--memory` | 使用内存库；与 `--data-dir` 互斥（前者不写文件，后者要写文件） |
| `--conv <id>` | 起始会话 id，缺省是 root 会话 |
| `--partial-interval-ms <n>` | 流式提交间隔毫秒，默认 `100`；越小越平滑、越大越省写入 |
| `-h, --help` | 打印帮助，优先级高于一次性模式 |

### 环境变量

| 变量 | 用途 |
|---|---|
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL` | 模型网关；`ANTHROPIC_MODEL` 缺失时启动报 `ConfigError`（退出码 1） |
| `PI_LOG_LEVEL=debug` | 把装配链路打到 **stderr**，stdout 只留对话输出 |

## REPL 命令

```
/new            新建会话          /list           列出会话（* 当前、busy 正在跑、queued=排队数）
/switch <id>    切换会话          /fork           从最新条目分叉
/abort          中断当前回答      /reset [说明]   清空上下文
/compact [说明] 压缩上下文        /inspect        打印诊断摘要（不含消息内容）
/help           帮助             /quit           退出（Ctrl+D 同效）
```

其他输入一律作为消息提交给模型。`/switch` 也接受别名 `/conv`。

## 三个值得知道的设计

**1. `Ctrl+C` 只中断当前回答，不退出进程**

`rl.on("SIGINT")` 走 `manager.abort()`，中断本身是 durable 操作（重启后也能看到「已请求取消」）。真要退出请 `/quit` 或 `Ctrl+D`。

**2. 输入与审批共用一条 stdin，只有一个消费者**

终端只有一条 stdin。若审批另开一个 `readline`，审批时输入的 `y` 会同时被当成 REPL 命令。所以 `CliEventQueue` 把两种事件排进同一队列，由 REPL 循环串行处理；有待批请求时，下一行是**答复**而不是命令。

`close()`（EOF / `Ctrl+D` / 管道结束）会把未答复的审批**全部结算为拒绝**——否则 `host.close()` 会卡在那次审批的超时上（默认 120s），没 `unref()` 的计时器还会把进程撑着。

**3. 非交互一律拒绝审批**

`interactive = mode === "repl" && process.stdin.isTTY`。`-p` 一次性模式、管道输入、`pnpm smoke` 都算非交互：`ask` 档工具直接按拒绝处理，脚本才可能无人值守复现。

## 渲染规则

`ConversationRenderer` 每个会话一个实例，切会话就换新的（帧号与已打文本都不沿用）：

- 正在生成的回答优先显示；落库后换成最终那条，**两份不同时显示**；
- 只往后补新字符（`startsWith` 判断才能续写），上游整段重写时换行重打，避免流式重复、倒退；
- 工具状态只在**变化时**打一行；
- 坏文档不炸终端（`pi.live` 不是对象时按「没有实时状态」处理）。

`traceFrames` 可在构造时打开，每帧打一行 `[frame seq] ops=n` 用于查丢帧——目前只有测试用到，没接 CLI 参数。

## 退出码

| 码 | 含义 |
|---|---|
| `0` | 正常结束（`-p` 模式下也要求 `settled.status === "done"`） |
| `1` | 启动失败、配置缺失、未拿到回答、存储失败（`SessionFailed` 意味着 Harness 已不可用，直接退出而不是假装能继续） |
| `2` | 参数错误（`UsageError`），同时打印帮助 |

栈不直接泼给用户，`PI_LOG_LEVEL=debug` 时才打 `error.stack`。

## 验收

```bash
pnpm typecheck && pnpm lint && pnpm smoke && pnpm build
```

不维护 `.test.*`、`.spec.*` 或专用测试 fixture。按改动手动确认参数解析、审批、帧渲染与存储恢复，
后台存储失败必须主动结束等待并退出，不能要求用户再输入一条命令才发现失效。

## 依赖方向

```
apps/cli ──▶ @pi/core          ──▶ @earendil-works/{pi-durable, pi-ai, chord}
         ├─▶ @pi/ext-coding    ──▶ @pi/shared-types
         ├─▶ @pi/shared-types  （渲染器用它的帧类型与 applyFrame / live* 工具函数）
         └─▶ @earendil-works/{chord, pi-durable}（BACKGROUND_CONTEXT 与 id 类型）
```

CLI 与 `apps/desktop` 的主进程是**同级消费者**，共享 `SessionManager` / `HarnessHost` / `FrameHub`；两条链路上出现同样现象，问题几乎一定在 `@pi/core` 或 SDK 里。

## 相关文档

- 共用运行时层与最小装配：[`packages/core/README.md`](../../packages/core/README.md)
- 架构与决策：[`docs/知识中心/技术方案.md`](../../docs/知识中心/技术方案.md)
- 现状与待办：[`docs/知识中心/ROADMAP.md`](../../docs/知识中心/ROADMAP.md)
- 帧 / `ctx` / 恢复等原子笔记：[`docs/notes/durable/`](../../docs/notes/durable/)
