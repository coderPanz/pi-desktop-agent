# chord API 参考（1.4.0）

> chord 是 pi-durable 的底座：**不可变值 + 操作批 + 复制状态 + SQLite 门面**。
> 本项目大部分时候只用它的三样东西：`Context`、`Op`/`applyImmutable`、`SqliteDatabase`。

版本：`@earendil-works/chord@1.4.0`。

---

## 1. 子路径

| 子路径 | 内容 | 本项目用不用 |
|---|---|---|
| `@earendil-works/chord/context` | `Context`、`BACKGROUND_CONTEXT`、`withCancel` | **常用** |
| `@earendil-works/chord/delta` | `Op`、`applyImmutable`、`isBase` | **常用** |
| `@earendil-works/chord/sqlite/node` | `openNodeSqliteDatabase`、`NodeSqliteDatabase` | 备用（换 better-sqlite3 时） |
| `@earendil-works/chord` | 复制状态、连接、注册表等 | 一般不用 |
| `@earendil-works/chord/sqlite` | 数据库抽象 | 一般不用 |

从主入口导出的也有 `replicatedState`、`AttachedReplicatedState` 等，但 pi-durable 已经替你封装，业务代码不需要直接创建复制状态。

---

## 2. `Context`

```ts
interface Context {
  readonly abortSignal: AbortSignal | undefined;
  readonly telemetry: TelemetrySpan;
  value<T>(key: ContextKey<T>): T | undefined;
  toString(): string;
}
```

### 创建与派生

| 函数 | 用途 |
|---|---|
| `BACKGROUND_CONTEXT` | 永不取消，用于必须完成的后台工作 |
| `createContextKey<T>(desc)` | 定义类型化的值槽 |
| `withContextValue(key, value, parent)` | 加一个值 |
| `withAbortSignal(signal, ctx)` | 叠加一个取消信号 |
| `withoutAbortSignal(ctx)` | 去掉调用方取消（仅清理用） |
| `withCancel(ctx)` | 返回 `{context, cancel}`，独立取消 |
| `awaitWithContext(promise, ctx)` | 等 promise，但可被 ctx 取消 |
| `traceIn(ctx, options, fn)` | 建子 span |

### 最容易误解的一点

```ts
const { context: child, cancel } = withCancel(ctx);
const p = conversation.submit(..., child);
cancel();                  // 只让等待者 reject，不会撤回已提交的输入
```

`cancel()` 取消的是**等待**，不是**工作**。要停止工作用：

- `conversation.abort(ctx)`
- `harness.abortTask(id, ctx)`
- `submission.abort(ctx)`（仅撤回排队中的提交）

### 那个 `ctx` 参数是什么

pi-durable 几乎每个方法都要求 `context: Context`。主进程里创建一个长期 context 即可：

```ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

const ctx = BACKGROUND_CONTEXT;               // 最简
// 或带取消：
const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
```

IPC handler 里可以为每个请求建一个带超时的子 context，但**不要**在请求结束时 cancel 掉正在跑的任务。

---

## 3. `Op` 与不可变应用

```ts
import { applyImmutable, isBase, type Op } from "@earendil-works/chord/delta";
```

`Op` 是 JSON 元组：

| 操作 | 形状 | 说明 |
|---|---|---|
| `r` | `["r", value]` | 替换根。唯一能作用于根的操作 |
| `s` | `["s", path, value]` | 设置 |
| `d` | `["d", path]` | 删除 |
| `a` | `["a", path, string]` | 追加字符串 |
| `t` | `["t", path, number]` | 截断字符串 |
| `p` | `["p", path, start, deleteCount, items]` | 数组拼接 |
| `m` | `["m", path, permutation]` | 数组重排 |

```ts
const next = applyImmutable(prev, ops);   // 返回新值，不修改 prev
```

行为（已核实）：

- `prev` 为 `undefined` 时，只有 `["r", value]` 合法。
- 路径段是 `string | number`。
- 会拒绝原型污染路径（`__proto__` / `constructor` / `prototype`），抛 `UnsafePathError`。
- 返回值与 `prev` 共享未修改的子树（结构共享），所以不要修改任何一层。

`isBase(ops)` 判断这批操作是否以根替换开头。**flushing 保证 `r` 只在索引 0 或不存在**，所以这是精确判断。

`applyImmutableBatches(prev, batches)` 依次应用多批，等价于循环。

