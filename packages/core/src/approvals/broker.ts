/**
 * 审批中枢：把扩展里的「询问审批环节」落到宿主身上
 *
 * 一次审批的生命周期：
 *
 * ```
 * 工具要执行 → 扩展的 beforeTool 调 approver（本中枢）
 *   ① 生成 id，写进 app.approvals.pending，通知界面（push）
 *   ② 创建一个等着答复的 Promise，等界面答复 / 超时 / 会话被取消
 *   ③ 无论哪种结局，都把 pending 摘掉、写 latest，再通知界面
 * ```
 *
 * 为什么真正决定放行的是内存里那个 Promise，文档只是镜像：
 * `HookApi` 只能 `snapshot`（不能 `watch`），所以钩子无法「等文档变化」；
 * 而答复必须立刻解除阻塞，所以真正放行的开关只能是同进程里的一个 Promise。
 * 文档留给审计，以及重启后清理残留（`list()` 会顺手清，见 `#reconcile`）。
 */
import type { Context } from "@earendil-works/chord"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { ConversationId as DurableConversationId, Harness } from "@earendil-works/pi-durable"
import { AppApprovalsDoc } from "@pi/shared-docs"
import type { AppApprovals } from "@pi/shared-docs"
import type { ApprovalDecision, ApprovalView, ConversationId } from "@pi/shared-types"

/**
 * 一条审批请求（与 `@pi/ext-coding` 的 `ApprovalRequest` 结构一致）
 */
export type ApprovalInput = {
  readonly tool: string
  readonly summary: string
  readonly conversationId: number
  readonly callId: string
}

/** 答复通道拿到的环境信息：会话关闭/中断时宿主据此收掉挂起的请求。 */
export type ApprovalContextInput = {
  readonly signal: AbortSignal | undefined
}

/** 默认审批超时；与扩展里那次超时同值，谁先到都按拒绝处理。 */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000

export type ApprovalBrokerOptions = {
  readonly harness: Harness
  /** 待审批集合变化时回调（宿主用来推送）。 */
  readonly onChange: (conversationId: ConversationId, pending: readonly ApprovalView[]) => void
  readonly timeoutMs?: number
  readonly now?: () => number
  /** 生成审批 id；测试可注入确定值。 */
  readonly nextId?: () => string
}

type Gate = {
  readonly view: ApprovalView
  readonly settle: (decision: ApprovalDecision) => void
}

export class ApprovalBroker {
  readonly #harness: Harness
  readonly #onChange: (conversationId: ConversationId, pending: readonly ApprovalView[]) => void
  readonly #timeoutMs: number
  readonly #now: () => number
  readonly #nextId: () => string
  /** 待批请求：id → 结算函数。这是「谁能放行」的唯一依据。 */
  readonly #gates = new Map<string, Gate>()
  /** 会话 id → 该会话待批请求的 id，按产生顺序。 */
  readonly #byConversation = new Map<number, string[]>()
  #counter = 0

  constructor(options: ApprovalBrokerOptions) {
    this.#harness = options.harness
    this.#onChange = options.onChange
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS
    this.#now = options.now ?? (() => Date.now())
    this.#nextId =
      options.nextId ??
      (() => {
        this.#counter += 1
        return `a${String(this.#counter)}`
      })
  }

  /** 扩展的答复通道：返回 `true` 才执行。 */
  async request(input: ApprovalInput, context: ApprovalContextInput): Promise<boolean> {
    const id = this.#nextId()
    const view: ApprovalView = {
      id,
      conversationId: input.conversationId,
      callId: input.callId,
      tool: input.tool,
      summary: input.summary,
      createdAt: this.#now(),
    }

    const decision = await new Promise<ApprovalDecision>((resolve) => {
      let settled = false
      const settle = (value: ApprovalDecision): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        context.signal?.removeEventListener("abort", onAbort)
        resolve(value)
      }

      const timer = setTimeout(() => settle("expired"), this.#timeoutMs)
      const onAbort = (): void => settle("denied")
      if (context.signal?.aborted === true) settle("denied")
      else context.signal?.addEventListener("abort", onAbort, { once: true })

      this.#gates.set(id, { view, settle })
      this.#idsOf(view.conversationId).push(id)
      // 先登记再通知：界面收到推送后立刻点按钮也不会扑空。
      this.#publish(view.conversationId)
      void this.#writePending(view.conversationId)
    })

    this.#forget(id, input.conversationId)
    await this.#writeDecision(input.conversationId, id, decision)
    return decision === "approved"
  }

