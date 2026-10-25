# 阶段 5：Electron 主进程与 IPC

> **目标**：把阶段 4 的 Harness 搬进 Electron 主进程，做到「一个窗口、一条 IPC 往返、单写者成立」。
> **预计**：2–4 天（含第一天的环境门禁）。**产出**：能开窗、能 `conv.open`、能在 DevTools 里看到 seq 的桌面壳。

---

## 1. 前置概念

- **主进程是唯一写者。** Harness 只在主进程；渲染进程只有副本。
- **窗口是客户端，不是主人。** 关窗口不应杀掉后台任务（macOS 上尤其）。
- **IPC 是协议**：通道名、参数、返回、错误码、推送格式都要固定，并且用同一份类型定义。
- **`invoke` 用于命令，`send` 用于状态帧。** 不要把 submit 写成 fire-and-forget。
- **推送从 `conv.open` 开始，不是从窗口创建开始。** 否则帧会被丢在没有监听器的上下文里。
- **`before-quit` 必须 `preventDefault` 并 await `close()`**，否则最后一批提交丢失。
- **`node:sqlite` 在目标 Electron 上是否可用，是这一阶段的门禁**，不是最后打包时才验证。

---

## 2. 先读哪些文档

1. [主进程与 HarnessHost](../03-Electron/01-主进程与HarnessHost.md) —— 全文
2. [IPC 契约与 preload](../03-Electron/02-IPC契约与preload.md) —— 全文
3. [存储、错误与恢复](../02-PI-Durable/05-存储错误与恢复.md) —— 第 3、8 节
4. [待验证清单](../04-API/待验证清单.md) —— 1.1–1.5、5.1–5.6

---

## 3. 架构位置与模块协作

```
apps/desktop/
├─ main/
│  ├─ index.ts              单实例锁、whenReady、窗口、before-quit
│  ├─ lifecycle.ts          启动/退出/重建的编排
│  ├─ harness-host.ts       Harness 的创建与持有（不 import electron）
│  ├─ paths.ts              userData / workspace / tools / logs
│  ├─ agent/{models,registry,env}.ts
│  └─ ipc/
│     ├─ router.ts          ipcMain.handle + 校验 + 错误映射
│     └─ watch-hub.ts       watch → webContents.send
├─ preload/index.ts         contextBridge 暴露 window.pi
└─ renderer/                阶段 6 再填

packages/shared-types/src/ipc.ts   通道与载荷类型（两端共用）
```

数据流（本阶段只做最小闭环）：

```
Renderer ──invoke("conv.open")──▶ Router ──▶ HarnessHost/WatchHub
                                          ├─ 返回 { view, seq }
                                          └─ watch 帧 ──send("view")──▶ preload ──▶ renderer
```

---

## 4. API 清单

### Electron

| 目的 | API |
|---|---|
| 单实例 | `app.requestSingleInstanceLock()`、`app.on("second-instance")` |
| 就绪 | `app.whenReady()` |
| 路径 | `app.getPath("userData")` |
| 窗口 | `new BrowserWindow({ webPreferences })`、`ready-to-show` |
| 退出 | `app.on("before-quit")`、`event.preventDefault()`、`app.exit(0)` |
| IPC 命令 | `ipcMain.handle` / `ipcRenderer.invoke` |
| IPC 推送 | `webContents.send` / `ipcRenderer.on` |
| 安全 | `contextIsolation:true`、`nodeIntegration:false`、`sandbox:true` |
| 上下文桥 | `contextBridge.exposeInMainWorld` |
| 凭证 | `safeStorage.isEncryptionAvailable()` / `encryptString` / `decryptString` |
| 生命周期钩子 | `app.on("activate")`、`window-all-closed`、`render-process-gone` |

### Harness（沿用阶段 4）

`openNodeSqliteStorage`、`Harness.open`、`harness.resume()`、`harness.root()`、`conversation.watch()`、`conversation.entries()`、`harness.closed`、`harness.inspect()`。

### 本阶段只用到的通道

