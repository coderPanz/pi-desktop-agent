# 阶段 4：SQLite 持久化与崩溃恢复

> **目标**：把阶段 3 的 CLI 换成真正落盘的版本；亲手制造五次崩溃，看到恢复发生。
> **预计**：2–4 天。**产出**：可重启续跑的 CLI + 五份恢复记录。

---

## 1. 前置概念

- **durable 不是「自动保存」**，而是一组承诺：提交原子、ID 跨重开单调、从检查点继续、错误分级。
- **WAL 让进程被杀后数据库仍然一致**，但「一致」只到最后一个完整事务。
- **恢复是「从最后状态继续」，不是重放操作**。内存里的东西一概不恢复。
- **`replay` 决定副作用**：safe 重跑，unsafe 得到「中断」结果。
- **`requestId` 跨重启仍然去重**。这是防止重复提问的最后一道闸。
- **SQLite 是单写者的**。框架不给跨进程锁，你要自己保证。
- **检查点是任务层的**；工具调用意图是框架层的。两者不是一回事。

---

## 2. 先读哪些文档

1. [存储、错误与恢复](../02-PI-Durable/05-存储错误与恢复.md) —— 全文
2. [PI-Durable API 参考](../02-PI-Durable/02-API参考.md) —— 第 8、10 节
3. [模块交互](../01-架构/02-模块交互.md) —— 场景 E
4. [待验证清单](../04-API/待验证清单.md) —— 1.1、1.2、1.5

---

## 3. 架构位置与模块协作

```
packages/core/src/
├─ storage/create-storage.ts     openNodeSqliteStorage + 路径与选项
├─ harness/open-harness.ts       Harness.open + resume + root + closed 监听
└─ tools/crash-point.ts          dev-only：在指定点 process.exit(1)

scripts/
├─ 04-durable-cli.ts             阶段 3 CLI 的持久化版本
├─ 04-probe.ts                   打开库、打印 inspect/taskGraph，然后退出
└─ 04-crash.ts                   按 CRASH_AT 制造五类崩溃
```

数据目录（先不接 Electron）：

```
./.data/
├─ session.sqlite
├─ session.sqlite-wal
└─ session.sqlite-shm
```

`create-storage.ts` 是**唯一**决定库路径与选项的地方。阶段 5 只是把根目录换成 `app.getPath("userData")`，不重写逻辑。

---

## 4. API 清单

| 目的 | API | 注意 |
|---|---|---|
| 打开 SQLite | `openNodeSqliteStorage(path, opts)` | `busyTimeoutMs`、`walAutoCheckpointPages`、`prefix` |
| 打开 Harness | `Harness.open(storage, options, ctx)` | 同一个路径只能有一个 Harness |
| 继续调度 | `harness.resume()` | 重启后必须调用 |
| 根会话 | `harness.root(ctx)` | 每次启动都要取 |
| 监听关闭 | `harness.closed` | `{reason:"closed"|"failed"}` |
| 诊断 | `harness.inspect(ctx)` | 只读，不跑任务 |
| 任务图 | `harness.taskGraph(ctx)` / `watchTaskGraph(ctx)` | |
| 唤醒判断 | `harness.wake()` | `{}` 表示无活 |
| 重试 park | `harness.retryTask(id, ctx)` | `restartLimit` 默认 5 |
| 错误 | `SessionFailed` | Storage 失败后 Session 已关 |
| 错误回调 | `HarnessOptions.onReport` | `task_parked`、`session_failed` 等 |
| 备份 | SQLite `VACUUM INTO` | 不要只拷主文件 |

---

## 5. 手写任务

### 5.0 落地顺序与可手写代码

先集中存储路径，再封装固定的打开和恢复顺序；任何一步失败都应向上抛出而不是退回内存存储。

