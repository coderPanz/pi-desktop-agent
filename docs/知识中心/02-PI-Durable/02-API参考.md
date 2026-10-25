# PI-Durable API 参考（1.4.0）

> 只写**已核实**的接口。每条都给出包内类型定义的位置，安装后可在 `node_modules` 里对照。
> 标「待验证」的项见 [../04-API/待验证清单.md](../04-API/待验证清单.md)。

版本：`@earendil-works/pi-durable@1.4.0`（依赖 chord 1.4.0、pi-ai 1.4.0、typebox 1.3.27）。

---

## 0. 导入路径

```ts
// 主入口：Harness、Registry、工具/扩展/任务定义、内置文档、错误
import {
  Harness, createRegistry, defineTool, defineExtension, defineTask,
  defineDoc, defineDocFamily, defineEntry, section, hook, wrapTool, wrapSection,
  MemoryStorage, ROOT_CONVERSATION_ID,
  UserEntry, AssistantEntry, ToolResultEntry, SystemEntry, ResetEntry, CompactionEntry,
  LiveDoc, InboxDoc, UsageDoc, AgentDoc, ProviderDoc,
  ConversationBusy, ReadAfterWrite, SessionFailed, StorageRequestError,
} from "@earendil-works/pi-durable";

// 存储
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";

// 执行环境
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

// 内置工具
import { createCodingTools, CodingTools } from "@earendil-works/pi-durable/tools";

// 类型
import type {
  HarnessOptions, HarnessSettings, AgentChange, AgentState, Agent,
  Conversation, ConversationView, ConversationCreateOptions,
  Submission, SubmissionDraft, SubmissionRecord,
  ToolRegistration, ToolExecutionApi, ToolExecutionResult, ToolDiagnostic,
  Extension, Registry, RegistrySnapshot, Task, TaskRuntime, TaskRecord,
  EntryRecord, DocumentState, WatchHandle, DocumentWatch, Session, SessionEnd, Tx,
} from "@earendil-works/pi-durable";
```

> 子路径以 `package.json` 的 `exports` 为准。上面四条子路径均已核实存在。

---

## 1. Harness 生命周期

### `Harness.open(storage, options, context): Promise<Harness>`

```ts
const harness = await Harness.open(storage, {
  models,                 // pi-ai 的 Models，或 () => Models
  registry,               // RegistryReader
  settings,               // HarnessSettings 或 () => HarnessSettings | undefined
  env,                    // (target, ctx) => ExecutionEnv | undefined | Promise<...>
  identity,               // 可选：请求标识，默认向 provider 标明 pi 来源
  telemetry, onReport, now, setTimer, onWake, conversationCreated,
}, context);
```

`HarnessOptions` 的关键字段（`dist/harness/types.d.ts`）：

| 字段 | 必填 | 说明 |
|---|---|---|
| `models` | 是 | 每次使用时读取，可传函数以支持热更换模型目录 |
| `registry` | 是 | 只要 `snapshot()` + `subscribe()` 的读接口 |
| `settings` | 否 | 运行策略，见第 7 节 |
| `env` | 否 | 每次工具调用/提示词渲染时构建环境；**不在 Session 行上调用**，可以 async |
| `onReport` | 否 | 接收不使调用失败的错误：Hook 抛错、任务 fault、Session 失败 |
| `now` | 否 | Harness 时钟，默认 `Date.now`。同一存储的所有进程必须用同一时钟 |
| `onWake` | 否 | 需要外部唤醒（如 Durable Object alarm）时使用；普通桌面应用不用 |

`Harness` 同时是 `Session`，所以 `commit` / `snapshot` / `watchDoc` / `closed` 都可直接调用。

### `harness.resume(): void`

**开启任务调度。幂等。关闭后调用会抛错。**

不调用它，`submit()` 写进去了但任务不会跑。除显式调用外，任何「要进度」的操作也会自动开启：`submit()`、`compact()`、`abort()`、`submission.wait()`、`waitForTask()`、`waitForIdle()`。只读观察者不会。

### `harness.wake(): Wake`

当前是否需要进程。`{active:true}` 表示有任务可跑或正在跑；`{at:number}` 表示最早一个 sleep 的时间；都没有则 `{}`。桌面应用一般用不到，但调试「为什么任务不动了」时很有用。

### `harness.closed: Promise<SessionEnd>`

