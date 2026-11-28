# @pi/shared-docs

应用写入 pi-durable 存储的 **`app.*` 文档与条目契约**。本包集中定义应用拥有的数据 kind、数据形状、作用域、历史和分叉规则，避免在业务处理器里随用随写字符串。

> **写入库的 kind 与版本是持久化契约。**改名会让旧数据无法按原定义读取；字段不兼容变更必须提升 `version` 并提供迁移路径。

## 边界

- **只在主进程和 CLI 使用。**本包依赖 `@earendil-works/pi-durable`，Electron 渲染进程不得 import。
- **不保存模型上下文。**`app.*` 条目供界面、审计和业务状态使用；与 SDK 的 `pi.*` 条目并列，但不进入模型消息。
- **不实现读写流程。**这里仅定义 `defineDoc` / `defineEntry` 的契约；具体读写、审批和 IPC 由 `@pi/core`、桌面主进程或扩展负责。

渲染进程若需展示这类数据，应通过 `@pi/shared-types` 的 IPC / 帧协议取得可安全传输的视图模型，而不是直接依赖本包。

## 已定义的契约

| 文件 | kind | 范围与历史 | 用途 |
|---|---|---|---|
| `settings.ts` | `app.settings` | `session`；默认历史 | 应用级主题、语言、模型选择和工具输出偏好 |
| `approvals.ts` | `app.approvals` | `conversation`；`latest`；分叉取 `current` | 当前待审批队列与最近一次审批决定 |
| `workspace.ts` | `app.workspace` | `conversation`；`rewindable`；分叉取 `asOf` | 会话界面状态：钉住的文件、当前视图、最近错误 |
| `entries.ts` | `app.ui_action` / `app.approval` | 条目 | UI 操作的幂等记录，以及审批决定的审计记录 |

### `app.settings`

一个数据根只有一份的会话级偏好。默认值为：

```ts
{ theme: "system", locale: "zh-CN", verboseTools: false }
```

`model` 是用户显式选择的 `{ provider, modelId }`；缺省时沿用会话 Agent 的模型配置。它在积累 64 个 delta 后创建 checkpoint，控制读放大和写入量。

### `app.approvals`

待审批请求与工具任务分开保存：工具任务是 durable 的执行状态，审批是人工决定。请求 id 与工具调用的 `callId` 不同，因为同一次工具调用可能重复发起审批。

审批结果有三种终态：`approved`、`denied`、`expired`。文档只保留当前待批项和最近一次决定，不提供历史回看；分叉时复制当前结果，避免对继承的历史副作用重复询问。

### `app.workspace`

保存的是界面状态，不是聊天内容：`pinned`、`view`（`chat` / `diff` / `files`）和 `lastError`。它可随会话历史回卷，并在从某条历史分叉时恢复到该时刻的界面状态。

当前定义已就绪，但 UI 读写尚未接入。

### 应用条目

```ts
UiActionEntry  // "app.ui_action"
ApprovalEntry  // "app.approval"
```

`UiActionData.requestId` 是 UI 点击重试的幂等键；同一次操作必须复用它，避免重复写入 submission。`ApprovalData` 则记录审批 id、工具调用 id、工具名和最终决定，供审计与回放。

## 使用方式

调用方从包根导入定义，而不是深层路径：

```ts
import {
  AppApprovalsDoc,
  AppSettingsDoc,
  AppWorkspaceDoc,
  ApprovalEntry,
  UiActionEntry,
} from "@pi/shared-docs"
```

将文档定义注册到使用的 pi-durable API，再由业务层按对应 scope 读写。具体 API 以 pi-durable 的文档/条目接口为准；本包不会创建 `Storage`、`Harness` 或 Electron IPC。

## 演进规则

1. 新增应用状态时，先判断它是 `doc`（可变的当前状态）还是 `entry`（追加的审计事件）。
2. kind 使用 `app.` 命名空间，名称一旦发布不要重用或改名。
3. 字段不兼容时提升文档的 `version`；条目数据保留显式 `v` 字段，并在读取侧兼容旧版本或迁移。
4. 根据业务选择 scope、`history`、`fork` 和 checkpoint 策略；不要把会话局部状态误放进 `session` 文档。
5. 核对新增 kind 的字符串、版本和关键元数据，并手动确认旧数据兼容性；不新增测试文件。

## 验证

```bash
pnpm typecheck && pnpm lint && pnpm smoke && pnpm build
```

## 相关文档

- 跨进程 IPC、帧和视图模型：[`../shared-types/README.md`](../shared-types/README.md)
- 运行时层与文档物化：[`../core/README.md`](../core/README.md)
- 项目整体架构：[`../../README.md`](../../README.md)
