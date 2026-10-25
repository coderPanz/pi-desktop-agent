# 阶段 6：渲染进程 replica 与聊天 UI

> **目标**：把阶段 5 的空页面变成一个能用的聊天窗口：流式文字、工具卡、停止、排队提示、重连。
> **预计**：1–2 周。**产出**：可日常使用的聊天界面 + 一套 store 单测。

---

## 1. 前置概念

- **渲染进程没有真相。** 它只把帧应用到不可变副本，再把副本画出来。
- **不做乐观插入。** 你发出的消息可能排队、可能被拒；等 watch 帧最晚 100ms。
- **seq 是丢帧的唯一证据。** 不连续就重连，不要尝试补帧。
- **整帧必须覆盖。** `isBase(ops)` 为真时，绝不能当增量应用。
- **流式文本只有两个来源**：`entries` 里已提交的 assistant，和 `pi.live.generation.message`。二者不能同时显示。
- **工具结果按 `toolCallId` 关联**，不按相邻顺序。
- **滚动是用户的所有权。** 用户向上翻时不要抢。

---

## 2. 先读哪些文档

1. [渲染进程 replica](../03-Electron/03-渲染进程replica.md) —— 全文
2. [状态订阅与增量同步](../02-PI-Durable/04-状态订阅与增量同步.md) —— 第 3–6 节
3. [IPC 契约](../03-Electron/02-IPC契约与preload.md) —— 第 7、8 节
4. [数据模型](../01-架构/03-数据模型与Document设计.md) —— Entry 两个通道
5. [chord API](../04-API/chord.md) —— `Op` / `applyImmutable` / `isBase`

---

## 3. 架构位置与模块协作

```
apps/desktop/renderer/src/
├─ store/
│  ├─ conv-store.ts        纯 TS：state + applyFrame + resync
│  └─ registry.ts          按 convId 取单例 store
├─ hooks/
│  ├─ use-conv.ts          useSyncExternalStore
│  └─ use-live.ts          从 view.docs 提取 live 的校验后视图
├─ lib/
│  ├─ group.ts             扁平 entries → 轮次
│  ├─ content.ts           content blocks → 文本/thinking/tool_call
│  ├─ live-guard.ts        运行时校验 pi.live / tool details
│  └─ scroll.ts            「是否在底部」判定
├─ views/chat/
│  ├─ ChatView.tsx
│  ├─ MessageList.tsx
│  ├─ MessageBubble.tsx
│  ├─ ToolCard.tsx
│  ├─ Composer.tsx
│  └─ StatusBar.tsx
└─ App.tsx
```

调用关系：

```
window.pi.onView ──▶ registry.get(convId).applyFrame
                              │
                              ▼
                    useSyncExternalStore
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
        MessageList      StatusBar        Composer
         （稳定条目）      （live.run）     （提交命令）
              │
              └─ StreamingBubble（只读 generation.message）
```

**关键拆分**：`MessageList` 只读 `view.entries`；`StreamingBubble` 只读 `live.generation`。这样 100ms 一次的部分消息不会让整个历史列表重渲染。

---

## 4. API 清单

| 目的 | API | 注意 |
|---|---|---|
| 开场 | `window.pi.conv.open({convId})` | 返回 `{view, seq}` |
| 订阅 | `window.pi.onView(cb)` | 返回 unsubscribe |
| 提交 | `window.pi.conv.submit({convId, text, requestId, whenBusy?})` | 返回 submissionId |
| 停止 | `window.pi.conv.abort({convId})` | 等帧更新，不本地改 |
| 翻历史 | `window.pi.conv.entries({convId, before, limit})` | 游标分页 |
| 应用 | `applyImmutable(view, ops)` | chord |
| 判整帧 | `isBase(ops)` | chord |
| React | `useSyncExternalStore(subscribe, getSnapshot, getSnapshot)` | 快照引用必须稳定 |
| 调试 | `window.pi.app.info()` | 版本与 workspace |

本阶段不接 TokUI，不接知识库、不接工具自举。

---

## 5. 手写任务

### 5.0 落地顺序与可手写代码

先写不依赖 React 的副本 store，并把跳号恢复限定为异步旁路；UI 只订阅稳定快照。

