# IPC 契约与 preload

> IPC 不是「随便传个对象」。它是两个进程之间唯一的 API 面：**通道名、参数、返回值、错误码、推送格式**都要当协议对待。

---

## 1. 两种通道，别混用

| 用途 | Electron API | 语义 |
|---|---|---|
| 命令（需要结果/错误） | `ipcRenderer.invoke` ↔ `ipcMain.handle` | 请求-响应，Promise |
| 通知（状态变化） | `webContents.send` ↔ `ipcRenderer.on` | 单向，无返回值 |

**写操作一律用 invoke。** 推送只用于主进程 → 渲染进程的状态帧。

不要把 `submit` 做成「发完就不管」的 `send`：渲染进程需要知道 `submissionId`，也需要知道参数是否非法。

---

## 2. 通道清单（V1 契约）

### 2.1 应用与对话

| 通道 | 参数 | 返回 |
|---|---|---|
| `app.info` | — | `{ version, platform, node, electron, workspace }` |
| `conv.open` | `{ convId: number }` | `{ view: ConversationView, seq: number }` |
| `conv.list` | `{ cursor?: string, limit?: number }` | `{ items: ConversationSummary[], cursor?: string }` |
| `conv.create` | `{ title?: string }` | `{ convId: number }` |
| `conv.submit` | `{ convId, text, requestId, whenBusy? }` | `{ submissionId: string }` |
| `conv.abort` | `{ convId }` | `{ aborted: boolean }` |
| `conv.configure` | `{ convId, change }` | `{ ok: true }` |
| `conv.compact` | `{ convId, instructions? }` | `{ taskId: number }` |
| `conv.fork` | `{ convId, atEntryId }` | `{ convId: number }` |
| `conv.reset` | `{ convId, handoff? }` | `{ entryId: number }` |
| `conv.entries` | `{ convId, before?: number, limit?: number }` | `{ items: EntryRecord[], hasMore: boolean }` |

### 2.2 文档与设置

| 通道 | 参数 | 返回 |
|---|---|---|
| `doc.get` | `{ scope: "session"\|"conversation", convId?, kind }` | `{ value: JsonObject \| null }` |
| `settings.get` | — | `AppSettings` |
| `settings.update` | `{ patch }` | `AppSettings` |

`doc.get` 只给**读**。写文档一律通过具体命令（`settings.update`、`kb.ingest`、`ui.action`），不要在 IPC 暴露通用的 `doc.write`——那等于把 commit 语义交给渲染进程。

### 2.3 知识库与工具

| 通道 | 参数 | 返回 |
|---|---|---|
| `kb.ingest` | `{ convId, path }` | `{ taskId: number }` |
| `kb.sources` | — | `KbSource[]` |
| `tools.list` | — | `ToolInfo[]` |
| `tools.create` | `{ slug, description, parameters, body }` | `{ ok, diagnostics }` |
| `tools.verify` | `{ slug }` | `{ ok, diagnostics }` |
| `tools.toggle` | `{ slug, enabled }` | `{ ok }` |

### 2.4 智能 UI

| 通道 | 参数 | 返回 |
|---|---|---|
| `ui.action` | `{ convId, uiId, handler, payload, requestId }` | `{ submissionId }` |

### 2.5 推送（main → renderer）

| 通道 | 载荷 | 说明 |
|---|---|---|
| `view` | `{ convId, seq, ops }` | 对话帧。可能是一整帧 `[["r", value]]` |
| `task.graph` | `{ seq, graph }` | 任务面板 |
| `host.status` | `{ state: "ready"\|"recovering"\|"failed", error? }` | 启动/重建状态 |

**推送通道名不要带 `on`/`event` 前缀。** 统一、简短、可枚举。

---

## 3. 类型定义放哪

```
packages/shared-types/src/ipc.ts
```

```ts
export interface IpcMap {
  "app.info": { req: void; res: AppInfo };
  "conv.submit": { req: SubmitReq; res: { submissionId: string } };
  "conv.open": { req: { convId: number }; res: OpenRes };
  // ...
}

export interface PushMap {
  view: ViewFrame;
  "task.graph": TaskGraphFrame;
  "host.status": HostStatus;
}
```

主进程与渲染进程都 import 这个文件。**不要各写一份。** 参数改名时让编译器报错，而不是运行时才发现。

`ConversationView`、`EntryRecord` 直接从 pi-durable 的**类型**导入（`import type`），不要重新声明。这样 SDK 升级时类型会跟着变。

---

## 4. 参数校验

