# 渲染进程 replica

> 渲染进程不「管理对话」。它只是把主进程发来的帧应用到一个不可变值上，然后把值画出来。
> 它没有真相，只有副本。

---

## 1. 数据流一句话

```
invoke conv.open  →  { view, seq }        （整帧）
onView(frame)     →  apply(ops)            （增量或整帧）
useSyncExternalStore → React 重渲染
用户操作           →  invoke 命令          （不直接改副本）
```

**任何在渲染进程里「本地修改消息」的行为都是 bug。** 包括乐观插入、本地删除、本地排序。

---

## 2. Store 的形状

放在 React 之外，模块级单例：

```ts
type ConvState = {
  view: ConversationView;
  seq: number;
  status: "idle" | "loading" | "ready" | "recovering" | "failed";
  error?: IpcError;
};

type Store = {
  getSnapshot(): ConvState;
  subscribe(fn: () => void): () => void;
  applyFrame(frame: ViewFrame): void;
  replaceView(view: ConversationView, seq: number): void;
};
```

要点：

- `getSnapshot()` 返回**同一个引用**，直到状态真的变化。
- 变化时创建一个新对象（`{...state, view: next}`），不要 mutate。
- `subscribe` 用 `Set`，返回 `delete` 闭包。
- 每个会话一个 store；不要把所有会话塞进一个大对象（会导致任何会话的帧都触发全局重渲染）。

---

## 3. 应用一帧

```ts
import { applyImmutable, isBase } from "@earendil-works/chord/delta";

function applyFrame(frame: ViewFrame) {
  const s = state;
  if (frame.convId !== s.convId) return;       // 防串台

  if (frame.seq === s.seq) return;             // 重复帧
  if (frame.seq !== s.seq + 1) {
    void resync();                             // 缺口：重新 open
    return;
  }

  const nextView = isBase(frame.ops)
    ? (frame.value ?? applyImmutable(undefined, frame.ops))
    : applyImmutable(s.view, frame.ops);

  setState({ ...s, view: nextView, seq: frame.seq });
}
```

三个判断缺一不可：

1. **convId 匹配**：多窗口/多会话时防止串台。
2. **seq 连续**：这是发现丢帧的唯一手段。
3. **isBase**：整帧必须直接覆盖，不能当增量应用。

`frame.value` 是否随整帧一起发送，取决于你的协议设计：

- **只发 ops**：整帧是 `[["r", value]]`，`applyImmutable(undefined, ops)` 就能得到值。
- **同时发 value**：省一次深拷贝，但帧更大。

V1 建议只发 ops，保持协议单一。

### 重连（resync）

```ts
let resyncing = false;
async function resync() {
  if (resyncing) return;
  resyncing = true;
  try {
    const { view, seq } = await window.pi.conv.open({ convId });
    setState({ ...state, view, seq, status: "ready" });
  } finally {
    resyncing = false;
  }
}
```

重连期间保留旧画面，不要清空。用户看到的是「短暂停顿」，不是「消息消失」。

---

## 4. React 绑定

```tsx
function useConv(convId: number) {
  const store = useMemo(() => getConvStore(convId), [convId]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
```

派生数据用 `useMemo`，依赖具体字段而不是整个 `view`：

```tsx
const entries = view.entries;
const messages = useMemo(() => groupMessages(entries), [entries]);
```

`view.entries` 是不可变数组，未变化时引用不变，`useMemo` 才有效。

**不要**在 render 里 `JSON.parse(JSON.stringify(view))`。这会摧毁引用相等性，导致每帧全量重渲染。

---

## 5. 转录怎么分组

Entry 是扁平的，UI 需要「一轮对话」：

```
pi.user            → 用户气泡
pi.assistant       → 模型气泡（可能带 tool_calls）
pi.tool-result     → 工具卡（按 toolCallId 关联）
pi.system          → 默认折叠（调试可见）
pi.compaction      → 分隔线 + 摘要
pi.reset           → 分隔线「新上下文」
app.*              → 按业务渲染，默认不显示
```

分组规则：

- 从 `pi.user` 开始一轮，直到下一个 `pi.user`。
- 一个 assistant entry 里的 `tool_calls` 与后续 `pi.tool-result` 用 `toolCallId` 关联。
- 工具结果可能晚于 assistant 出现；不要假设顺序固定，用 id 找。
- `pi.system` 不参与视觉分组，放在「查看上下文」里。

**不要按「相邻」关联工具结果。** 并行工具调用的结果顺序不保证与调用顺序一致。

---

## 6. 流式回答从哪来

两条来源，优先级不同：

| 来源 | 字段 | 用途 |
|---|---|---|
| 已提交的 entry | `view.entries` 里最后一条 assistant | 稳定内容 |
| 生成中的部分 | `view.docs["pi.live"].generation?.message` | 正在流式的内容 |

渲染逻辑：

```
如果 live.generation?.message 存在：
    它是当前正在生成的 assistant（可能和最后一条 entry 重复）
否则：
    用 entries 里最后一条 assistant
```

`generation.message` 是 `AssistantMessage`（已核实 `LiveState`），结构与 entry 的 `model` 消息一致。按 content block 渲染：`text` / `thinking` / `tool_call`。

**不要把 `generation.message` 和最后一条 assistant entry 同时显示。** 提交完成后，部分消息变成正式 entry，`generation` 会被清掉；如果两者都渲染，会出现「闪一下双份」。