```ts
export class ConvStore { // 定义每个会话独占的渲染进程副本仓库。
  private state: ConvState; // 保存唯一且引用稳定的当前状态对象。
  private listeners = new Set<() => void>(); // 保存 React 外部仓库订阅者。
  private resyncing = false; // 防止多个跳号帧并发触发重连。
  constructor(private readonly open: () => Promise<OpenResult>, convId: number) { this.state = { convId, view: null, seq: 0, status: "loading" }; } // 初始化空副本和会话标识。
  getSnapshot = () => this.state; // 始终返回当前对象而不是临时复制对象。
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => this.listeners.delete(fn); }; // 注册并返回可释放的订阅。
  applyFrame(frame: ViewFrame): void { // 同步应用来自主进程的状态帧。
    if (frame.convId !== this.state.convId || frame.seq === this.state.seq) return; // 忽略串会话帧和重复帧。
    if (frame.seq !== this.state.seq + 1) { void this.resync(); return; } // 遇到跳号时保留旧画面并异步重连。
    const view = isBase(frame.ops) ? applyImmutable(undefined, frame.ops) : applyImmutable(this.state.view, frame.ops); // 按整帧或增量帧重建新视图。
    this.state = { ...this.state, view, seq: frame.seq, status: "ready" }; // 只替换状态引用而不修改旧快照。
    this.listeners.forEach((fn) => fn()); // 在新状态完整就绪后通知所有订阅者。
  } // 结束帧应用方法。
  private async resync(): Promise<void> { // 定义跳号后的单飞重连流程。
    if (this.resyncing) return; // 已在重连时不再发起第二个打开请求。
    this.resyncing = true; // 先上锁避免后续帧造成重连风暴。
    try { const next = await this.open(); this.state = { ...this.state, ...next, status: "ready" }; this.listeners.forEach((fn) => fn()); } finally { this.resyncing = false; } // 用主进程快照替换本地副本并最终释放锁。
  } // 结束重连方法。
} // 结束会话副本仓库。
```

### 5.1 `store/conv-store.ts`（纯 TS，不 import React）

```ts
type ConvState = {
  convId: number;
  view: ConversationView | null;
  seq: number;
  status: "idle" | "loading" | "ready" | "resyncing" | "failed";
  error?: IpcError;
};
```

实现：

- `getSnapshot()`：返回当前 state 引用。
- `subscribe(fn)`：`Set` + unsubscribe。
- `replaceView(view, seq)`：`conv.open` / resync 成功后调用。
- `applyFrame(frame)`：
  1. `convId` 不符 → 忽略。
  2. 与当前 seq 相同 → 忽略。
  3. `seq !== last + 1` → 触发 `resync()`，**保留旧 view**。
  4. `isBase(ops)` → 覆盖；否则 `applyImmutable`。
  5. 替换 state，通知订阅者。
- `resync()`：去重锁（`resyncing` 标志），`conv.open` 成功后 `replaceView`；失败 → `status:"failed"`。

要求：

- 任何路径都不 mutate 旧 state / 旧 view。
- `applyFrame` 必须是同步的（resync 异步触发，不 await）。

### 5.2 `store/registry.ts`

- `getConvStore(convId)`：Map 缓存。
- `hydrate(convId)`：`conv.open` → `replaceView`。
- 全局只注册**一次** `onView`：在 `App` 挂载时订阅，帧进来后按 `convId` 分发到对应 store。
- 卸载时 unsubscribe。

### 5.3 `lib/live-guard.ts`

`ConversationView.docs` 是 `JsonObject`，**没有运行时校验**。写类型守卫：

```ts
export function readLive(view: ConversationView): LiveView | null
export function readToolSlot(v: unknown): ToolSlotView | null
```

只读取你确实要用的字段：`live.run` 是否存在、`generation.message`、`tools[]` 的 `callId/name/status/output/details/entry`。

未知字段忽略，类型不符就返回 `null`，不要让一个坏帧炸整页。

### 5.4 `lib/group.ts`

把 `EntryRecord[]` 分组：

```
[{ kind:"user", entry }, { kind:"assistant", entry, toolResults: Map<callId, entry> }, ...]
```

规则：