```ts
type SessionEnd = { reason: "closed" } | { reason: "failed"; error: unknown };
```

**存储错误会让 Session 自行关闭。** 监听它，`failed` 时重新 open。不要尝试在原 Harness 上继续。

### `harness.close(context): Promise<void>`

先封住新提交，结算已接收的 commit，再关闭 Storage。

### `harness.root(context, options?): Promise<Conversation>`

返回保留的根会话；不存在时用一个 commit 创建。`options` 可给 `agent`（初始配置）和 `init`（在创建事务里写文档）。

### `harness.conversation(id, ctx)` / `harness.createConversation(options, ctx)`

- `conversation(id)` 不存在返回 `undefined`。
- `createConversation({ ownership, agent?, init? })`，`ownership` 必填：`{kind:"ownerless"}` 或 `{kind:"task", taskId}`。

### `harness.inspect(context)` / `harness.taskGraph(context)` / `harness.watchTaskGraph(context)`

- `inspect()`：当前调度状态、每个活任务的调度判定（`running/ready/waiting/sleeping/completing/blocked`）、未结算提交。**只读，不跑任务代码。**
- `taskGraph()`：`AttachedReplicatedState<TaskGraph>`，任务面板用。
- `watchTaskGraph()`：`WatchHandle<TaskGraph>`。

### 其它

| 方法 | 用途 |
|---|---|
| `getTask(id, ctx)` | 读一条任务记录 |
| `submission(id, ctx)` | 重新取得一个提交（重开后） |
| `abortSubmission(id, ctx, convId?)` | 撤回提交 |
| `abortTask(id, ctx)` | 标记并中止任务 |
| `retryTask(id, ctx)` | 重跑被 restartLimit park 的任务 |
| `waitForTask(id, ctx)` | 等一个任务到终态 |
| `waitForIdle(ctx)` | 等所有无主会话的普通任务结束 |
| `usage(ctx)` | 汇总所有会话用量 |

---


## 2. Conversation

`Conversation` 是一个**无状态句柄**，按 `id` 比较。所有操作都要 `context`。

### 2.1 提交

```ts
type SubmissionDraft = { requestId?: string } & (
  | { type: "input"; content: UserInput; whenBusy?: "steer" | "followUp" | "reject";
      entry?: { kind: string; data?: JsonValue } }
  | { type: "write"; entry: EntryDraft }
);
```

```ts
const submission = await conversation.submit(
  { type: "input", content: "分析这个仓库", requestId: crypto.randomUUID() },
  context,
);
```

- `content` 是 `UserMessage["content"]`（字符串或多模态内容数组）。
- `entry` 可以把输入放进自定义 entry（如 `app.ui_action`），但 `kind` **不能以 `pi.` 开头**。
- `requestId` 是会话内去重键。相同 `requestId` 的重复提交命中同一条记录。
- 忙碌时的策略见第 5 节。

### 2.2 等待

```ts
interface Submission {
  id: SubmissionId;
  status(ctx): Promise<SubmissionRecord>;
  wait(ctx): Promise<SettledSubmissionRecord>; // status: "done" | "unanswered"
  abort(ctx): Promise<"aborted" | "already_placed" | "settled">;
}
```

`wait()` 会**开启调度**。取消 `ctx` 只取消等待，不取消任务。

### 2.3 配置

```ts
await conversation.configure({
  model: { provider: "anthropic", modelId: "..." }, // null 清除
  thinkingLevel: "medium",
  extensions: { add: ["kb"], remove: [] },
  tools: ["read", "bash"],
  modelTools: { remove: ["dangerous"] },
  instructions: "只读模式",
  cwd: "workspace",
}, context);
```

`AgentChange` 的语义：字段给定则替换，`null` 清除，`undefined` 不变。`extensions` / `tools` / `modelTools` 在 change 里用**对象数组**（不是名字），存储在 `AgentState` 里才是名字。

### 2.4 转录与上下文

```ts
const page = await conversation.entries(
  { order: "descending" }, // 除 conversationId 外的 EntryQuery
  50,
  cursor,
  context,
);

const view = await conversation.context(context, { at: entryId });
// { head, entries, contributions, messages }
```

`context()` 给的是**模型实际看到的**消息（已合并编辑、去掉被排除的 stop reason、排好工具结果顺序）。做「查看上下文」面板时用它，不要自己拼 entry。

### 2.5 fork / reset / compact / abort

