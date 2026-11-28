# @pi/extensions

Pi Agent Desktop 的**本机能力扩展集合**。扩展把工具、任务（Task）和运行前后钩子（Hook）注册到 pi-durable 的注册表；它们由 CLI 和 Electron **主进程**装配，渲染进程不直接 import 或执行扩展代码。

## 当前状态
| 包 | 状态 | 职责 |
|---|---|---|
| [`@pi/ext-coding`](./coding/) | ✅ 已接入 | 本机文件与 shell 工具、工作区路径边界、三档审批 |
| [`@pi/ext-kb`](./kb/) | 🚧 占位 | 本地知识库：规划 `kb_search`、`kb_read`、`kb_ingest`、`kb_lint` |
| [`@pi/ext-toolsmith`](./toolsmith/) | 🚧 占位 | 工具自举：生成、校验、试跑、人工确认安装与热替换 |
| [`@pi/ext-smartui`](./smartui/) | 🚧 占位 | 模型生成的界面；先实现 DSL 白名单校验，再实现渲染 |

目前只有 `coding` 会被 CLI 与桌面运行时实际注册；其余包只有包入口及设计约束，不能当作已实现的功能使用。

## 装配方式

调用方创建扩展，再把它交给 `@pi/core` 的 `createPiRegistry`：

```ts
import { createPiRegistry } from "@pi/core"
import { createCodingExtension } from "@pi/ext-coding"

const registry = createPiRegistry({
  extensions: [
    createCodingExtension({
      workspace: paths.workspace,
      approve: approver,
    }),
  ],
})
```

实际装配位置：

- `apps/cli/src/main.ts`：通过终端的单消费者事件队列处理审批；非交互模式自动拒绝需要审批的调用。
- `apps/desktop/src/main/runtime.ts`：通过 `ApprovalBroker` 把审批请求推送到渲染进程。

扩展不应自行创建 `Harness`、`Storage` 或 Electron 窗口。它们接收运行时给出的 API、执行环境和 `context`，并只返回工具/任务/Hook 定义。

## `@pi/ext-coding`

`createCodingExtension(options)` 注册名为 `coding` 的扩展，提供：

| 工具 | 说明 | 重放 / 并发策略 |
|---|---|---|
| `read` | 读取工作区内文件 | `safe` / 默认并发 |
| `list_dir` | 列出工作区内目录 | `safe` / 默认并发 |
| `write` | 写入文件 | `unsafe` / 串行 |
| `edit` | 精确替换编辑文件 | `unsafe` / 串行 |
| `bash` | 从工作区起点运行 shell 命令 | `unsafe` / 串行 |

### 工作区边界

`workspace` 是相对路径的解析基准。`read`、`list_dir`、`write`、`edit` 的路径会在调用前校验，越出工作区或通过软链接指向工作区外都会拒绝；`bash` 的起始 `cwd` 也必须在工作区内。

这不是操作系统沙箱：shell 命令自身仍可能通过 `cd ..` 访问外部路径。因此有副作用或无法明确判定为只读的命令必须经过审批。

### 审批策略

工具执行前的 Hook 将调用分为三档：

| 判定 | 示例 | 行为 |
|---|---|---|
| `allow` | `read`、`list_dir`、受限的只读 shell 命令 | 直接执行 |
| `ask` | `write`、`edit`、未知或有副作用的 shell 命令 | 调用 `approve`，超时或无答复即拒绝 |
| `deny` | 抹盘、根目录/家目录破坏性删除、关机重启、fork 炸弹等 | 不执行，并把拒绝说明返回给模型 |

`approve` 可省略；省略时所有 `ask` 调用都按拒绝处理。默认审批超时为 120 秒，可用 `approvalTimeoutMs` 覆盖。

## 开发约定

1. **扩展运行在可信的主进程 / CLI 侧，UI 一律通过 IPC 展示状态。**不要从 `apps/desktop/src/renderer` import 扩展，也不要在扩展中 import `electron`。
2. **工具名、扩展名和持久化文档 kind 是契约。**已经写入会话历史或注册表的名字不能随意改名。
3. **将策略写成可独立核对的纯函数。**尤其是路径判断、审批分类、危险命令识别；不要把安全规则散落在 UI 事件中。
4. **副作用工具默认 `unsafe` 且串行。**只有中断后重复运行仍安全、结果可接受的只读操作，才标为 `safe`。
5. **接入注册表前确认真实行为。**手动验证路径边界、审批、策略和工具注册，不新增或维护测试文件及专用 fixture。

## 验证

```bash
pnpm typecheck && pnpm lint && pnpm smoke && pnpm build
```

`pnpm smoke` 用 CLI 的内存存储验证真实装配链路，不依赖网络或模型凭证。安全边界与副作用另做必要的手动验证；不新增测试 npm/CI 任务。

## 相关文档

- 根项目架构与工具审批说明：[`README.md`](../../README.md)
- 共享运行时、注册表与装配入口：[`packages/core/README.md`](../core/README.md)
- CLI 的审批交互：[`apps/cli/README.md`](../../apps/cli/README.md)
- 长期设计：[`docs/知识中心/技术方案.md`](../../docs/知识中心/技术方案.md)