```ts
import { mkdir } from "node:fs/promises"; // 引入异步创建数据目录的能力。
import { join } from "node:path"; // 引入数据库路径拼接工具。
export async function createStorage({ dataDir }: { dataDir: string }) { // 定义唯一的 SQLite 存储工厂。
  await mkdir(dataDir, { recursive: true }); // 确保首次启动也有数据目录。
  const dbPath = join(dataDir, "session.sqlite"); // 固定会话数据库的文件名。
  return openNodeSqliteStorage(dbPath, { busyTimeoutMs: 5000 }); // 以明确的锁等待时间打开持久化存储。
} // 结束存储工厂函数。
export async function openHarness(options: OpenHarnessOptions) { // 定义可复用的恢复启动入口。
  const storage = await createStorage({ dataDir: options.dataDir }); // 先成功打开存储再创建 Harness。
  const harness = await Harness.open(storage, options, options.ctx); // 让 Harness 接管已打开的持久化存储。
  await harness.resume(options.ctx); // 恢复重启前尚未结算的任务调度。
  const root = await harness.root(options.ctx); // 在恢复后获取稳定的根会话。
  return { harness, root, storage }; // 将生命周期对象一并交给调用方关闭。
} // 结束恢复启动函数。
export function crashPoint(name: string): void { // 定义仅供开发崩溃实验调用的埋点。
  if (process.env.NODE_ENV !== "production" && process.env.CRASH_AT === name) process.exit(1); // 只在非生产环境命中指定点时立刻退出。
} // 结束崩溃埋点函数。
```

### 5.1 `storage/create-storage.ts`

- `createStorage({ dataDir })`：确保目录存在，返回 `openNodeSqliteStorage(join(dataDir, "session.sqlite"), { busyTimeoutMs: 5000 })`。
- 打印一次实际路径与选项（不打印内容）。
- **不要**在这里 `try/catch` 后 fallback 到 MemoryStorage。存储失败必须显式失败。

### 5.2 `harness/open-harness.ts`

- `openHarness({ dataDir, models, registry, settings, env })`。
- 顺序：storage → `Harness.open` → `harness.resume()` → `harness.root(ctx)`。
- 挂 `harness.closed.then(...)`：`failed` 时打印原因并**停止**接受新命令（CLI 退出码非 0）。
- 返回 `{ harness, root, storage, close }`。

### 5.3 `scripts/04-durable-cli.ts`

在阶段 3 CLI 基础上：

- 会话 id 从存储恢复：启动时 `harness.root(ctx)`，并尝试列出已有会话（先只恢复 root 与内存里记过的 id，会话列表功能按你的实现补齐）。
- `/entries [n]`、`/inspect`、`/graph`、`/wake`、`/backup <path>`（`VACUUM INTO`）。
- 退出时 `await harness.close(ctx)`。**Ctrl-C 也要走 close**（`process.on("SIGINT")`），但保留 `kill -9` 的测试路径。

### 5.4 `tools/crash-point.ts`

只在 `NODE_ENV !== "production"` 时生效：

```ts
export function crashPoint(name: string): void {
  if (process.env.CRASH_AT === name) process.exit(1);
}
```

在以下位置埋点（**只埋点，不改业务逻辑**）：

| 点名 | 位置 |
|---|---|
| `after-submit` | `submit()` 返回后 |
| `during-tool` | 工具 `execute` 开头 |
| `after-tool-result` | 工具返回后、模型请求前（用 hook 的 `afterTool`） |
| `mid-generation` | 生成中（用一个长回答 + 定时） |
| `between-phases` | 任务两个 `rt.commit()` 之间 |

### 5.5 `scripts/04-crash.ts`

一个参数化脚本：

```
tsx scripts/04-crash.ts --phase 1 --question "写一篇 800 字说明"
tsx scripts/04-crash.ts --phase 1 --probe        # 只打印恢复后的状态
```

两个模式：

- **制造**：正常提交，在指定点退出。
- **探查**：打开库、`inspect()`、打印 entries 摘要、不提交任何东西，退出。

### 5.6 `notes/stage4-recovery.md`

五个场景各一节，固定格式：

```
场景：/ 命令 / 崩溃点 / 重启后 entries 摘要 / inspect / 结论 / 证据文件
```

---

## 6. 实现提示