| 方法 | 语义 |
|---|---|
| `fork(at, options, ctx)` | 在某个可见 entry 处分叉；继承历史与配置，新会话有新的 provider session |
| `reset(handoff, ctx)` | 写一条 `pi.reset`，开启新上下文；旧历史保留但不再自动喂模型 |
| `compact(instructions, ctx)` | 提交压缩任务，返回 `TaskId<CompactionResult>` |
| `abort(ctx, {background?})` | 撤回排队输入、标记并等待普通任务结束；`background:true` 跨后台边界 |
| `waitForIdle(ctx)` | 等普通所有权范围空闲 |

`abort()` 返回时，普通任务已经 terminal。渲染层可以立即把「停止」按钮置灰。

### 2.6 订阅

```ts
const state = await conversation.viewState(context); // AttachedReplicatedState<ConversationView>
const off = state.subscribe((view, ctx, delivery) => { /* hydrate | update */ });
state.dispose();

const watch = await conversation.watch(context);      // WatchHandle<ConversationView>
watch.start(async (value, ops, ctx) => { /* 跨 IPC 发送 ops */ });
await watch.stop();
```

区别：

- `viewState()` 是**本地**订阅，回调拿完整值，没有 ops。适合主进程内部。
- `watch()` 是**序列化帧**，回调拿 `(value, ops)`，适合跨进程。最多积压 100 帧，超过后折叠成一整帧。
- `watch.start()` 只能调用一次；不会同步回调；停止后 `closed` 结算。

---

## 3. Document

### 3.1 定义

```ts
defineDoc<T extends JsonObject>({
  kind: string,
  version: number,
  initial(): T,
  migrate?(value, fromVersion): T,
  checkpointWhen(value, ops, info): boolean,   // 1.4.0 必填
  // 作用域三选一：
  scope: "session" | "task" | "conversation",
  // conversation 还需：
  history?: "latest" | "rewindable",
  fork?: "current" | "initial" | "asOf",
})
```

`defineDocFamily` 多一个 `family: true` 与 `initial(seed: I)`，按 key 分实例。

### 3.2 读

```ts
session.snapshot(token, context)                                  // session 作用域
session.snapshot(token, conversationId, context)                  // conversation
session.snapshot(token, taskId, context)                          // task
session.snapshot(token, key, context)                             // family

session.documentState(token, ..., context)  // AttachedReplicatedState<Readonly<T> | null>
session.watchDoc(token, ..., context)       // DocumentWatch<T> | undefined
session.snapshotAsOf(token, convId, entryId, context) // 仅 rewindable
```

- `snapshot` 返回 `undefined` 表示文档还不存在（从未写过）。
- `watchDoc` 对不存在的文档返回 `undefined`；它**不会创建**文档。
- `documentState` 的回调签名是 `(value, ctx, delivery)`。

### 3.3 写

只能在一个 commit 里：

```ts
await conversation.commit(async (tx) => {
  const draft = await tx.doc(AppWorkspaceDoc, conversation.id);
  draft.cwd = "workspace";
  draft.pinnedFiles.push("README.md");
  return undefined;
}, context);
```

- `tx.doc(token, ...)` 的返回是 `Draft<T>`，直接改属性；commit 结束时统一按 diff 生成 ops。
- 文件族：`tx.doc(token, conversationId, key, seed)`。
- `tx.retireDoc(token, ...)` 退役当前实例。
- **commit 回调里只能通过 `tx` 读**。调用 `session.snapshot()`、`watchDoc()`、`getTask()` 等会排在当前行后面，**可能永远不返回**（`ReadAfterWrite` 或死锁）。

### 3.4 内置文档

| Token | kind | 作用域 | 内容 |
|---|---|---|---|
| `AgentDoc` | `pi.agent` | conversation（rewindable） | `AgentState` |
| `LiveDoc` | `pi.live` | conversation | 运行控制、生成中消息、工具槽位、压缩状态 |
| `InboxDoc` | `pi.inbox` | conversation | 排队输入与写 |
| `UsageDoc` | `pi.usage` | conversation | 按 provider/model 累计的 token 与费用 |
| `ProviderDoc` | `pi.provider` | conversation | provider 会话状态 |

`ConversationView.docs` 以这些 kind 为键，值是 `JsonObject`（**没有类型参数**）。需要类型时用 token + `snapshot()`/`watchDoc()`。