安全做法：如果 `live.run` 不存在，忽略 `generation`。

---

## 7. 工具卡怎么画

`pi.live.tools` 是当前工具轮的槽位数组（已核实 `ToolSlot`）：

```ts
{
  callId: string;
  name: string;
  status: "pending" | "running" | "done";
  output?: string;
  droppedBytes?: number;
  droppedLines?: number;
  details?: JsonValue;        // 工具通过 api.details() 写的
  diagnostics?: ToolDiagnostic[];
  taskId?: number;
  entry?: number;             // 完成后指向 pi.tool-result entry
}
```

渲染建议：

- `running`：显示 spinner + `output` 的最后几行（自动滚动）。
- `done`：优先用 `entry` 指向的结果 entry；`details` 用来画富视图（diff、表格、UI）。
- `pending`：灰色占位（顺序执行时还没轮到）。
- `droppedBytes > 0`：显示「输出已截断」。

**`details` 是不可信 JSON。** 不要 `dangerouslySetInnerHTML`，不要 `eval`。按已知形状做类型守卫，未知字段忽略。

嵌套调用在 `pi.live.nestedTools`，`callId` 形如 `parent/key`。V1 可以折叠在父卡里，显示「N 个内部调用」。

---

## 8. 状态与禁用逻辑

| UI 状态 | 判定 | 行为 |
|---|---|---|
| 空闲 | `!live.run` | 发送可用 |
| 运行中 | `live.run` 存在 | 发送变为「排队」；显示停止按钮 |
| 恢复中 | `store.status === "recovering"` | 禁用输入，显示提示 |
| 失败 | `status === "failed"` | 显示错误 + 重试 |
| 排队中 | `pi.inbox` 非空 | 显示「N 条排队」 |

`pi.inbox` 的具体形状（`InboxDoc`）在 [待验证清单](../04-API/待验证清单.md) 里列出——写 UI 前先 `console.dir` 一次真实值，不要凭想象取字段。

停止按钮：

```ts
await window.pi.conv.abort({ convId });
```

**不要**在本地把消息标记为「已停止」。等 `view` 更新：`live.run` 消失、最后一条 assistant 落盘。这通常在一次 IPC 往返内完成。

---

## 9. 滚动与性能

- 新内容到达时，只有用户**已在底部**才自动滚动到底。用户向上翻时不要抢滚动。
- 判断「在底部」：`scrollHeight - scrollTop - clientHeight < 32`。
- 长会话用虚拟列表（只渲染可见条目）。key 用 `entry.id`，不要用 index。
- 流式文本每 100ms 变一次，只让「当前这一条」重渲染：把消息列表与「流式气泡」拆成两个组件。
- Markdown 渲染按消息 memo；不要每帧重解析所有历史消息。

---

## 10. 与 TokUI 的边界

TokUI 只负责**一条消息内部**的富 UI（表单、图表、选择器），不负责消息列表。

```
<MessageList>            ← 你自己写，管理 entries 与滚动
  <MessageBubble>
    <Markdown />
    <ToolCard />
    <TokUiBlock dsl={...} />   ← 只有这个用 TokUI
```

`TokUiBlock` 的职责：

1. 用 `startStream()` / `feed()` / `endStream()` 渲染 DSL。
2. `registerHandler` 注册固定的 handler（如 `choose`）。
3. handler 触发时调用 `window.pi.ui.action(...)`，**不在本地改状态**。
4. 组件卸载时 `disconnect()` / 清理 handler。

详见 [04-API/tokui.md](../04-API/tokui.md)。

---

## 11. 测试副本逻辑

把 store 抽成不依赖 React 的纯模块，就可以单测：

```ts
const store = createConvStore(convId);
store.replaceView(sampleView, 0);
store.applyFrame({ convId, seq: 1, ops: [["a", ["s", "entries", 0, "data"], "x"]] });
expect(store.getSnapshot().view.entries[0].data).toBe("x");
```

必须覆盖：

- 增量应用。
- 整帧覆盖（`isBase`）。
- seq 跳号触发 resync。
- convId 不匹配被忽略。
- 重复 seq 被忽略。
- `applyImmutable` 不修改旧值（旧快照仍然可读）。

`sampleView` 用真实抓取的一份帧，不要手写一个「理想结构」——否则测试通过、线上字段对不上。

---

## 12. 常见失败

| 现象 | 原因 | 修法 |
|---|---|---|
| 无限重渲染 | `getSnapshot` 每次返回新对象 | 只在 applyFrame 时替换 |
| 消息闪双份 | 同时渲染部分消息与正式 entry | `live.run` 不存在时忽略 `generation` |
| 流式结束后倒退 | 整帧被当增量应用 | 用 `isBase` |
| 切换会话串台 | 没校验 convId | 帧带 convId 并校验 |
| 用户上翻被拽回底部 | 无条件自动滚动 | 判断是否在底部 |
| 工具结果错位 | 按相邻关系关联 | 用 `toolCallId` |
| 刷新后丢历史 | 只用 `conv.open` 的最近 N 条 | 虚拟列表 + `conv.entries` 分页 |
| TokUI 卡死 | 每帧重建实例 | 复用实例，只 `feed` 增量 |

---

## 13. 下一步

- 动手：[阶段6](../05-阶段/阶段6-渲染进程replica与聊天UI.md)
- 富 UI：[04-API/tokui.md](../04-API/tokui.md)