- **不要写「自动重试打开」的循环。** 先让失败可见。重建逻辑阶段 5 再做。
- **`close()` 放在 `finally` 与 SIGINT 两处**，且用同一个 promise 防重复。
- **测试用独立数据目录。** `--data-dir ./.data-test/<case>`，每个场景一个目录，互不污染。
- **`kill -9` 要在「有 WAL 写入」时打。** 太早打，什么都没写；太晚打，已经提交完了。用 `--delay` 控制。
- **检查点不是越多越好。** 先在 `defineTask` 的每个 phase 结束 `rt.commit()`；`sleepUntil` 前必须有一个 checkpoint。
- **工具幂等键**：`api.executeTool` 的 `key` 只在一次调用内有效；跨崩溃的幂等要靠业务字段（例如写文件前比对 hash）。
- **unsafe 工具的结果**：模型会看到「调用被中断」。你的工具描述里要告诉模型遇到这种结果该怎么补救。
- **`replay: "safe"` 只给真正的纯读工具。** `read_file` / `list_dir` / `kb_search` 可以；`write_file` / `bash` 不行。
- **`restartLimit` 调到 2 做一次实验**，看到 `blocked` + `restart_limit` 后 `retryTask`，再恢复默认。
- **备份用 `VACUUM INTO`**：它要求目标文件不存在。路径写死之前先删除旧备份，或带时间戳。

---

## 7. 调试方法

| 想知道 | 做法 |
|---|---|
| 库在哪 / 多大 | `ls -lh .data/`，确认 `-wal` 存在 |
| 有没有落盘 | 提交后**不关进程**，另一个进程只读打开（仅观察，别写） |
| 恢复调度了吗 | 启动后立刻 `wake()` + `inspect()` |
| 任务为什么 blocked | `inspect()` 的 reason |
| 工具重跑了吗 | 工具开头打印 `callId` 与 `attempt` |
| 重复提问了吗 | 同 `requestId` 的 submission 数 |
| 关库了吗 | close 后调用任方法应 reject |
| 备份是否完整 | 打开备份文件，`entries` 数量与主库一致 |

排查顺序固定：`wake()` → `inspect()` → `taskGraph()` → `closed` 原因 → 存储文件。

---

## 8. 验收标准

五项崩溃场景全部通过（每条都要有重启后的输出证据）：

- [ ] **1 after-submit**：重启后用户消息在；回答继续；同 `requestId` 再提交不重复。
- [ ] **2 during-tool**：`read_file` 这类 safe 工具重跑；`bash` / `write_file` 不重跑，模型看到中断结果。
- [ ] **3 after-tool-result**：模型看到工具结果；工具**没有**第二次执行。
- [ ] **4 mid-generation**：已提交的部分回答在；剩余部分继续生成；没有重复的 assistant。
- [ ] **5 between-phases**：任务从上一个检查点继续，不是从头；`app.*` 文档状态一致。

其它：

- [ ] 正常退出后重启，`entries` 完全一致，`inspect()` 无活任务。
- [ ] `kill -9` 后 `session.sqlite-wal` 存在，重开不报错。
- [ ] `restartLimit=2` 时任务被 park，`retryTask` 能再跑。
- [ ] `VACUUM INTO` 的备份能被新 Harness 打开并读到相同条目。
- [ ] 同一数据目录启动第二个进程时，你**明确知道**会发生什么（不是侥幸）。

---

## 9. 阶段产出

- `packages/core/src/storage/create-storage.ts`
- `packages/core/src/harness/open-harness.ts`
- `packages/core/src/tools/crash-point.ts`
- `scripts/04-durable-cli.ts`、`scripts/04-crash.ts`
- `notes/stage4-recovery.md`（五个场景）

---

## 10. 常见失败

| 现象 | 原因 | 修法 |
|---|---|---|
| 重启后什么都不发生 | 忘 `resume()` | 启动流程固定 |
| 用户消息丢了 | 提交前用手写文件代替了 `submit` | 只通过 Harness 写 |
| 工具执行了两次 | 把副作用工具标成 `safe` | 改回默认 unsafe |
| 回答重复一半 | 自己缓存了「已有文本」并重新提交 | 让生成任务继续，不要补发 |
| 打不开库 | 1.3 / 1.4 schema 混用 | 统一版本，先备份 |
| 备份缺最近消息 | 只拷主文件 | `VACUUM INTO` |
| `SessionFailed` 后还能调 | 吞掉了错误继续用 | 监听 `closed`，重建 |
| 数据库被锁 | 两个进程/两个 Harness | 单写者 + 独立测试目录 |
| WAL 文件巨大 | 没 checkpoint / 长事务 | 默认 `walAutoCheckpointPages`，正常 close |
| 恢复后任务一直 pending | 任务被 park | 看 `inspect()`，`retryTask` |

---

## 下一步

[阶段 5：Electron 主进程与 IPC](阶段5-Electron主进程与IPC.md)
