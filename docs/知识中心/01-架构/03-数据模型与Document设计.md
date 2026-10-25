# 数据模型与 Document 设计

> 一句话：**聊天记录解释发生了什么，Document 记录现在是什么。** 两者必须在同一个 commit 里更新。

---

## 1. 四种持久化形态

| 形态 | 类型 | 可变性 | 例子 |
|---|---|---|---|
| Entry | 转录记录 | 不可变、只追加 | 用户消息、模型回复、工具结果 |
| Document | 结构化 JSON | 可变，带版本与 checkpoint | `pi.live`、`app.workspace` |
| Task | 状态机 + 检查点 | 按 phase 推进 | 生成回复、ingest |
| Submission | 收件记录 | 状态迁移 | 「这条输入处理完了吗」 |

**不要用 Entry 存业务状态。** Entry 是历史，查「当前待办」要去扫全部历史，既慢又容易漏。业务状态放 Document。

---

## 2. Entry-条目

### 2.1 结构（已核实）

```ts
type EntryRecord = {
  id: EntryId;
  conversationId: ConversationId;
  kind: string;                 // 应用自定义；内置以 pi. 开头
  model?: readonly Message[];   // 贡献给模型上下文的消息
  data?: JsonValue;             // 给 UI / 扩展 / 记账用的数据
  head?: EntryId;               // 开启新上下文的起点
  edits?: readonly ContextEdit[]; // 不影响显示、只影响模型看到的版本
  byTaskId?: TaskId;            // 由哪个任务写入
};
```

两个通道必须分清：

- `model`：给模型：模型真正看到的内容。改了它，模型的行为就变了。
- `data`：给程序：给程序/界面看的内容。模型看不到。

工具结果也是这个模式：`model` 里是给模型的文本，`data.diagnostics` 是给 UI 的结构化诊断。

### 2.2 内置 entry kind（已核实）

| kind | 写入者 | 说明 |
|---|---|---|
| `pi.user` | 提交 | 用户输入 |
| `pi.assistant` | 生成任务 | 模型回复（含 stop reason） |
| `pi.system` | 生成任务 | 提示词/工具集变化的标记 |
| `pi.tool-result` | 工具任务 | 工具结果 |
| `pi.reset` | `reset()` / handoff | 新上下文起点 |
| `pi.compaction` | 压缩任务 | 摘要 |

自定义 kind **不能以 `pi.` 开头**（`InputEntry` 的注释明确要求）。建议统一用 `app.` 前缀：`app.ui_action`、`app.kb_note`、`app.approval`。

### 2.3 用 defineEntry 获得类型收窄

```ts
const UiActionEntry = defineEntry<{ uiId: string; handler: string; payload: unknown }>("app.ui_action");
// UiActionEntry.is(record) 会把 record.data 收窄成上面的类型
```

---

## 3. Document

### 3.1 定义结构（已核实）

```ts
defineDoc({
  kind: "app.workspace",     // 稳定标识，写进存储，改名即破坏兼容
  version: 1,                // 值结构版本
  scope: "conversation",     // "session" | "conversation" | "task"
  history: "latest",         // 仅 conversation：latest | rewindable
  fork: "current",           // latest: current | initial；rewindable 还有 asOf
  initial() { return {...}; },
  migrate?(value, fromVersion) { ... },
  checkpointWhen(value, ops, info) { return ...; }, // 1.4.0 必填
})
```

`checkpointWhen` 是 1.4.0 的**必填字段**（1.3 没有）。它决定一次普通修改是存成完整快照（base）还是增量（delta）：

- 返回 `true`：存完整值。读得快，写得多。
- 返回 `false`：只存 delta。写得省，读时要重放。

`info.deltasSinceBase` 是「自上一个 base 以来已有多少个 delta」。一个稳妥的策略：

```
ops 很大（比如单次修改数组长度 > 20）→ base
deltasSinceBase > 64 → base
否则 delta
```

不要在 `checkpointWhen` 里做 I/O 或依赖时间/随机数；它会在每次修改时被调用。

### 3.2 读与写