`app.info`、`conv.open`、`conv.submit`、`conv.abort`、`conv.entries`、推送 `view` / `host.status`。

---

## 5. 手写任务

### 5.0 落地顺序与可手写代码

先在 Electron 主进程通过存储门禁，再注册返回值明确的 IPC；渲染进程只能通过 preload 调用这些能力。

```ts
import { DatabaseSync } from "node:sqlite"; // 在目标 Electron 的 Node 环境加载 SQLite 实现。
export function assertSqliteGate(file: string): void { // 定义启动时必须通过的 SQLite 门禁。
  const db = new DatabaseSync(file); // 打开内存或 userData 下的测试数据库。
  db.exec("create table if not exists gate (value text)"); // 创建最小测试表验证执行能力。
  db.prepare("insert into gate values (?)").run("ok"); // 写入一条可回读的数据验证写路径。
  if (db.prepare("select value from gate limit 1").get().value !== "ok") throw new Error("SQLite 门禁失败"); // 验证读回内容与预期一致。
  db.close(); // 立即关闭测试数据库避免占用文件句柄。
} // 结束 SQLite 门禁函数。
ipcMain.handle("conv.open", async (event, input) => { // 注册显式返回快照的会话打开命令。
  assertTrustedSender(event); // 先拒绝不受信任的渲染进程来源。
  const parsed = ConvOpenSchema.parse(input); // 在进入业务层前校验 IPC 参数。
  const opened = await watchHub.open(parsed.convId, event.sender); // 注册窗口 sink 并读取当前视图。
  return { ok: true, data: opened }; // 用统一成功包裹返回可序列化结果。
}); // 结束 conv.open 路由注册。
contextBridge.exposeInMainWorld("pi", { // 仅暴露白名单 API 给隔离后的页面。
  openConversation: (input: unknown) => ipcRenderer.invoke("conv.open", input), // 将打开命令桥接为 Promise 调用。
  onView: (fn: (frame: ViewFrame) => void) => { ipcRenderer.on("view", (_event, frame) => fn(frame)); return () => ipcRenderer.removeAllListeners("view"); }, // 注册并返回可清理的帧监听器。
}); // 结束安全 preload 桥接对象。
```

### 5.1 第 0 步：环境门禁（必须先做）

写 `scripts/05-gate-electron.ts`（或主进程启动时第一段代码），在 **Electron 的 Node 运行时**里检查：

1. `process.versions.node` / `process.versions.electron`。
2. `require("node:sqlite")` 能加载。
3. `new DatabaseSync(":memory:")` 能建库、建表、读写、关闭。
4. 在 `userData` 下建一个真实文件库，写入一行再读回。

结论只有两种：

- **通过** → 继续。
- **不通过** → 立刻停下来，实现 better-sqlite3 适配器（六个方法：`exec/run/get/all/transaction/close`），再交给 `SqliteStorage.open(db)`。不要在没验证的情况下继续写 UI。

把结果写进 `notes/stage5-gate.md`，并回填 [待验证清单](../04-API/待验证清单.md) 1.1 / 1.2。

### 5.2 `paths.ts`

- `userData`、`workspace = join(userData, "workspace")`、`tools = join(userData, "tools")`、`logs`、`dbPath`。
- 首次启动时创建目录（`mkdirSync(..., {recursive:true})`）。
- **不要用 `process.cwd()`**。

### 5.3 `harness-host.ts`

按 [主进程文档第 3 节](../03-Electron/01-主进程与HarnessHost.md) 的形状写。要求：

- 不 import `electron`。
- 接收 `{ dbPath, workspace, models, registry, env, onReport }`。
- 顺序固定：storage → `Harness.open` → `resume()` → `root()`。
- 暴露 `close()`，内部只 close 一次（幂等）。
- `closed` 事件向上抛给 `lifecycle`，host 自己不重建。

### 5.4 `agent/{models,registry,env}.ts`

- `models.ts`：`createModels()` + 内置 provider + Tokenplan（如需要）。凭证先用环境变量，`safeStorage` 放到 5.6。
- `registry.ts`：`createRegistry()`，本阶段可以先只装阶段 2 的 coding 扩展，也可以为空。
- `env.ts`：`env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? workspace })`。