IPC 的另一端是不可信输入（渲染进程可能被 XSS 控制）。每个 handler 都要校验：

```ts
function assertSubmit(x: unknown): SubmitReq {
  if (typeof x !== "object" || x === null) throw badRequest("body");
  const { convId, text, requestId } = x as any;
  if (!Number.isSafeInteger(convId)) throw badRequest("convId");
  if (typeof text !== "string" || text.length === 0 || text.length > 100_000)
    throw badRequest("text");
  if (typeof requestId !== "string" || !/^[A-Za-z0-9:_-]{8,128}$/.test(requestId))
    throw badRequest("requestId");
  return { convId, text, requestId };
}
```

三件事必做：

1. **类型与范围**（长度、枚举、数字安全）。
2. **资源归属**（`convId` 是否属于当前用户/工作区）。
3. **发送者校验**（`event.sender` 是否是本应用窗口）。

```ts
ipcMain.handle("conv.submit", async (event, raw) => {
  assertTrustedSender(event);
  const req = assertSubmit(raw);
  // ...
});
```

`assertTrustedSender` 可以检查 `event.senderFrame.url` 是否以 `file://` 或 `app://` 开头，并核对 `BrowserWindow.fromWebContents(event.sender)` 在已知窗口集合里。

---

## 5. 错误映射

不要把异常原样扔过去。Electron 序列化 Error 会丢信息，还可能带堆栈。

```ts
type IpcError = {
  code: "INVALID_ARGUMENT" | "NOT_FOUND" | "BUSY" | "SESSION_FAILED" | "INTERNAL";
  message: string;       // 给用户看的中文
  detail?: string;       // 给日志/开发者看的
};
```

映射规则：

| 内部错误 | code | 渲染端表现 |
|---|---|---|
| `ConversationBusy` | `BUSY` | 提示「正在运行」并转为排队 |
| `SessionFailed` / Harness closed | `SESSION_FAILED` | 进入恢复态，禁用输入 |
| `StorageRequestError` | `INVALID_ARGUMENT` | 提示并记录 |
| 参数校验失败 | `INVALID_ARGUMENT` | 表单错误 |
| 其它 | `INTERNAL` | 通用错误 + 「查看日志」 |

在 `ipcMain.handle` 外层包一个 wrapper，统一 try/catch 与日志：

```ts
const handle = <K extends keyof IpcMap>(ch: K, fn: (req: IpcMap[K]["req"]) => Promise<IpcMap[K]["res"]>) =>
  ipcMain.handle(ch, async (event, req) => {
    assertTrustedSender(event);
    try { return { ok: true, data: await fn(req) }; }
    catch (e) { return { ok: false, error: toIpcError(e) }; }
  });
```

**返回值统一成 `{ok, data} | {ok, error}`**，比「有时抛异常有时返回」好处理。preload 里可以再转回 throw，让渲染端写 `try/catch`。

---

## 6. preload 的形状

```ts
// preload/index.ts
import { contextBridge, ipcRenderer } from "electron";

const invoke = <K extends keyof IpcMap>(ch: K, req: IpcMap[K]["req"]) =>
  ipcRenderer.invoke(ch, req);

contextBridge.exposeInMainWorld("pi", {
  app: {
    info: () => invoke("app.info", undefined),
  },
  conv: {
    open: (req) => invoke("conv.open", req),
    submit: (req) => invoke("conv.submit", req),
    abort: (req) => invoke("conv.abort", req),
    // ...
  },
  onView: (cb: (frame: ViewFrame) => void) => {
    const listener = (_e: unknown, frame: ViewFrame) => cb(frame);
    ipcRenderer.on("view", listener);
    return () => ipcRenderer.removeListener("view", listener);
  },
  onStatus: (cb: (s: HostStatus) => void) => { /* 同理 */ },
});
```

规则：

- **只暴露具体方法，不暴露 `ipcRenderer` 本身。** 暴露 `send(channel, ...)` 等于把整个 IPC 面交给渲染进程。
- 每个 `on*` 必须返回 `unsubscribe`。否则 React 卸载后监听器泄漏。
- 不要在 preload 里做业务逻辑；它只做通道映射与类型收窄。
- `contextBridge` 能传函数、对象、数组、原始值；**不能传类实例、Map/Set、函数属性嵌套过深的对象**。返回前转成纯 JSON。

渲染进程的类型声明：

```ts
// renderer/env.d.ts
declare global {
  interface Window { pi: PiApi }
}
```

`PiApi` 从 `shared-types` 推导，不要手写第二份。

