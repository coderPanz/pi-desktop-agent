# @pi/shared-types

Electron **主进程、preload 与渲染进程**共用的 TypeScript 契约包。它定义渲染层能看见的只读视图、IPC 请求/响应、主进程推送、错误封套和 bridge API，使三处对同一份数据使用同一套类型。

本包刻意**不依赖 `pi-durable`**：渲染进程可以直接 import 它，但不能接触存储、Harness 或 Node 执行环境。

## 边界与原则

| 原则 | 含义 |
|---|---|
| 一份契约，三处复用 | preload 按 `PiBridge` 实现，主进程按 `IpcMap` / `PushMap` 应答，渲染进程按同一类型调用和订阅 |
| 只传可展示的投影 | 不把 Storage、Harness、原始异常或任意 Node 对象泄露给 UI |
| 帧是会话状态的唯一同步方式 | 渲染进程持有 `ViewSnapshot` 副本；主进程推送带序号的 `ViewFrame` 增量 |
| 错误使用稳定错误码 | 跨 IPC 传 `IpcErrorPayload`，不直接传 Error 实例或堆栈 |
| 名字和字段是契约 | 通道名、`pi.*` kind、状态字面量、已持久化的 id 语义都不可随意改名 |

## 模块地图

| 文件 | 导出与职责 |
|---|---|
| `json.ts` | `JsonValue` / `JsonObject` 及运行时守卫 |
| `frame.ts` | 会话副本、增量帧、`applyFrame`、`EntryKind` / `DocKind` 和实时视图读取工具 |
| `domain.ts` | UI 视图模型：会话摘要、工具状态、审批视图、宿主信息与状态 |
| `submission.ts` | 用户输入的持久化状态、乱序合并和终态失败过滤 |
| `ipc.ts` | `IpcMap`、请求/响应泛型、`IpcResult` 与忙时策略 |
| `push.ts` | `PushMap`、可订阅推送通道和 payload |
| `bridge.ts` | preload 暴露的 `PiBridge`、统一 invoke 通道名及推送白名单 |
| `errors.ts` | `IpcError`、`IpcErrorCode` 和未知错误的安全压缩 |

`src/index.ts` 是唯一公共入口；调用方应从 `@pi/shared-types` 导入，不依赖 `src/*` 的深层路径。

## 帧与会话副本

渲染进程不能直接读取数据库，因此主进程提供一次性起点：

```ts
type OpenedView = {
  convId: ConversationId
  seq: number
  snapshot: ViewSnapshot
}
```

之后每次状态变更通过：

```ts
type ViewFrame = {
  convId: ConversationId
  seq: number
  ops: readonly Op[]
}
```

同步规则：同一会话的 `seq` 单调递增，渲染层只接受连续帧；重复、旧帧丢弃，跳号则重新调用 `conv.open` 获得完整副本。增量用不可变方式叠加：

```ts
import { applyFrame } from "@pi/shared-types"

const nextSnapshot = applyFrame(snapshot, frame.ops)
```

`ViewSnapshot` 包含会话元信息、按 id 排序的已生效条目，以及按 kind 索引的已提交文档。`liveGenerationText`、`liveIsRunning`、`liveTools`、`entryText` 等辅助函数负责从不完全可信的 JSON 视图中安全读取 UI 所需内容。

### 内置持久化 kind

| 常量 | 值 | 用途 |
|---|---|---|
| `EntryKind.user` | `pi.user` | 用户消息 |
| `EntryKind.assistant` | `pi.assistant` | Assistant 消息 |
| `EntryKind.system` | `pi.system` | 系统消息 |
| `EntryKind.toolResult` | `pi.tool-result` | 工具结果 |
| `EntryKind.reset` / `compaction` | `pi.reset` / `pi.compaction` | 会话操作记录 |
| `DocKind.live` | `pi.live` | 当前生成、运行与工具调用展示状态 |
| `DocKind.inbox` | `pi.inbox` | 等待进入上下文的提交队列 |

这些字符串会随会话数据持久化；改名等同于破坏旧数据兼容性。

## IPC 与推送

### 命令调用

`IpcMap` 是命令名到 request / response 的映射，包括：

- `app.info`、`app.status`
- `conv.list`、`conv.open`、`conv.submission`、`conv.create`、`conv.submit`、`conv.abort`、`conv.fork`、`conv.reset`、`conv.compact`
- `doc.get`
- `approval.list`、`approval.respond`

preload 对外只暴露一个泛型 `invoke`，而不是将 `ipcRenderer` 或每个 Electron 通道暴露给页面：

```ts
const result = await window.pi?.invoke("conv.submit", {
  conversationId: 1,
  text: "查看当前项目状态",
})
```

其返回值是：

```ts
type IpcResult<K> =
  | { ok: true; value: IpcResponse<K> }
  | { ok: false; error: IpcErrorPayload }
```

渲染层的 `apps/desktop/src/renderer/src/ipc.ts` 会把失败结果转换为带错误码的异常；preload 则保持薄层，只做可信通道的桥接。

### 主动推送

`PushMap` 定义四条白名单推送：

| 通道 | payload | 用途 |
|---|---|---|
| `view` | `ViewFrame` | 递增同步会话副本 |
| `submission` | `InputSubmissionView` | 跟踪用户提交的排队、执行、完成或未回答失败 |
| `host.status` | `HostStatus` | 更新调度与任务计数 |
| `approval` | `ApprovalPush` | 更新某会话当前待审批集合 |

订阅会返回取消函数，React Hook 必须在 effect cleanup 中调用它。

## 用户提交状态与错误

`InputSubmissionView` 的状态可为 `queued`、`placed`、`done` 或带原因/文案的 `unanswered`。初次读取和实时推送可能乱序到达，因此 UI 应使用：

```ts
mergeSubmissionView(current, incoming)
```

它会拒绝旧 id、避免后续排队项遮住当前终态，并阻止迟到的非终态覆盖 `done` / `unanswered`。`submissionFailure` 还会验证失败仍属于当前副本，并过滤用户主动 `aborted`、`reset` 引起的状态。

IPC 错误码固定为：`INVALID_ARGUMENT`、`NOT_FOUND`、`BUSY`、`SESSION_FAILED`、`UNKNOWN`。不要把 SDK 原始 Error 或 stack 直接发送到渲染进程。

## 使用与修改

```ts
import type { IpcRequest, PushMap, ViewSnapshot } from "@pi/shared-types"
import { DocKind, EntryKind, applyFrame } from "@pi/shared-types"
```

修改前请确认：

1. 该数据是否确实需要跨主进程、preload、渲染进程传输；只在主进程使用的持久化文档放进 `@pi/shared-docs`。
2. 新 IPC 命令同时更新 `IpcMap`、主进程白名单/路由、preload bridge 和渲染进程调用点。
3. 新推送同时更新 `PushMap`、`PUSH_CHANNELS`、主进程发布处和渲染层订阅处。
4. 变更 `pi.*` kind 或已持久化数据形状前，制定兼容/迁移方案并补测试。

## 验证

```bash
pnpm test       # 包含 frame、submission 与 errors 测试
pnpm typecheck
pnpm lint
```

## 相关文档

- `app.*` 持久化文档定义：[`../shared-docs/README.md`](../shared-docs/README.md)
- 运行时、FrameHub 与 IPC 路由：[`../core/README.md`](../core/README.md)
- 桌面 preload 实现：[`../../apps/desktop/src/preload/index.ts`](../../apps/desktop/src/preload/index.ts)
- 项目整体架构：[`../../README.md`](../../README.md)