### 5.5 `ipc/watch-hub.ts`

```ts
type ConvEntry = {
  watch: WatchHandle<ConversationView>;
  seq: number;
  sinks: Set<WebContents>;
};
```

职责：

- `open(convId, sender)`：`ensureWatch` → 返回 `{view: watch.value, seq}` → 加入 sinks。
- `start()`：在 watch 回调里 `seq++`，对每个 sink `send("view", {convId, seq, ops})`。
- `removeSink(wc)`：窗口关闭/导航时清理。
- `stopAll()`：退出时停止所有 watch。
- **发送前检查 `wc.isDestroyed()`。**
- **不要在 `conv.open` 之前推帧**——sink 集合为空，自然不推。

### 5.6 `ipc/router.ts`

实现 5 个通道：

| 通道 | 要点 |
|---|---|
| `app.info` | 版本、平台、workspace 路径（不泄露 key） |
| `conv.open` | `watchHub.open`，返回 `{view, seq}` |
| `conv.submit` | 校验 → `requestId` → `submit` → 返回 submissionId |
| `conv.abort` | `conversation.abort(ctx)` |
| `conv.entries` | 游标分页 |

统一 wrapper：`assertTrustedSender` → 参数校验 → try/catch → `{ok,data}|{ok,error}`。

### 5.7 `preload/index.ts`

- `contextBridge.exposeInMainWorld("pi", {...})`。
- `conv.open/submit/abort/entries`、`app.info`。
- `onView(cb)`、`onStatus(cb)`，**必须返回 unsubscribe**。
- 不暴露 `ipcRenderer`、`require`、`process`。

### 5.8 `main/index.ts` + `lifecycle.ts`

- 单实例锁在 `whenReady` 之前。
- `whenReady` → gate → `createHarnessHost` → `createMainWindow`。
- 窗口：`show:false` + `ready-to-show`；安全配置四项。
- `before-quit` 等待 `watchHub.stopAll()` + `host.close()`。
- macOS：`window-all-closed` 不 quit；`activate` 时重建窗口。
- `render-process-gone`：记录并重建窗口（V1 不自动无限重建）。

### 5.9 `renderer/` 的最小页面

只做三件事：

1. 调 `window.pi.app.info()` 显示版本。
2. 调 `window.pi.conv.open({convId: rootId})`，打印 `seq` 与 `entries.length`。
3. `onView` 里打印 `{seq, ops.length}`，并在页面显示一个计数器。

**不做聊天 UI**，那是阶段 6。

---

## 6. 实现提示

- **先把「无窗口的 Harness」跑通，再开窗口。** 在 `whenReady` 里先建 host，再建窗口；host 失败时弹错误对话框并退出，不要留一个空壳窗口。
- **`convId` 从哪来？** 本阶段把 root 的 id 注入 `app.info` 或 `conv.list`；渲染进程启动时先取根会话。不要让渲染进程猜 id。
- **`seq` 是 WatchHub 自己的计数器**，不是 Storage 的 Seq。两者混用会导致重连判断永远失败。
- **push 的 payload 要可序列化。** `ops` 是数组，`view` 里不要塞 Date/Map/类实例。
- **不要在 `ipcMain.handle` 里直接 `throw`。** 统一 wrapper 转成 `{ok:false,error}`。
- **`event.senderFrame` 可能为 null**（导航中）。校验失败时拒绝，不要 fallback 到「信任」。
- **`sandbox:true` 的 preload 不能 import 业务包。** 只 import `electron` 与纯类型。
- **窗口重建后必须重新 `conv.open`。** 新 `webContents` 不在旧 sinks 里。
- **退出时先 stop watchHub，再 close host。** 反了会往正在关闭的窗口发帧。
- **开发时别开两个 Electron。** `lsof .data/session.sqlite` 或 `ps aux | grep electron`，确认旧进程退出。

---

## 7. 调试方法

