# 主进程与 HarnessHost

> 主进程只有一件事要做对：**让 Harness 活着，并且只有一个。**
> 窗口是它的客户端，不是它的主人。

---

## 1. 为什么 Harness 必须在主进程

| 理由 | 说明 |
|---|---|
| 单写者 | Storage 没有跨进程锁。两个 Harness 打开同一个文件 = 两份真相。 |
| 生命周期 | 关窗口不等于退出任务。后台 ingest 应该继续跑。 |
| 能力 | 工具要真实文件系统、shell、子进程；渲染进程在沙箱里没有。 |
| 安全 | 渲染进程只拿到数据，拿不到 Storage 与凭证。 |
| 恢复 | 主进程崩溃/重启是唯一需要处理的恢复点，渲染进程崩了只需重开窗口。 |

推论：**渲染进程不允许 `import "@earendil-works/pi-durable"`。** 在 ESLint 里加一条规则拦住它。

---

## 2. 文件划分

```
apps/desktop/main/
├─ index.ts           Electron 入口：app 事件、单实例锁、创建窗口
├─ harness-host.ts    Harness 的创建、持有、关闭、重建
├─ lifecycle.ts       启动顺序、退出顺序、异常处理
├─ agent/
│  ├─ models.ts       createModels + provider 注册 + 凭证
│  ├─ registry.ts     createRegistry + install 内置扩展
│  └─ env.ts          NodeExecutionEnv 工厂
├─ ipc/
│  ├─ router.ts       ipcMain.handle 注册
│  └─ watch-hub.ts    watch → webContents.send
└─ paths.ts           userData / workspace / tools 路径
```

**`harness-host.ts` 不 import Electron。** 它只接收路径与一个「发送帧」的回调。这样它可以被 Node 脚本直接测试——阶段 4 的崩溃测试就靠这个。

---

## 3. HarnessHost 的形状

```ts
export type HarnessHost = {
  harness: Harness;
  root: Conversation;
  storage: Storage;
  close(): Promise<void>;
};

export async function createHarnessHost(opts: {
  dbPath: string;
  workspace: string;
  models: Models;
  registry: Registry;
  onFrame: (convId: number, ops: Op[]) => void;
  onReport?: (error: unknown, info: ReportInfo) => void;
  context: Context;
}): Promise<HarnessHost>;
```

内部顺序（每一步失败都要能定位）：

```
1. openNodeSqliteStorage(dbPath)
2. createModels / 注册 provider（复用传入的）
3. createRegistry / install 扩展
4. Harness.open(storage, { models, registry, env, settings, onReport }, ctx)
5. harness.resume()
6. harness.root(ctx)
7. 对 root 建立 watch，把帧交给 onFrame
8. 监听 harness.closed
```

第 7 步的 watch 由 **WatchHub** 管理，不放在 host 里；host 只暴露 `watchConversation(id, sink)`。

### 为什么 `resume()` 单独一行

因为它决定「重启后任务是否继续」。忘了它，表现是「消息发出去了，但永远没有回答」——非常难查。把它放在 `open()` 紧后面，并在启动日志里打一行 `harness resumed`。

---

## 4. 启动序列

```ts
// main/index.ts（骨架）
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); return; }

app.on("second-instance", () => focusMainWindow());

await app.whenReady();
const host = await createHarnessHost({ ... });
createMainWindow(host);
```

细节：

- `requestSingleInstanceLock()` 必须在 `whenReady()` 之前。
- macOS 上 `window-all-closed` 不退出；但**不要因此关掉 Harness**——用户可能还要从 Dock 回来。
- `activate` 时如果没有窗口，重建窗口并重新推送整帧（不是重放 ops）。
- 窗口创建时 `show: false`，`ready-to-show` 再显示，避免白屏。
- **不要在窗口 `did-finish-load` 之前 `webContents.send`**。帧会丢。WatchHub 应该在渲染进程主动 `conv.open` 之后才开始推。

### 安全配置

```ts
new BrowserWindow({
  webPreferences: {
    preload: path.join(__dirname, "preload.js"),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
  },
});
```

- `sandbox: true` 时 preload 只能用有限的 Node API；本项目 preload 只做 `contextBridge` + `ipcRenderer`，够用。
- 不要开 `nodeIntegration`，不要关 `contextIsolation`。
- 渲染进程加载远程内容时，设置 CSP；V1 只加载本地文件。

---

## 5. 模型与凭证

```ts
// agent/models.ts（骨架）
const models = createModels({ credentials: safeStorageCredentialStore });

models.setProvider(anthropicProvider());
models.setProvider(openaiProvider());

// 自定义 OpenAI 兼容 provider
models.setProvider(createProvider({
  id: "tokenplan",
  name: "Tokenplan",
  baseUrl: "https://…",
  auth: envApiKeyAuth("Tokenplan API key", ["TOKENPLAN_API_KEY"]),
  models: [{ /* Model 字段 */ }],
  api: openAICompletionsApi(),
}));
```

要点：