- 新的 `pi.user` 开始一轮。
- `pi.assistant` 的 `tool_calls` 与后续 `pi.tool-result` 按 `toolCallId` 关联。
- `pi.system` / `pi.compaction` / `pi.reset` / `app.*` 各自处理，默认折叠或隐藏。
- **不要假设工具结果紧跟在 assistant 后面。**

### 5.5 `views/chat/ChatView.tsx`

- `useConv(convId)` → state。
- loading：骨架；failed：错误 + 重试；ready：列表 + composer。
- 挂载时 `hydrate`，卸载时不断开 store（切换会话保留副本）。
- 顶部或底部显示 `StatusBar`。

### 5.6 `MessageList.tsx` + `MessageBubble.tsx`

- `MessageBubble` 按轮次渲染：用户气泡、assistant 文本、thinking 折叠、工具卡。
- Markdown：先只支持纯文本 + 代码块；不要第一天就接完整 Markdown 渲染器。
- `key` 用 entry id。
- 历史超过 200 条时接虚拟列表；先做「分页加载更多」，虚拟化留到最后。

### 5.7 `StreamingBubble.tsx`

- 来源：`live.run` 存在时的 `live.generation.message`。
- 按 content block 渲染：`text` / `thinking` / `tool_call`。
- `live.run` 不存在 → 返回 null。
- **不要**把它和最后一条 assistant entry 同时渲染。切换时以 entry 为准（entry 落盘后 `generation` 会消失）。

### 5.8 `ToolCard.tsx`

- 数据：`live.tools` 中 `running` / `pending` 的槽位；完成后优先用 `entry` 指向的结果。
- 显示：工具名、状态、输出最后 3–5 行、`details` 的已知形状（例如 `path`、`exitCode`）、截断提示。
- `details` 不可信：只认你定义的字段，其他忽略。
- 折叠/展开只影响本地展示状态，不写回任何 store。

### 5.9 `Composer.tsx`

- Enter 发送，Shift+Enter 换行。
- `requestId = crypto.randomUUID()` **每次发送生成**。
- 运行时：发送按钮变「排队」（或按用户选择的 `whenBusy`），旁边出现「停止」。
- 停止：`conv.abort`，**不本地移除消息**；等 `live.run` 消失。
- 错误：`BUSY` → 提示并可选转排队；`SESSION_FAILED` → 进入恢复态并禁用输入。

### 5.10 `lib/scroll.ts`

- `isNearBottom(el, threshold=32)`。
- 新帧到达时，只有之前就在底部才 `scrollToBottom`。
- 用户主动上翻后，显示「回到底部」按钮。

### 5.11 单测 `store/conv-store.test.ts`

必须覆盖：

- 增量应用后字段变化正确。
- `isBase` 整帧覆盖。
- seq 跳号触发 `resync`（mock `conv.open`）。
- convId 不符忽略。
- 重复 seq 忽略。
- 旧快照仍可读（`applyImmutable` 不 mutate）。

`sampleView` 从真实帧抓取，不要手写理想结构。

### 5.12 开发期一致性校验（可选但强烈建议）

主进程加一个 debug 通道 `debug.viewHash`：对当前 `view` 做稳定序列化 + hash。渲染端在每帧应用后（节流）对比。不一致时打印 `{seq, convId}`，并触发 resync。

只在开发模式启用。

---

## 6. 实现提示

- **`getSnapshot` 不能每次新建对象。** 这是 React 无限重渲染的头号原因。
- **state 里只放一个 `view`**，派生数据（分组、纯文本）用 `useMemo`，依赖 `view.entries`。
- **`view.entries` 未变化时引用不变**，这是 memo 生效的前提；不要在 render 里深拷贝。
- **`resync` 要加锁。** 一帧跳号后，后续帧会继续到达；不锁会并发开多个 `conv.open`。
- **断线时保留画面。** 把 state 标成 `resyncing`，但 `view` 不动。
- **状态判定只信 `live.run`。** 不要用「最后一条 assistant 有没有 stop reason」猜是否在跑。
- **`pi.inbox` 的形状先抓一次真实值再写 UI**（见待验证清单 2.9）。
- **工具卡与消息卡分开渲染。** 工具输出每 100ms 变，别让整个消息树重渲染。
- **Markdown 后置。** 先把文本、代码块、工具卡跑通，再引入解析器；否则你会把时间花在样式上而不是状态上。
- **滚动用 `useLayoutEffect`**，在 DOM 更新后、绘制前决定是否到底。
- **虚拟列表与流式气泡冲突**：流式气泡放在列表外，或固定为最后一项且不虚拟化。