| 想知道 | 做法 |
|---|---|
| 主进程日志 | 终端输出（开发）或 `userData/logs` |
| 渲染进程日志 | DevTools Console |
| IPC 有没有到 | 在 router 每个 handler 第一行打通道名与参数摘要（不打印全文） |
| 帧有没有推 | WatchHub 里打 `{convId, seq, ops.length}` |
| 渲染端有没有收 | `onView` 里打 seq；对照主进程 |
| 窗口为什么白屏 | `did-fail-load`、`console-message` 事件 |
| 是否两个实例 | `app.requestSingleInstanceLock()` 的返回值 |
| 关窗后还有 send 报错 | sink 未清理；`isDestroyed()` 检查 |
| 退出丢消息 | `before-quit` 是否真的 await 了 close |

**不要用 `console.log` 打印整帧 `view`。** 大会话会卡住主进程。打印长度和 key。

---

## 8. 验收标准

**门禁：**

- [ ] `notes/stage5-gate.md` 记录了目标 Electron 的 Node 版本与 `node:sqlite` 实测结果。
- [ ] 不可用时，better-sqlite3 适配器已跑通（六方法 + 一次 commit/read）。

**功能：**

- [ ] 应用能打开一个窗口，页面显示 `app.info` 的版本。
- [ ] `conv.open` 返回 `{view, seq}`，页面显示 entries 数量。
- [ ] 发一条消息后，渲染端收到 ≥1 帧 `view`，seq 从 open 的 seq 连续递增。
- [ ] 第二个实例启动后立即退出，并聚焦第一个窗口。
- [ ] 关闭窗口（macOS）后进程仍在；从 Dock 打开能恢复。
- [ ] `Cmd+Q` 后重启，最后一条消息仍在（阶段 4 的持久化生效）。
- [ ] 主进程日志里有 `harness resumed`，且 `inspect()` 无异常。
- [ ] 渲染进程 DevTools 里 `window.pi` 存在，`window.require` / `window.process` 不存在。
- [ ] 非法 `conv.submit` 参数返回 `INVALID_ARGUMENT`，不抛原始异常。
- [ ] 关窗后主进程不再出现 `Object has been destroyed`。
- [ ] 只存在一个 Harness（用日志计数或 `inspect()` 验证）。

---

## 9. 阶段产出

- `apps/desktop/main/`（index、lifecycle、harness-host、paths、agent、ipc）
- `apps/desktop/preload/index.ts`
- `packages/shared-types/src/ipc.ts`
- `apps/desktop/renderer/` 最小页面
- `notes/stage5-gate.md`、`notes/stage5-ipc.md`（一次 open + 帧序列的原始日志）

---

## 10. 常见失败

| 现象 | 原因 | 修法 |
|---|---|---|
| `No such built-in module: node:sqlite` | Electron 的 Node 太旧 | 升级 Electron，或适配器兜底 |
| 窗口白屏 | preload 路径错 / CSP / 加载了错误 URL | 看 `did-fail-load` 与 Console |
| `window.pi` undefined | `contextIsolation` 下 preload 抛错 | 看 preload 的报错；确认路径 |
| 第一条消息没有帧 | open 之前就 send | 等 sink 注册后再推 |
| seq 跳跃 | 多个 WatchHub 实例 / 重连没重开 | 单例 hub；不连续就 `conv.open` |
| 关窗后报对象已销毁 | 未清理 sink | `destroyed` 事件 + `isDestroyed()` |
| 退出丢最后一条 | `before-quit` 没 await | preventDefault + async close |
| 两个窗口数据不同步 | 两个 Harness | 单实例锁 + 单 host |
| 打包后 workspace 找不到 | 用了 `process.cwd()` | `app.getPath("userData")` |
| 凭证在 Linux 明文 | 忽略 `isEncryptionAvailable` | 拒绝保存或明确提示 |
| 刷新后没有帧 | 新上下文未重新 open | 监听导航并清理 sink |

---

## 下一步

[阶段 6：渲染进程 replica 与聊天 UI](阶段6-渲染进程replica与聊天UI.md)