---

## 4. 工具

### 4.1 `defineTool`

```ts
defineTool<TParameters extends TSchema, TDetails extends JsonValue = JsonValue>(
  tool: ToolRegistration<TParameters, TDetails>
): ToolRegistration<TParameters, TDetails>
```

字段（`dist/harness/types.d.ts`）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `name` / `description` / `parameters` | — | `parameters` 是 TypeBox schema，执行前校验 |
| `execute(args, api, ctx)` | — | 返回 `ToolExecutionResult` |
| `replay` | `"unsafe"` | 崩溃后是否可重跑 |
| `executionMode` | 跟随 settings | `"parallel" \| "sequential"`；一个 sequential 调用会让整轮顺序执行 |
| `prepareArguments(args)` | — | 校验前修复模型常犯的参数错误；必须纯、不可变 |
| `structuredOutputSchema` | — | 程序调用方拿到的结构；有它时必须在结果里给 `structuredOutput` |
| `callers` | `["model","tools"]` | 谁能调用 |
| `deferred` | — | 不直接给模型，直到被 `modelTools.add` 或 `control.addTools` 加载 |
| `outputLimits` | — | `maxBytes` / `maxLines` / `retain: "head" \| "tail"` |

### 4.2 `ToolExecutionResult`

```ts
{
  output?: ToolResultMessage["content"], // 给模型；省略则用 api.output() 累积的文本
  structuredOutput?: JsonValue,          // 给程序；有 schema 时必填（除非 isError）
  isError?: boolean,
  details?: JsonValue,                   // 给 UI；省略则用最后一次 api.details()
  diagnostics?: readonly ToolDiagnostic[],
  usage?: Usage,
  control?: { addTools?: string[]; terminate?: boolean; handoff?: string },
}
```

### 4.3 `ToolExecutionApi`

| 成员 | 用途 |
|---|---|
| `taskId` / `conversationId` / `callId` / `registry` | 身份与当前注册表快照 |
| `agent(ctx)` | 调用方会话解析后的 Agent |
| `models` | 当前 `HarnessOptions.models` |
| `env` | 本次调用的 `ExecutionEnv`（可能 `undefined`） |
| `now()` | Harness 时钟（1.4.0 新增） |
| `output(chunk, skipped?)` | 追加运行中输出 |
| `retainedOutput()` | 当前保留的输出与是否截断 |
| `outputWindow` | 输出窗口配置（用了窗口才非空） |
| `diagnostic(d)` | 记录给模型与 UI 的提示 |
| `details(v, ctx)` | 更新 UI 详情（受 progress 节流） |
| `commit(fn, ctx)` | 在一个 commit 里写业务状态 |
| `memo(name, ctx)` / `memo(name, candidate, ctx)` | 任务内持久化的键值备忘 |
| `createTask(task, input, options, ctx)` | 创建一个子任务 |
| `getTask` / `waitForTask` | 读/等子任务 |
| `abortOwned`（在 TaskRuntime 上）/ `conversation(id, ctx)` | 会话句柄 |
| `executeTool(name, args, ctx, {key?, progress?})` | 嵌套调用另一个工具 |

`executeTool` 的行为（已核实）：

- 嵌套调用是独立的 `pi.tool` 任务，归本次调用所有。
- 结果**不进入转录**，只返回给调用方。
- `key` 用于重放幂等；同 key 不同工具/参数会抛错。
- 被 block、参数非法、抛错、被中断、被 abort，都会返回 `isError` 结果，而不是 reject。
- `execute()` 返回之后再调用会 reject。

### 4.4 工具里怎么报错

两条路，语义不同：

```ts
// 1) 业务失败，模型应当看到并可能重试
return { output: "文件不存在: x", isError: true };

// 2) 代码 bug / 不可恢复，交给框架转成错误结果
throw new Error("boom");
```

不要把「用户取消了」当成异常抛；返回 `isError: true` 并写清楚原因，模型才知道下一步做什么。

---

## 5. 忙碌、排队与边界

| 提交方式 | 空闲时 | 忙碌时 |
|---|---|---|
| `input`（默认） | 立即开始 run | 排入 `pi.inbox`，本轮结束后处理 |
| `input` + `steer` | 立即开始 | 当前工具轮结束后插入 |
| `input` + `reject` | 立即开始 | 抛 `ConversationBusy`，不写任何东西 |
| `write`（只 kind+data） | 立即写 | 立即写（不改变模型上下文） |
| `write`（含 model/head/edits） | 立即写 | 排队 |