---

## 7. 调试方法

| 想知道 | 做法 |
|---|---|
| 帧有没有应用 | store 里（开发模式）打 `{seq, ops.length, isBase}` |
| 为什么重渲染 | React DevTools Profiler，看是谁的 props 变了 |
| 文本为什么闪双份 | 打印 `hasLiveGeneration` 与最后一条 assistant id |
| 工具卡不出现 | 打印 `live.tools` 真实值；检查 `readToolSlot` 是否返回 null |
| 停止没反应 | 看 `conv.abort` 返回值；等 `live.run` 消失 |
| 重连风暴 | 检查 seq 是否与 open 返回的一致；检查是否两个 store 订阅同一会话 |
| 历史加载错位 | 游标用的是 entry id 还是 offset |
| 主/渲染不一致 | 打开 `debug.viewHash` 对比 |

DevTools 里保留一个 `window.__piDebug = { store, getState }`（仅开发模式），方便手动检查。

---

## 8. 验收标准

- [ ] 发消息后，用户气泡与回答都只出现一次，顺序与主进程 `entries` 一致。
- [ ] 回答是流式的；记录一次「提交 → 首个文字帧」的耗时，并能说出它由哪几段构成。
- [ ] 流式结束后，屏幕文本与最后一条 assistant entry 完全一致，没有闪烁或倒退。
- [ ] 工具运行时出现工具卡，状态从 `running` 变 `done`；完成后不重复显示。
- [ ] 工具结果与调用按 `toolCallId` 对应（并行工具也不错位）。
- [ ] 运行中发送第二条消息，界面明确显示「排队中」。
- [ ] 点停止后，按钮置灰；已生成部分保留；没有本地伪造的「已停止」消息。
- [ ] 手动让 seq 跳号（开发模式丢一帧），界面保留旧内容并自动 resync，最终与主进程一致。
- [ ] 用户向上翻时，新帧不抢滚动；回到底部按钮可用。
- [ ] 切换会话 A→B→A，A 的副本仍在且能继续接收。
- [ ] 刷新窗口后，历史与运行状态都能恢复（重新 open + resync）。
- [ ] `conv-store.test.ts` 全部通过。
- [ ] 开发模式下 hash 校验连续 100 帧无不一致。

---

## 9. 阶段产出

- `apps/desktop/renderer/src/store/`、`hooks/`、`lib/`、`views/chat/`
- `store/conv-store.test.ts`
- `notes/stage6-ui.md`：首字延迟拆解、一次完整工具轮的截图/日志、一次 resync 的记录。

---

## 10. 常见失败

| 现象 | 原因 | 修法 |
|---|---|---|
| 无限重渲染 | `getSnapshot` 每次新对象 | 只在 apply 时替换 |
| 界面不动 | 订阅了旧 store / 没挂 onView | 全局单次订阅 + 按 convId 分发 |
| 消息双份 | `generation` 与 entry 同时渲染 | `live.run` 消失后只读 entry |
| 文本倒退 | 整帧当增量 | `isBase` 覆盖 |
| 切换会话串台 | store 未按 convId 隔离 | 每会话一个 store |
| 首字很慢 | 模型首 token / 100ms 节流 / resync 风暴 | 分段计时，先排除 resync |
| 工具卡一闪而过 | 完成后直接删槽位 | 用结果 entry 接续渲染 |
| 用户上翻被拽回 | 无条件滚底 | `isNearBottom` |
| 刷新后空白 | 只依赖推送，没 open | 启动先 hydrate |
| 大历史卡顿 | 全量渲染 + 全量 Markdown | 分页/虚拟化 + memo |
| 错误弹窗只有英文栈 | 没映射 `IpcError` | 按 code 显示中文文案 |

---

## 下一步

[阶段 7：知识库](阶段7-知识库.md)（也可以与阶段 8 并行）