> 需要「受信任、已校验」的快路径时还有 `applyImmutableTrusted`，但不要用在来自渲染进程/模型的数据上。

---

## 4. 复制状态（了解即可）

```ts
interface ReplicatedState<T> {
  readonly value: T | undefined;
  subscribe(listener: (value: T, ctx: Context, delivery: {kind:"hydrate"|"update"; sequence:number}) => void | Promise<void>): () => void;
}

interface AttachedReplicatedState<T> extends ReplicatedState<T> {
  readonly value: T;          // 同步已水合
  dispose(): void;
}
```

语义：

- 每次订阅串行回调；先 hydrate 再 update。
- 最多 100 次投递在排队；超过后只保留最新值/上下文/投递信息，**sequence 会跳号**。
- 单个订阅者抛错不影响其它订阅者。
- 取消订阅丢弃待投递，但不中断正在跑的回调。

pi-durable 的 `viewState()` / `documentState()` 返回的就是这个类型。**不要自己 `replicatedState(initial)` 造一个来存对话**——那会绕开持久化。

---

## 5. SQLite 门面

```ts
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";

const db = await openNodeSqliteDatabase(path, {
  busyTimeoutMs: 5000,
  walAutoCheckpointPages: 1000,
});
```

```ts
interface SqliteDatabase {
  exec(sql: string): Promise<void>;
  run(sql: string, ...params: SqliteValue[]): Promise<void>;
  get<T extends object>(sql: string, ...params): Promise<T | undefined>;
  all<T extends object>(sql: string, ...params): Promise<T[]>;
  transaction<T>(fn: (tx: SqliteExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
```

已核实：**只有这六个成员。** 这正是「换掉 `node:sqlite`」的突破口：

- `pi-durable` 的 `SqliteStorage.open(db, options)` 接受任何满足 `SqliteDatabase` 的对象。
- 如果目标 Electron 没有 `node:sqlite`，写一个 better-sqlite3 适配器（实现这六个方法，`transaction` 用 `BEGIN/COMMIT/ROLLBACK` 或 better-sqlite3 的 `transaction`），就能继续用官方 `SqliteStorage`。
- 适配器要保证：`transaction` 内抛错必须回滚；同一个连接上的语句串行。

`NodeSqliteDatabase` 用 `node:sqlite` 的 `DatabaseSync`，预编译语句按 SQL 文本缓存。

---

## 6. 传输编码（本项目不用）

chord 还提供 `WireOp`、`encode`/`decode`、路径驻留（`["#", id, path]`）与短形式。它们是给 WebSocket 远端复制用的。

本项目走 Electron IPC，`Op` 本身就是纯 JSON，**直接传即可**。不要自己实现 wire 编码，也不要手写 op 解析。

如果未来要做「手机端连接桌面 Harness」，再回来看这一块。

---

## 7. 与 pi-durable 的边界

| 你想要的 | 用谁 |
|---|---|
| 提交/读取/订阅对话 | pi-durable |
| 写业务状态 | pi-durable 的 `tx.doc` |
| 取消等待 | chord `withCancel` |
| 应用一帧 | chord `applyImmutable` / `isBase` |
| 打开数据库文件 | pi-durable 的 `openNodeSqliteStorage` |
| 换数据库驱动 | chord `SqliteDatabase` 门面 |

**不要**在业务代码里直接 `openNodeSqliteDatabase` 再自己建表。表结构属于 `SqliteStorage`，自己动会破坏迁移。

---

## 8. 常见失败

| 现象 | 原因 | 修法 |
|---|---|---|
| `cancel()` 后任务还在跑 | 取消的是等待 | 用 `abort()` |
| 旧状态被改了 | 对 `applyImmutable` 的结果做了 mutate | 永远替换，不修改 |
| `UnsafePathError` | 路径里有 `__proto__` 等 | 不信任外部路径；不要手写 ops |
| `applyImmutable(undefined, ops)` 抛错 | 第一批不是 `r` | 先取整帧 |
| 自己建表后升级报错 | 绕过了 `SqliteStorage` | 只用官方存储 |
| 订阅回调阻塞 | 回调里做了重活 | 回调只入队 |

---

## 9. 相关文档

- 增量与订阅：[../02-PI-Durable/04-状态订阅与增量同步.md](../02-PI-Durable/04-状态订阅与增量同步.md)
- 存储与恢复：[../02-PI-Durable/05-存储错误与恢复.md](../02-PI-Durable/05-存储错误与恢复.md)