- `createModels()` 默认用内存凭证；生产要传自定义 `CredentialStore`。
- `setProvider()` 是 upsert，同名覆盖。
- 内置模型目录用 `builtinModels()`（`@earendil-works/pi-ai/providers/all`），或者逐个 `setProvider(anthropicProvider())`。
- 自定义 `Model` 必填字段：`id / name / api / provider / baseUrl / input / cost / reasoning / contextWindow / maxTokens`，还要 `type?: "chat"`（可省）。
- 模型 id 必须与 provider 实际接受的一致；写错的表现是 400，不是启动报错。

### 凭证存哪里

`CredentialStore` 只有四个方法：`read` / `list` / `modify` / `delete`。用 Electron `safeStorage` 加密后存到 `userData/credentials.json`：

```
明文 JSON  → safeStorage.encryptString() → base64 → 文件
```

`modify` 必须串行（同一个 provider 的写入不能并发）。可以复用 `InMemoryCredentialStore` 的串行思路，但落盘自己写。

`safeStorage.isEncryptionAvailable()` 在 Linux 无 keyring 时可能为 false。此时要么拒绝保存（提示用户用环境变量），要么明确告知「未加密」。**不要静默降级成明文。**

---

## 6. 执行环境

```ts
// agent/env.ts
env: (target, ctx) => new NodeExecutionEnv({
  cwd: target.cwd ?? workspaceRoot,
})
```

- `env` 是工厂，每次调用创建。不要缓存一个全局实例——`cwd` 可能随会话变化。
- 工作区根目录固定在 `userData/workspace`，不要用 `process.cwd()`（打包后是 app 目录）。
- 工具的路径校验要基于这个根目录做 `path.resolve` + 前缀判断，不能相信模型给的相对路径。
- `target.cwd` 来自 `AgentState.cwd` 或文档；两者都没有时用默认。

---

## 7. 关闭序列

错误做法：

```ts
app.on("before-quit", () => { harness.close(ctx); app.exit(0); });  // 没等
```

正确做法：

```ts
let quitting = false;
app.on("before-quit", (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  (async () => {
    await watchHub.stopAll();
    await host.close();        // 结算已接收提交 + 关闭 Storage
    app.exit(0);
  })();
});
```

为什么：`close()` 会先封住新提交、结算已接收的 commit，再关 Storage。直接 `exit` 会让最后一批提交丢失。

macOS 关窗口不触发 `before-quit`，所以**关窗口时不要停 watch**；等真正 quit。

---

## 8. 失败与重建

```ts
host.harness.closed.then(async (end) => {
  if (end.reason !== "failed") return;
  log.error("harness failed", end.error);
  await watchHub.stopAll();
  await rebuildWithBackoff();     // 1s, 2s, 4s, 最多 3 次
});
```

重建期间 UI 应该显示「正在恢复」，而不是空白。重建成功后推整帧。

**不要**在 `closed` 里复用旧 `storage` 或旧 `root` 句柄。全部重建。

---

## 9. 日志

最低要求：

- 启动：db 路径、workspace、Electron/Node 版本、`node:sqlite` 是否可用、extensions 列表。
- 每次 `submit`：`requestId`、convId、submissionId。
- `onReport` 的每条：`info.type` + task/extension 名。
- `closed`：reason + error。
- 退出：是否成功 `close()`。

不要记录：完整消息内容（隐私）、API key、工具输出的全文。

开发期把 `onReport` 打到控制台即可；生产期写滚动文件（`userData/logs/`）。

---

## 10. 验收（手动）

- [ ] 第二个实例启动后立即退出，并聚焦第一个窗口。
- [ ] 启动日志里能看到 `harness resumed`。
- [ ] 关闭窗口后进程仍在（macOS），后台任务继续；从 Dock 打开窗口能看到最新状态。
- [ ] `Cmd+Q` 后，最后一条消息没有丢；重启后仍在。
- [ ] 手动删掉 `session.sqlite`，应用能创建新库并正常启动（不是崩溃）。
- [ ] 把 `session.sqlite` 改成只读，应用能显示明确错误，不静默失败。
- [ ] 渲染进程里 `require("@earendil-works/pi-durable")` 会失败（沙箱生效）。

---

## 11. 常见失败

| 现象 | 原因 | 修法 |
|---|---|---|
| 启动即报 `No such built-in module: node:sqlite` | Electron 的 Node 版本太旧 | 升级 Electron，或换 better-sqlite3 适配器（见风险清单） |
| 两个窗口数据不同步 | 各建了 Harness | 单实例锁 + 单 host |
| 重启后任务不动 | 没 `resume()` | 固定启动顺序 |
| 退出时丢最后一条消息 | `before-quit` 里没等 `close()` | 用 preventDefault + await |
| 窗口打开白屏 | 在 load 前发送帧 | 等 `conv.open` 再推 |
| 打包后找不到工作区 | 用了 `process.cwd()` | 用 `app.getPath("userData")` |
| 凭证在 Linux 上明文 | 忽略 `isEncryptionAvailable()` | 显式拒绝或提示 |
| `webContents.send` 报对象已销毁 | 窗口关闭后 watch 还在推 | 发前 `isDestroyed()`，关窗口时 stop |

---

## 12. 下一步

- 进程边界上的契约：[02-IPC契约与preload.md](02-IPC契约与preload.md)
- 渲染端副本：[03-渲染进程replica.md](03-渲染进程replica.md)