| 目的 | API | 说明 |
|---|---|---|
| 读一次 | `session.snapshot(token, ...)` | 返回提交后的只读值，缺失为 `undefined` |
| 订阅 | `session.watchDoc(token, ...)` | 返回 `DocumentWatch`，`start(listener)` 后每帧 `(value, ops)` |
| 跟着视图走 | `ConversationView.docs[kind]` | 无需额外 watch，随对话帧一起到 |
| 写 | `tx.doc(token, ...)` → 修改 draft | 必须在该次 commit 内 |
| 删 | `tx.retireDoc(token, ...)` | 版本仍在历史里，但当前地址不再有活动实例 |

**不要在 `ConversationView.docs` 上做类型断言然后深度修改**。它是 `Readonly<Record<string, JsonObject>>`，是快照。

### 3.3 作用域与生命周期

| scope | 谁拥有 | 典型用途 |
|---|---|---|
| `session` | 整个 Harness | 全局设置、工具清单、知识库索引 |
| `conversation` | 一条会话 | 工作区、智能 UI 状态、审批队列 |
| `task` | 一个任务 | 任务的中间产物（多数情况用检查点就够） |

`history: "rewindable"` 的会话文档支持 `snapshotAsOf(token, convId, entryId, ctx)`，用于「回到某个时间点的状态」。V1 只有 `app.workspace` 需要，其余用 `latest`。

---

## 4. 五个应用文档（设计稿）

> 这些是**你的设计**，不是 SDK 提供的。kind 与字段一旦写进存储就不要改；新增字段用可选字段 + `version` 升级。

### 4.1 `app.settings`（scope: session, history: latest）

```ts
{
  version: 1,
  defaultModel: { provider: string; modelId: string } | null,
  theme: "light" | "dark",
  locale: "zh-CN" | "en-US",
  approvals: {
    bash: "allow" | "ask" | "deny",
    write: "allow" | "ask" | "deny",
    network: "allow" | "ask" | "deny"
  },
  compaction: { enabled: boolean; reserveTokens: number }
}
```

注意：`compaction` 这类运行策略更适合放 `HarnessOptions.settings`（每次读取，不落文档）。`app.settings` 只存**用户偏好**。

### 4.2 `app.workspace`（scope: conversation, history: rewindable, fork: asOf）

```ts
{
  version: 1,
  cwd: string,                    // 相对 userData/workspace 的路径
  pinnedFiles: string[],          // 用户钉住的文件
  lastOpenedFile: string | null
}
```

为什么 rewindable：fork 一条会话时，你希望工作区回到分叉点的样子，而不是当前样子。

### 4.3 `app.toolbox`（scope: session, history: latest）

```ts
{
  version: 1,
  tools: {
    [slug: string]: {
      slug: string,
      name: string,             // 注册进 Extension 的 tool name
      version: number,
      enabled: boolean,
      sourcePath: string,
      installedAt: number,
      lastVerifiedAt: number | null,
      lastVerifyOk: boolean | null
    }
  }
}
```

工具**源码**不放进 Document（太大）。Document 只存索引与状态；源码在 `userData/tools/<slug>/tool.ts`。

### 4.4 `app.kb`（scope: session, history: latest）

```ts
{
  version: 1,
  root: string,                   // 通常是 userData/workspace
  rawDir: "raw",
  wikiDir: "wiki",
  sources: {
    [relPath: string]: {
      status: "new" | "ingesting" | "indexed" | "failed",
      pages: string[],            // 生成的 wiki 页面
      updatedAt: number,
      error?: string
    }
  },
  lastLintAt: number | null
}
```

`sources` 可能很大。如果超过几千条，拆成 document family（`defineDocFamily`，key 用 relPath），不要把所有条目塞进一个文档反复重写。

### 4.5 `app.smartui`（scope: conversation, history: latest）

```ts
{
  version: 1,
  instances: {
    [uiId: string]: {
      toolCallId: string,
      dslVersion: number,
      status: "streaming" | "ready" | "submitted" | "rejected" | "error",
      actionCount: number,        // 已提交的交互次数；用于展示/对账，不是幂等键
      lastError?: string
    }
  }
}
```

它解决两个问题：刷新后知道哪些 UI 还存在；记录哪些卡片已经交互过。

**`requestId` 不由 `actionCount` 生成。** 每次点击由渲染进程生成一个 `crypto.randomUUID()`，拼成 `ui:<uiId>:<actionId>`；同一次点击的重试复用同一个 id。用自增序号会在「提交成功、文档未写」或渲染进程重启时产生重复或冲突。`actionCount` 只用于对账。

