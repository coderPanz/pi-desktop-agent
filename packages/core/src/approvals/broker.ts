/**
 * 审批中枢：工具调用「询问审批环节」落到宿主身上
 */
import type { Context } from "@earendil-works/chord"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { ConversationId as DurableConversationId, Harness } from "@earendil-works/pi-durable"
import { AppApprovalsDoc } from "@pi/shared-docs"
import type { AppApprovals } from "@pi/shared-docs"
import type { ApprovalDecision, ApprovalView, ConversationId } from "@pi/shared-types"

// 审批输入
export type ApprovalInput = {
  readonly tool: string // 工具名称
  readonly summary: string // 审批描述
  readonly conversationId: number // 会话 id
  readonly callId: string // 调用 id
}

/** 中断信号，挂起该审批请求 */
export type ApprovalContextInput = {
  readonly signal: AbortSignal | undefined
}

/** 审批超时时间 */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000

export type ApprovalBrokerOptions = {
  readonly harness: Harness
  /** 待批集合一变就回调宿主，让宿主把「现在还有哪些审批在等人」推给界面 */
  readonly onChange: (
    conversationId: ConversationId,
    pending: readonly ApprovalView[],
  ) => void
  readonly timeoutMs?: number // 审批超时时间
  readonly now?: () => number // 当前时间
  readonly nextId?: () => string // 生成审批 id
}

// 审批闸门
type Gate = {
  readonly view: ApprovalView // UI 展示
  readonly settle: (decision: ApprovalDecision) => void // 是否放行
}