`HarnessSettings.steeringMode` / `followUpMode` 控制每轮放一个还是全部（`"one-at-a-time" | "all"`）。

---

## 6. Extension / Task / Hook

### 6.1 Extension

```ts
defineExtension({
  name: "kb",
  tools: [KbSearchTool, KbReadTool],
  sections: [section("kb.rules", async () => "…")],
  hooks: [hook(GenerationTask, { ... })],
  wraps: [wrapTool(BashTool, (t) => ({ ...t, execute: ... }))],
  tasks: [KbIngestTask],
});
```

- `registry.install(ext)`：安装或**同名替换**，立即发布。
- `registry.uninstall(ext)`：按名字移除。
- 运行中的调用继续用启动时解析到的代码；后续调用用新代码。
- `section(key, render, {tag})` 默认把文本包成 `<key>…</key>`。
- `wrapTool` / `wrapSection` 是纯函数，必须返回新对象，不能原地改。

### 6.2 Task

```ts
defineTask({
  name: string,
  version: number,
  initial(input): S,
  phases: { [P in S["phase"]]: (task, runtime, ctx) => Promise<void> },
  abort(task, runtime, ctx): Promise<void>,
  migrate?(input, checkpoint, fromVersion),
  hooks?: H,
})
```

`TaskRuntime` 提供：`taskId`、`conversationId`、`signal`、`registry`、`agent(ctx)`、`settings`、`models`、`env(ctx)`、`hooks.each(...)`、`commit(fn, ctx)`、`memo`、`getTask`、`waitForTask`、`abortOwned`、`ownedTasks`、`outcomes`、`conversation(id, ctx)`、`entry(id, ctx)`、`context(convId, ctx, {at})`、`now()`、`setTimer`、`report`、`sleepUntil(until, checkpoint, ctx)`。

**注意：`TaskRuntime` 没有 `executeTool`。** 需要调工具时：

- 把这段逻辑做成 Tool，用 `api.executeTool`；
- 或者通过 `runtime.conversation(id, ctx)` 提交输入，等生成的回合；
- 或者直接调用 `runtime.models`。

1.4.0 的 `sleep()` 已被 `sleepUntil()` 取代，状态里新增 `sleeping`。

### 6.3 Hook

```ts
hook(GenerationTask, {
  beforeRequest({messages}, api, ctx) { return { messages: [...] }; },
  afterResponse(message, api, ctx) {},
  onYield(answer, api, ctx) { return { continue: "..." }; },
  afterTools(assistantEntryId, resultEntryIds, api, ctx) {},
})

hook(ToolTask, {
  beforeTool(call, api, ctx) { return { block: "需要审批" }; },
  afterTool(call, result, api, ctx) { return { ...result, output: "[已渲染]" }; },
})

hook(CompactionTask, {
  beforeCompact(info, api, ctx) { return { decline: true }; },
})
```

- Hook 按扩展选择顺序执行，`HookRunner.each` 负责组合。
- `beforeTool` 的第一个 `block` 生效；抛错等同 block。
- Hook 抛错通常被报告后跳过，不会杀任务。

---

## 7. Settings

```ts
type HarnessSettings = {
  extensions?: readonly Extension[];     // 默认选择，缺省为全部已安装
  stream?: ConversationStreamOptions;
  retry?: Partial<ConversationRetryPolicy>;
  compaction?: CompactionSettings;
  progress?: { partialIntervalMs?: number; outputIntervalMs?: number };
  toolExecution?: "parallel" | "sequential";
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  contextRetentionMs?: number;
  documentRetentionMs?: number;
  afterFailedRun?: "keep" | "continue" | "withdraw";
  restartLimit?: number;                 // 默认 5
};
```

`settings` 可以是对象或函数，**每次使用时读取**。所以可以在不重开 Harness 的情况下改压缩策略、进度节流。

---

## 8. 存储

### 8.1 选择

| 实现 | 打开方式 | 适用 |
|---|---|---|
| `MemoryStorage` | `new MemoryStorage()` | 测试、阶段 0–3 |
| SQLite（Node 内置） | `await openNodeSqliteStorage(path, {busyTimeoutMs, walAutoCheckpointPages})` | 生产 |
| JSONL | `await openNodeJsonlStorage(dir, ctx, {fsync})` | 调试、审计 |

