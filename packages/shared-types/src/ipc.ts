/**
 * IPC ：渲染进程通过该层调用主进程的方法
 */
import type { ApprovalDecision, ApprovalView, ConversationSummary, HostInfo, HostStatus } from "./domain.ts"
import type { IpcErrorPayload } from "./errors.ts"
import type { ConversationId, EntryId, OpenedView } from "./frame.ts"
import type { JsonObject } from "./json.ts"
import type { InputSubmissionView } from "./submission.ts"

/** 忙时策略：`followUp` 等当前轮结束、`steer` 插到工具轮边界、`reject` 直接拒。 */
export type WhenBusy = "steer" | "followUp" | "reject"

export type IpcMap = {
  /** 应用与环境信息；也是「主进程已就绪」的探针。 */
  "app.info": {
    readonly request: Record<string, never>
    readonly response: HostInfo
  }
  /** 宿主健康度快照。 */
  "app.status": {
    readonly request: Record<string, never>
    readonly response: HostStatus
  }
  /** 仅宿主失效后允许重启应用；不能重试单次存储操作或降级为内存库。 */
  "app.restart": {
    readonly request: Record<string, never>
    readonly response: Record<string, never>
  }
  /** 会话列表 */
  "conv.list": {
    readonly request: { readonly limit?: number }
    readonly response: readonly ConversationSummary[]
  }
  /** 打开会话：原子返回副本起点与起始编号，渲染进程据此建立自己的副本。 */
  "conv.open": {
    readonly request: { readonly conversationId: ConversationId }
    readonly response: OpenedView
  }
  /** 当前/最近已开始输入的持久化状态；切换/重启后恢复终态失败提示。 */
  "conv.submission": {
    readonly request: { readonly conversationId: ConversationId }
    readonly response: InputSubmissionView | undefined
  }
  "conv.create": {
    readonly request: Record<string, never>
    readonly response: { readonly conversationId: ConversationId }
  }
  /**
   * 提交一条用户输入。`requestId` 是幂等键：同一次点击的重试要复用同一个值，
   * 这样重放不会写出两条 submission。
   */
  "conv.submit": {
    readonly request: {
      readonly conversationId: ConversationId
      readonly text: string
      readonly whenBusy?: WhenBusy
      readonly requestId?: string
    }
    readonly response: { readonly submissionId: number }
  }
  "conv.abort": {
    readonly request: { readonly conversationId: ConversationId }
    readonly response: Record<string, never>
  }
  "conv.fork": {
    readonly request: { readonly conversationId: ConversationId; readonly at?: EntryId }
    readonly response: { readonly conversationId: ConversationId }
  }
  /** 删除会话：只从会话列表移除（库里的条目与任务保留，pi-durable 没有删除接口）。 */
  "conv.delete": {
    readonly request: { readonly conversationId: ConversationId }
    readonly response: Record<string, never>
  }
  /** 重命名：写会话标题（`app.title`），界面在列表刷新后看到。 */
  "conv.rename": {
    readonly request: { readonly conversationId: ConversationId; readonly title: string }
    readonly response: { readonly title: string }
  }
  /** 置顶 / 取消置顶：「最近」列表里排最前（`app.pins`，session 作用域）。 */
  "conv.pin": {
    readonly request: { readonly conversationId: ConversationId; readonly pinned: boolean }
    readonly response: Record<string, never>
  }
  "conv.reset": {
    readonly request: { readonly conversationId: ConversationId; readonly handoff?: string }
    readonly response: Record<string, never>
  }
  "conv.compact": {
    readonly request: { readonly conversationId: ConversationId; readonly instructions?: string }
    readonly response: { readonly entryId: EntryId | undefined }
  }
  /** 读一份 `app.*` 文档的当前值；没创建过就返回 undefined。 */
  "doc.get": {
    readonly request: { readonly conversationId: ConversationId; readonly kind: string }
    readonly response: JsonObject | undefined
  }
  /** 该会话当前待审批的请求，按产生顺序。 */
  "approval.list": {
    readonly request: { readonly conversationId: ConversationId }
    readonly response: readonly ApprovalView[]
  }
  /**
   * 回答一条待审批请求。`id` 是幂等键：重复回答同一个 id 只会生效一次，
   * 已结束（超时/已答）的请求返回它的终态，不报错。
   */
  "approval.respond": {
    readonly request: { readonly id: string; readonly approved: boolean }
    readonly response: { readonly decision: ApprovalDecision }
  }
}

export type IpcChannel = keyof IpcMap
export type IpcRequest<K extends IpcChannel> = IpcMap[K]["request"]
export type IpcResponse<K extends IpcChannel> = IpcMap[K]["response"]

/** 主进程的返回值：成功带值，失败带码。渲染进程不做异常穿透。 */
export type IpcResult<K extends IpcChannel> =
  | { readonly ok: true; readonly value: IpcResponse<K> }
  | { readonly ok: false; readonly error: IpcErrorPayload }