---

## 7. `conv.open` 的原子性

这是最容易写错的一个通道。

要求：**返回的 `view` 与 `seq` 必须对应同一个提交点。**

```ts
// WatchHub 内，每个 conv 维护：
type Entry = { watch: WatchHandle<ConversationView>; seq: number; sinks: Set<WebContents> };

async function open(convId: number, wc: WebContents) {
  const entry = await ensureWatch(convId);   // 已有就复用
  const snapshot = entry.watch.value;        // attach 时的值
  const seq = entry.seq;                     // 与 watch 建立时一致
  entry.sinks.add(wc);
  return { view: snapshot, seq };
}
```

如果实现成「先 `conversation.viewState()` 拿值，再 `watch()`」，中间可能插入一次 commit，返回的 seq 与 view 不匹配。V1 的兜底：渲染端发现 `frame.seq !== lastSeq + 1` 就重新 `conv.open`。

`seq` 由 WatchHub 自增，与 Storage 的 `Seq` 不是一回事。**不要混用。**

---

## 8. 推送的生命周期

```
窗口创建
  → 渲染进程 ready
  → invoke conv.open          ← 此时才加入 sinks
  → 主进程开始 send("view")
窗口关闭 / 刷新
  → webContents "destroyed"
  → 从 sinks 移除
  → 若 sinks 为空，可保留 watch（后台任务仍在跑）或 stop（省资源）
```

选择：

- **保留 watch**：重开窗口能立刻拿到最新值，但内存常驻。
- **stop watch**：省资源，但重开时要重新 attach。attach 是从当前提交点开始，不会丢数据。

V1 建议：**只要 Harness 活着就保留 root 的 watch**；其它会话在无订阅者时 stop。

刷新页面（`Cmd+R`）会销毁旧的 `webContents` 吗？开发模式下往往复用，但渲染上下文会重建。**监听 `did-start-navigation` / `render-process-gone`，清理该 wc 的 sink**，否则会往一个没有监听器的上下文发帧。

---

## 9. 大对象与背压

- 单帧不要超过几 MB。`entries` 很大的会话，`watch` 的整帧可能很大——V1 可以在 `conv.open` 里**只返回最近 N 条**，历史用 `conv.entries` 分页。
- `conv.entries` 用游标，不用 offset。`EntryId` 是单调数字，天然适合游标。
- 高频推送不会阻塞主进程（`send` 是异步的），但会占内存。WatchHub 可以合并同一 tick 的帧：只保留最后一个 ops？**不行**——ops 有顺序。正确做法是交给框架的 100 帧折叠，或者自己合并成整帧。
- 如果渲染进程处理不过来，`webContents` 没有内建背压。V1 不做流控，靠 100ms 的提交间隔兜底。

---

## 10. 验收

- [ ] 所有通道名集中在 `shared-types`，主进程与渲染进程共用。
- [ ] 每个 handler 都校验参数与发送者。
- [ ] 非法参数返回 `INVALID_ARGUMENT`，不抛原始异常。
- [ ] `conv.open` 返回值与后续帧的 seq 连续（或能触发重连）。
- [ ] 关窗口后不再有 `send` 报错。
- [ ] 渲染进程里拿不到 `ipcRenderer`、`require`、`process`。
- [ ] `onView` 的 unsubscribe 生效（用 React StrictMode 双挂载验证）。

---

## 11. 常见失败

| 现象 | 原因 | 修法 |
|---|---|---|
| 首次打开丢消息 | 先 open 后监听 | open 与监听由 preload 原子完成；或 seq 不连续就重开 |
| 刷新后界面空白 | 旧 sink 未清理，新上下文没注册 | 监听 `did-start-navigation` 清理 |
| 渲染端偶发 `null` | 传了 `undefined` | 统一用 `null` 表示空 |
| 错误只有 `Error invoking remote method` | 没包装错误 | 统一 `{ok, error}` |
| 任意页面都能调用 IPC | 没校验 sender | `assertTrustedSender` |
| 大历史导致卡顿 | `conv.open` 返回全部 entries | 只返回最近 N 条 + 分页 |
| `contextBridge` 报 clone 错误 | 返回了类实例 | 转纯 JSON |

---

## 12. 下一步

- 渲染端怎么用这些帧：[03-渲染进程replica.md](03-渲染进程replica.md)
- 动手：[阶段5](../05-阶段/阶段5-Electron主进程与IPC.md)、[阶段6](../05-阶段/阶段6-渲染进程replica与聊天UI.md)