SQLite 打开返回 `SqliteStorage`，实现完整的 `Storage` 接口。

### 8.2 契约要点

- `commit(writes, ctx)` 必须原子；resolve 之后读必须能看到。
- `mintId()` 必须给出全局单调的 ID，跨重开也成立。
- 任何 `Storage` 方法抛错（除调用方取消）都会**终止 Session**。
- 读的两类错误不致命：`StorageRequestError`（非法请求）与调用方取消。
- `SqliteStorage.open(db, options)` 接受 chord 的 `SqliteDatabase` 门面；`SqliteDatabase` 只有 `exec/run/get/all/transaction/close` 六个成员（已核实）。这为「不用 `node:sqlite`」留了后路。

---

## 9. 环境

```ts
new NodeExecutionEnv({ cwd, shellPath?, shellEnv?, watch? })
```

`HarnessOptions.env` 是一个工厂：

```ts
env: (target, ctx) => new NodeExecutionEnv({ cwd: target.cwd ?? workspaceRoot })
```

`target` 含 `conversationId`、`cwd`、`read`（文档读取器）。`env` 可能在工具调用与提示词渲染时被调用，**不要在这里做重活**。

---

## 10. 错误

| 类 | 何时 | 处理 |
|---|---|---|
| `SessionFailed` | Storage 失败后，Session 已关闭 | 重开 Harness |
| `StorageRequestError` | 非法读取请求 | 修正请求，不影响 Session |
| `ReadAfterWrite` | 在 commit 内先写表再读表 | 改为只通过 `tx` 读 |
| `ConversationBusy` | `whenBusy:"reject"` 且忙 | 转为排队或提示 |

`SessionFailed` 之后**不要** catch 后继续用。`harness.closed` 会给出原因。

---

## 11. 常见误用（都是 1.4.0 的真实差异）

| 写法 | 问题 | 正确写法 |
|---|---|---|
| `defineDoc({...})` 不含 `checkpointWhen` | 1.4.0 编译期/运行期校验失败 | 提供 `checkpointWhen` |
| `runtime.executeTool(...)` in a Task | `TaskRuntime` 没有此方法 | 用 Tool + `api.executeTool` |
| `rt.sleep(ms, ...)` | 1.4.0 已移除 | `rt.sleepUntil(until, checkpoint, ctx)` |
| `watch.start((value) => ...)` | 可以，但拿不到 ops | `(value, ops, ctx) => ...` |
| `conversation.watch()` 后不 `start()` | 永远收不到帧 | 必须 `start()` |
| 用 `docs["pi.live"] as LiveState` | `docs` 是 `JsonObject`，不做运行时校验 | 用 `LiveDoc` + `snapshot()`/`watchDoc()`，或写校验函数 |
| 在 commit 回调里 `await session.snapshot()` | 排在同一行后面，死锁 | 用 `tx` 读 |
| 用 1.3.0 打开 1.4.0 的 SQLite | schema v2 不兼容 | 统一 1.4.0 |
| 把 `TaskId` 当 string 存 | 品牌 number，比较/序列化会出错 | 存 number，显示时 `String(id)` |

---

## 12. 源码位置索引

| 内容 | 包内路径 |
|---|---|
| Harness / Conversation / Tool / Extension 类型 | `pi-durable/dist/harness/types.d.ts` |
| ConversationView | `pi-durable/dist/harness/view.d.ts` |
| LiveState / ToolSlot | `pi-durable/dist/harness/live.d.ts` |
| Session / Storage / Tx / Entry / Task | `pi-durable/dist/types.d.ts` |
| defineDoc / defineDocFamily | `pi-durable/dist/documents.d.ts` |
| defineTool / defineExtension / hook | `pi-durable/dist/harness/define.d.ts` |
| defineTask | `pi-durable/dist/tasks.d.ts` |
| createRegistry | `pi-durable/dist/harness/registry.d.ts` |
| SQLite 存储 | `pi-durable/dist/storage/sqlite/{node,storage}.d.ts` |
| Node 环境 | `pi-durable/dist/env/node.d.ts` |
| 内置工具 | `pi-durable/dist/tools/index.d.ts` |
| 错误 | `pi-durable/dist/errors.d.ts` |
| 变更记录 | `pi-durable/CHANGELOG.md` |
