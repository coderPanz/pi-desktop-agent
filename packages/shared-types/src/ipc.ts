/**
 * IPC ：渲染进程通过该层调用主进程的方法
 */
import type { ApprovalDecision, ApprovalView, ChangeSummaryView, ConversationSummary, HostInfo, HostStatus, ModelSettingsView } from "./domain.ts"
import type { IpcErrorPayload } from "./errors.ts"
import type { ConversationId, EntryId, OpenedView } from "./frame.ts"
import type { JsonObject } from "./json.ts"
import type { InputSubmissionView } from "./submission.ts"
import type { AppSubapp, SubappPreview } from "./subapps.ts"

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
  /**
   * 读工作区里的文本文件给内置编辑器；超过 2MB 或二进制一律拒绝（提示用系统程序打开）。
   * `mtimeMs` 同时返回，保存时作为乐观锁用。
   */
  "file.read": {
    readonly request: { readonly path: string }
    readonly response: { readonly content: string; readonly mtimeMs: number }
  }
  /**
   * 写回内置编辑器改的内容。`mtimeMs` 与磁盘不一致时返回 `conflict`，
   * 由用户决定覆盖还是放弃——避免和 Agent 同时改同一文件时互相覆盖。
   */
  "file.write": {
    readonly request: { readonly path: string; readonly content: string; readonly mtimeMs: number }
    readonly response:
      | { readonly status: "saved"; readonly mtimeMs: number }
      | { readonly status: "conflict"; readonly mtimeMs: number }
  }
  /**
   * 撤销单个文件到本轮基线：已跟踪文件回到基线版本，本轮新增的文件直接删除。
   * 只在 git 仓库且有基线时可用；路径由主进程按工作区边界校验。
   */
  "file.revert": {
    readonly request: { readonly conversationId: ConversationId; readonly path: string; readonly round?: number }
    readonly response: Record<string, never>
  }
  /**
   * 用系统默认程序打开工作区里的文件；路径由主进程按工作区边界校验。
   * 渲染进程不能把模型给的任意路径直接交给系统。
   */
  "file.open": {
    readonly request: { readonly path: string }
    readonly response: Record<string, never>
  }
  /** 写系统剪贴板；`file://` 下渲染进程的 Clipboard API 不可靠，统一走主进程。 */
  "clipboard.copy": {
    readonly request: { readonly text: string }
    readonly response: Record<string, never>
  }
  /**
   * 最近一轮的改动统计。git 仓库才给逐文件 +/-；非 git 返回 `repo:false`，
   * 界面用工具调用里的路径自行列文件。
   */
  "changes.get": {
    /** `round`：0 = 本轮（默认），1 = 上一轮，2 = 上上轮…最多保留 10 轮。 */
    readonly request: { readonly conversationId: ConversationId; readonly round?: number }
    readonly response: ChangeSummaryView & { readonly rounds: number }
  }
  /** 单个文件的 patch 文本；点开某个文件才算，不预生成。 */
  "changes.diff": {
    readonly request: { readonly conversationId: ConversationId; readonly path: string; readonly round?: number }
    readonly response: { readonly patch: string; readonly truncated: boolean }
  }
  /** 当前模型配置；密钥只报有无，不回传值。 */
  "model.get": {
    readonly request: Record<string, never>
    readonly response: ModelSettingsView
  }
  /** 保存模型配置；apiKey 留空则不改动已保存的密钥。 */
  "model.save": {
    readonly request: {
      readonly modelId: string
      readonly baseUrl?: string
      readonly apiKey?: string
    }
    readonly response: ModelSettingsView
  }
  /** 清除应用内保存的密钥（环境变量仍可回退）。 */
  "model.clearKey": {
    readonly request: Record<string, never>
    readonly response: ModelSettingsView
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
  /** 读取已安装子应用，包含 failed / disabled，供确认页与后续侧栏使用。 */
  "subapp.list": {
    readonly request: Record<string, never>
    readonly response: readonly AppSubapp[]
  }
  /** 由 Agent proposal id 获取确认页内容，并为可信 renderer 签发一次性安装 token。 */
  "subapp.preview": {
    readonly request: { readonly candidateId: string }
    readonly response: SubappPreview
  }
  /** 只接受 preview 生成的 token；不接受 renderer 回传源码或 manifest。 */
  "subapp.install": {
    readonly request: { readonly installToken: string; readonly forceSmokeFailure?: boolean }
    readonly response: AppSubapp
  }
  "subapp.setEnabled": {
    readonly request: { readonly slug: string; readonly enabled: boolean }
    readonly response: AppSubapp
  }
  "subapp.remove": {
    readonly request: { readonly slug: string }
    readonly response: Record<string, never>
  }
}

export type IpcChannel = keyof IpcMap
export type IpcRequest<K extends IpcChannel> = IpcMap[K]["request"]
export type IpcResponse<K extends IpcChannel> = IpcMap[K]["response"]

/** 主进程的返回值：成功带值，失败带码。渲染进程不做异常穿透。 */
export type IpcResult<K extends IpcChannel> =
  | { readonly ok: true; readonly value: IpcResponse<K> }
  | { readonly ok: false; readonly error: IpcErrorPayload }