// 审批类
export class ApprovalBroker {
  readonly #harness: Harness
  // 待批集合一变就回调宿主，让宿主把「现在还有哪些待审批的请求」推给界面
  readonly #onChange: (
    conversationId: ConversationId,
    pending: readonly ApprovalView[],
  ) => void
  readonly #timeoutMs: number
  readonly #now: () => number
  readonly #nextId: () => string
  /** 审批放行通道 */
  readonly #gates = new Map<string, Gate>()
  /** 会话 id → 该会话中待批请求的 id 的映射， */
  readonly #byConversation = new Map<number, string[]>()
  #counter = 0 // 审批 id 生成器

  constructor(options: ApprovalBrokerOptions) {
    this.#harness = options.harness
    this.#onChange = options.onChange // 待批集合一变就回调宿主，让宿主把「现在还有哪些待审批的请求」推给界面
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS
    this.#now = options.now ?? (() => Date.now())
    this.#nextId =
      options.nextId ??
      (() => {
        this.#counter += 1
        return `a${String(this.#counter)}`
      })
  }

  /** 审批请求，返回 true 才执行 */
  async request(
    input: ApprovalInput,
    context: ApprovalContextInput, // 中断信号
  ): Promise<boolean> {
    const id = this.#nextId() // 生成审批 id
    const view: ApprovalView = {
      id, // 审批 id
      conversationId: input.conversationId, // 会话 id
      callId: input.callId, // 调用 id
      tool: input.tool, // 工具名称
      summary: input.summary, // 审批描述
      createdAt: this.#now(), // 审批请求创建时间
    }

    // 等待异步任务：审批请求
    const decision = await new Promise<ApprovalDecision>(resolve => {
      let settled = false // 是否已经判定
      const settle = (value: ApprovalDecision): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        context.signal?.removeEventListener("abort", onAbort) //
        resolve(value)
      }

      const timer = setTimeout(() => settle("expired"), this.#timeoutMs) // 超时判定
      const onAbort = (): void => settle("denied") // 拒绝判定
      if (context.signal?.aborted === true)
        settle("denied") // 中断信号判定
      else context.signal?.addEventListener("abort", onAbort, { once: true }) // 监听中断信号

      /**
       * 闭包场景：函数内部变量保存引用，外部执行。
       * 记录审批 id 和 审批视图-审批决定
       * 在 respond 拿到 gate.settle 并执行 settle 最后调用 resolve ，该 decision 函数结束
       */
      this.#gates.set(id, { view, settle })
      // 获取该会话正在等待的审批 id 列表，没有就创建一个空数组
      this.#idsOf(view.conversationId).push(id)
      // 通知界面并拿到 审批视图和审批决定
      this.#publish(view.conversationId)
      // 写入待批请求
      void this.#writePending(view.conversationId)
    })

    // 审批结束，将审批记录从内存中移除，不影响持久化
    this.#forget(id, input.conversationId)
    // 持久化审批决定
    await this.#writeDecision(input.conversationId, id, decision)
    // 审批是否通过
    return decision === "approved"
  }

  /**
   * 该会话的待批请求
   * 顺手清理残留：重启后文档里可能留着上次进程崩溃时的 pending，
   * 那些已经没人在等答复，永远不可能被执行——在这里清掉，免得界面显示重启前残留、点不动的审批。
   */
  async list(conversationId: ConversationId): Promise<readonly ApprovalView[]> {
    const live = this.#views(conversationId)
    await this.#reconcile(conversationId, live)
    return live
  }

  /** 闭包：审批决定，用户通过 approved 传入是否通过 */
  respond(id: string, approved: boolean): ApprovalDecision {
    const gate = this.#gates.get(id)
    if (gate === undefined) return "expired" // 审批失效
    // 开始执行审批
    gate.settle(approved ? "approved" : "denied")
    return approved ? "approved" : "denied"
  }

  /** 关闭时把所有挂起的请求结算掉，避免留下没人等的 Promise */
  closeAll(): void {
    for (const [id, gate] of [...this.#gates]) {
      // 清理审批闸门
      gate.settle("expired")
      // 清理审批记录
      this.#forget(id, gate.view.conversationId)
    }
  }

  // 获取该会话正在等待的审批 id 列表，没有就创建一个空数组
  #idsOf(conversationId: number): string[] {
    // 拿该会话正在等待的审批 id 列表
    const existing = this.#byConversation.get(conversationId)
    if (existing !== undefined) return existing
    const created: string[] = []
    this.#byConversation.set(conversationId, created)
    return created
  }

  // 获取审批视图和审批决定
  #views(conversationId: number): readonly ApprovalView[] {
    // 拿该会话正在等待的审批 id 列表
    const ids = this.#byConversation.get(conversationId) ?? []
    // 根据 审批 id 获取 审批视图 和 审批决定
    return ids.flatMap(id => {
      const gate = this.#gates.get(id)
      return gate === undefined ? [] : [gate.view]
    })
  }

  // 审批结束后，将审批记录从内存中移除，不影响持久化
  #forget(id: string, conversationId: number): void {
    this.#gates.delete(id)
    const ids = this.#byConversation.get(conversationId)
    if (ids === undefined) return
    const index = ids.indexOf(id)
    if (index !== -1) ids.splice(index, 1)
    if (ids.length === 0) this.#byConversation.delete(conversationId)
    // 通知界面
    this.#publish(conversationId)
  }

  // 通知界面
  #publish(conversationId: number): void {
    this.#onChange(
      conversationId as ConversationId,
      // 获取当前会话的审批视图和审批决定
      this.#views(conversationId),
    )
  }

  /** 持久化审批请求 */
  async #writePending(conversationId: number): Promise<void> {
    await this.#commit(conversationId, doc => {
      doc.pending = this.#views(conversationId).map(view => ({
        id: view.id,
        callId: view.callId,
        tool: view.tool,
        summary: view.summary,
        createdAt: view.createdAt,
      }))
    })
  }

  // 持久化审批决定
  async #writeDecision(
    conversationId: number,
    id: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    await this.#commit(conversationId, doc => {
      const remaining = this.#views(conversationId)
      doc.pending = remaining.map(view => ({
        id: view.id,
        callId: view.callId,
        tool: view.tool,
        summary: view.summary,
        createdAt: view.createdAt,
      }))
      doc.latest = { id, decision, at: this.#now() }
    })
  }

  /** 清掉文档里已经没有人在等答复的 pending（崩溃残留） */
  async #reconcile(
    conversationId: ConversationId,
    live: readonly ApprovalView[],
  ): Promise<void> {
    const stored = await this.#harness.snapshot(
      AppApprovalsDoc, // 审批文档类型
      conversationId as DurableConversationId,
      BACKGROUND_CONTEXT,
    )
    const pending = stored?.pending ?? []
    if (pending.length === live.length) return
    await this.#commit(conversationId, doc => {
      doc.pending = live.map(view => ({
        id: view.id,
        callId: view.callId,
        tool: view.tool,
        summary: view.summary,
        createdAt: view.createdAt,
      }))
    })
  }

  /** 提交文档变更 */
  async #commit(
    conversationId: number,
    // AppApprovals：待批队列+最近一次审批决定
    mutate: (doc: AppApprovals) => void,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<void> {
    try {
      await this.#harness.commit(async tx => {
        const doc = await tx.doc(
          AppApprovalsDoc,
          conversationId as DurableConversationId,
        )
        mutate(doc)
      }, context)
    } catch {
      // 会话不存在、库已关、或文档被淘汰：审计信息丢了，但审批本身照常进行。
    }
  }
}