  /**
   * 该会话的待批请求。
   *
   * 顺手清理残留：重启后文档里可能留着上次进程崩溃时的 pending，
   * 那些已经没人在等答复，永远不可能被执行——在这里清掉，免得界面显示重启前残留、点不动的审批。
   */
  async list(conversationId: ConversationId): Promise<readonly ApprovalView[]> {
    const live = this.#views(conversationId)
    await this.#reconcile(conversationId, live)
    return live
  }

  /** 回答一条请求。已结束的请求返回它的终态（幂等），不报错。 */
  respond(id: string, approved: boolean): ApprovalDecision {
    const gate = this.#gates.get(id)
    if (gate === undefined) return "expired"
    gate.settle(approved ? "approved" : "denied")
    return approved ? "approved" : "denied"
  }

  /** 关闭时把所有挂起的请求结算掉，避免留下没人等的 Promise。 */
  closeAll(): void {
    for (const [id, gate] of [...this.#gates]) {
      gate.settle("expired")
      this.#forget(id, gate.view.conversationId)
    }
  }

  #idsOf(conversationId: number): string[] {
    const existing = this.#byConversation.get(conversationId)
    if (existing !== undefined) return existing
    const created: string[] = []
    this.#byConversation.set(conversationId, created)
    return created
  }

  #views(conversationId: number): readonly ApprovalView[] {
    const ids = this.#byConversation.get(conversationId) ?? []
    return ids.flatMap((id) => {
      const gate = this.#gates.get(id)
      return gate === undefined ? [] : [gate.view]
    })
  }

  #forget(id: string, conversationId: number): void {
    this.#gates.delete(id)
    const ids = this.#byConversation.get(conversationId)
    if (ids === undefined) return
    const index = ids.indexOf(id)
    if (index !== -1) ids.splice(index, 1)
    if (ids.length === 0) this.#byConversation.delete(conversationId)
    this.#publish(conversationId)
  }

  #publish(conversationId: number): void {
    this.#onChange(conversationId as ConversationId, this.#views(conversationId))
  }

  /** 文档写入失败不该影响审批本身：审计掉了就掉了，阻塞还得解开。 */
  async #writePending(conversationId: number): Promise<void> {
    await this.#commit(conversationId, (doc) => {
      doc.pending = this.#views(conversationId).map((view) => ({
        id: view.id,
        callId: view.callId,
        tool: view.tool,
        summary: view.summary,
        createdAt: view.createdAt,
      }))
    })
  }

  async #writeDecision(
    conversationId: number,
    id: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    await this.#commit(conversationId, (doc) => {
      const remaining = this.#views(conversationId)
      doc.pending = remaining.map((view) => ({
        id: view.id,
        callId: view.callId,
        tool: view.tool,
        summary: view.summary,
        createdAt: view.createdAt,
      }))
      doc.latest = { id, decision, at: this.#now() }
    })
  }

  /** 清掉文档里已经没有人在等答复的 pending（崩溃残留）。 */
  async #reconcile(
    conversationId: ConversationId,
    live: readonly ApprovalView[],
  ): Promise<void> {
    const stored = await this.#harness.snapshot(
      AppApprovalsDoc,
      conversationId as DurableConversationId,
      BACKGROUND_CONTEXT,
    )
    const pending = stored?.pending ?? []
    if (pending.length === live.length) return
    await this.#commit(conversationId, (doc) => {
      doc.pending = live.map((view) => ({
        id: view.id,
        callId: view.callId,
        tool: view.tool,
        summary: view.summary,
        createdAt: view.createdAt,
      }))
    })
  }

  /** 提交文档变更：失败了只审计掉，不影响审批本身。 */
  async #commit(
    conversationId: number,
    mutate: (doc: AppApprovals) => void,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<void> {
    try {
      await this.#harness.commit(async (tx) => {
        const doc = await tx.doc(AppApprovalsDoc, conversationId as DurableConversationId)
        mutate(doc)
      }, context)
    } catch {
      // 会话不存在、库已关、或文档被淘汰：审计信息丢了，但审批本身照常进行。
    }
  }
}