---

## 5. 一个完整的 defineDoc 示例

```ts
import { defineDoc } from "@earendil-works/pi-durable";
import { Type, type Static } from "typebox";

const SmartUiState = Type.Object({
  version: Type.Literal(1),
  instances: Type.Record(Type.String(), Type.Object({
    toolCallId: Type.String(),
    dslVersion: Type.Number(),
    status: Type.Union([
      Type.Literal("streaming"), Type.Literal("ready"),
      Type.Literal("submitted"), Type.Literal("rejected"),
      Type.Literal("error"),
    ]),
    actionCount: Type.Number(),
    lastError: Type.Optional(Type.String()),
  })),
});
type SmartUiState = Static<typeof SmartUiState>;

export const AppSmartUiDoc = defineDoc<SmartUiState>({
  kind: "app.smartui",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ version: 1, instances: {} }),
  checkpointWhen: (_value, ops, info) =>
    ops.length > 16 || info.deltasSinceBase > 64,
});
```

要点：

- `defineDoc<T>` 的 T 必须是 `JsonObject`；用 TypeBox 推导类型能保证校验与类型一致。
- `initial()` 返回新对象，不要返回共享常量。
- `version` 同时出现在定义和值里是刻意的：定义版本决定 `migrate`，值里的 version 方便排查。
- `checkpointWhen` 不需要 `async`。

---

## 6. 写入时机：哪些事必须同一个 commit

| 事件 | 同一 commit 内必须一起写 |
|---|---|
| 工具完成 | tool-result entry + `app.*` 业务状态 + `pi.live` 槽位 |
| 智能 UI 生成完成 | `app.smartui` 状态 + （可选）一条 `pi.tool-result` |
| 用户批准危险操作 | `app.approvals` 记录 + 一条 `app.approval` entry |
| ingest 一个阶段完成 | 任务检查点 + `app.kb.sources` 状态 |

理由：崩溃恢复时，读到的要么是「都没发生」，要么是「都发生了」。半写状态是 bug 的温床。

---

## 7. 版本迁移

```ts
migrate(value, fromVersion) {
  if (fromVersion < 2) {
    return { ...value, newField: defaultValue } as Current;
  }
  return value as Current;
}
```

规则：

1. **只增不删。** 删除字段会让旧数据在类型上撒谎；先标记 deprecated，两个版本后再删。
2. **`version` 只增。** 每次改结构 +1。
3. **迁移函数必须纯。** 它可能在任意一次读取时对任意旧记录执行。
4. 不确定时，加新 Document，不要改旧的。

---

## 8. Task 作为数据模型

Task 不是「后台线程」，而是**持久化的状态机**：

```ts
defineTask({
  name: "app.kb.ingest",
  version: 1,
  initial(input) { return { phase: "read", ... }; },
  phases: {
    read: async (task, rt, ctx) => { ... rt.commit(...) },
    summarize: async (task, rt, ctx) => { ... },
    write: async (task, rt, ctx) => { ... },
    done: async (task, rt, ctx) => { ... },
  },
  abort: async (task, rt, ctx) => { /* 必须提交一个 terminal 状态 */ },
});
```

- `rt.commit()` 返回的下一个 state 会在同一个 commit 里替换任务状态。
- 长等待用 `rt.sleepUntil(ms, checkpoint, ctx)`（1.4.0 起没有 `sleep()`）。
- 阶段处理器里拿不到 `executeTool`。`TaskRuntime` 没有这个方法（已核实）；需要调用工具时，用会话句柄提交，或把这段逻辑写成 Tool。详见 [待验证清单](../04-API/待验证清单.md)。

---

## 9. 设计检查表

写完一个 Document 前，逐条问：

- [ ] kind 是否以 `app.` 开头，且以后不会改？
- [ ] 这个值需要跨重启保留吗？如果只是 UI 临时状态，不要建 Document。
- [ ] 有没有可能无限增长？（列表要不要拆 family？）
- [ ] `checkpointWhen` 在最坏情况下会不会每帧都写整份？
- [ ] 它的更新是否总和某条 entry 在同一个 commit？
- [ ] fork 时应该继承 `current`、`initial` 还是 `asOf`？
- [ ] 模型需要看到它吗？需要的话，是通过工具读，还是塞进系统提示词段落？
