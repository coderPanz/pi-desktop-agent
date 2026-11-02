/**
 * 会话操作：CLI 与 IPC 共用。
 *
 * 该文件不保存聊天记录或任务状态：真正的事实在 pi-durable 的 Storage 中
 * - Harness：取得/创建会话、读文档、等待任务
 * - Conversation：对某一个会话提交消息、fork、reset、读 entries
 * - Storage：直接查询已持久化的会话记录
 */

// pi-durable 的 API 都要传 context；这里没特殊需求，默认传 BACKGROUND_CONTEXT 即可
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { Context } from "@earendil-works/chord"
// InboxDoc / LiveDoc 是 durable 【已提交】的会话状态：排队消息和当前运行状态。
import {
  InboxDoc,
  LiveDoc,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable"
import type {
  AgentChange,
  CompactionResult,
  Conversation,
  ConversationId,
  ConversationRecord,
  ConversationWatch,
  ContextView,
  EntryId,
  EntryRecord,
  Harness,
  InboxItem,
  QueueMode,
  SettledTask,
  Storage,
  Submission,
  UserInput,
} from "@earendil-works/pi-durable"

/** 入队默认策略`one-at-a-time` 是「一次只放一条」： */
export const DEFAULT_QUEUE_MODE: QueueMode = "one-at-a-time"

export type QueueModes = {
  steeringMode: QueueMode // 插话转向入队策略
  followUpMode: QueueMode // 所有轮次结束后的入队策略
}

/** 默认入队策略 */
export function defaultQueueModes(): QueueModes {
  return { steeringMode: DEFAULT_QUEUE_MODE, followUpMode: DEFAULT_QUEUE_MODE }
}

// 会话摘要
export type ConversationSummary = {
  readonly id: ConversationId
  readonly parent: ConversationRecord["parent"] // 父会话记录：含 父会话 id - 条目 id
  /**  是否忙碌：`pi.live.run` 存在即为忙。 */
  readonly busy: boolean
  /** 排队条目数：`pi.inbox` 里排队的条目数。 */
  readonly queued: number
}

// 会话管理器选项
export type SessionManagerOptions = {
  readonly harness: Harness
  readonly storage: Storage
  /** 起始会话；默认 root 会话。 */
  readonly conversationId?: ConversationId
  /** 入队策略的**可变**持有者：`HarnessOptions.settings` 每次读取它，改这里立即生效。 */
  readonly modes?: QueueModes
}

// 提交选择
export type SubmitOptions = {
  readonly whenBusy?: "steer" | "followUp" | "reject"
  /** 幂等键：同一 requestId 重复提交命中同一条 submission。 */
  readonly requestId?: string
}

// 会话管理器
export class SessionManager {
  #harness: Harness // harness， # 表示类内部私有字段，外部无法访问
  #storage: Storage // 存储
  #conversationId: ConversationId // 当前会话 id
  #modes: QueueModes // 入队策略
  #watches = new Map<ConversationId, ConversationWatch>() // 会话订阅映射

  private constructor(
    conversationId: ConversationId,
    options: SessionManagerOptions,
  ) {
    this.#harness = options.harness
    this.#storage = options.storage
    this.#conversationId = conversationId
    this.#modes = options.modes ?? defaultQueueModes()
  }

  /**
   * 打开会话管理器，确定【起始会话】
   * `harness.root()` 会取得 root 会话；第一次使用时会创建它
   * `harness.conversation()` 只按 id 查会话句柄（通过句柄可以操作真实的对象），返回 undefined 表示该 id 不存在。
   */
  static async open(
    options: SessionManagerOptions,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<SessionManager> {
    const id =
      options.conversationId ?? (await options.harness.root(context)).id

    // 额外查一次，避免调用方传入一个不存在的 conversationId。
    const conversation = await options.harness.conversation(id, context)
    if (conversation === undefined) throw new Error(`会话不存在：${String(id)}`)
    return new SessionManager(id, options)
  }

  /** 获取当前会话 id
   * get 表示 getter，外部可通过 this.conversationId 访问，无需 conversationId()，且无法赋值
   */
  get conversationId(): ConversationId {
    return this.#conversationId
  }

  /**  获取入队策略 */
  get modes(): QueueModes {
    return this.#modes
  }

  /** 只覆盖传入的策略；例如只改 steeringMode 时 followUpMode 保持原值 */
  setModes(next: Partial<QueueModes>): void {
    if (next.steeringMode !== undefined)
      this.#modes.steeringMode = next.steeringMode
    if (next.followUpMode !== undefined)
      this.#modes.followUpMode = next.followUpMode
  }

  /** 列出所有会话，并为每个会话补充“是否正在忙”和“还有几条消息排队”的摘要信息
   *[
     {
       id: 5,
       parent: {
         conversationId: 1,
         at: 3,
       },
       busy: true,
       queued: 2,
     }
   ]
   */
  async list(
    context: Context = BACKGROUND_CONTEXT,
    limit = 50, // 默认读取 50 条会话
  ): Promise<ConversationSummary[]> {
    // Storage.scanConversations 是直接查持久化记录；第三个参数是分页 cursor，首次查询传 undefined。
    const page = await this.#storage.scanConversations(
      { order: "ascending" }, // 按 id 升序排列
      limit,
      undefined,
      context,
    )
    return await Promise.all(
      page.items.map(async record => ({
        id: record.id,
        parent: record.parent,
        busy: await this.isBusy(record.id, context),
        queued: (await this.#inboxItems(record.id, context)).length,
      })),
    )
  }

  /**
   * 切会话：只校验存在并改指针，不销毁任何 watch 订阅，方便后续切回来复用订阅而不是重建订阅
   * 传新的会话 id 返回 对应会话的操作对象
   */
  async select(
    id: ConversationId,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<Conversation> {
    // 取到的是操作该会话的轻量句柄，状态仍存于 Storage
    const conversation = await this.#harness.conversation(id, context)
    if (conversation === undefined) throw new Error(`会话不存在：${String(id)}`)
    this.#conversationId = id
    return conversation
  }

  /** 新建空白会话：默认 ownerless：用户手动开的会话不属于任何 task  */
  async create(
    context: Context = BACKGROUND_CONTEXT,
    options: { readonly agent?: AgentChange } = {},
  ): Promise<Conversation> {
    return await this.#harness.createConversation(
      {
        // ownership 决定生命周期；ownerless 不会随着某个 task 的结束而被级联取消。
        ownership: { kind: "ownerless" }, // ownership所有权 的 类型为 无主的
        // 传 agent 时覆盖新会话的初始 agent 配置；省略则使用默认配置。
        ...(options.agent ?? {}),
      },
      context,
    )
  }

  /**
   * 提交用户输入。`conversation.submit()` 会先持久化一个 Submission，再按忙闲状态放入 transcript(entry) 或 inbox
   * 默认 `followUp`：忙时等当前 run 结束后再作为下一轮输入，不打断本轮
   */
  async submit(
    content: UserInput,
    context: Context = BACKGROUND_CONTEXT,
    options: SubmitOptions = {}, // 提交选项
  ): Promise<Submission> {
    const conversation = await this.#conversation(context)
    return await conversation.submit(
      {
        // input 会让模型回答；若只想记一条不进模型上下文的记录，应提交 type: "write"
        type: "input",
        content,
        whenBusy: options.whenBusy ?? "followUp", // 忙时策略
        requestId: options.requestId ?? undefined,
      },
      context,
    )
  }

  /** 中断当前会话：撤回排队的 input 、给运行中的 task 写入 abort 标记，并等待普通工作停止 */
  async abort(
    context: Context = BACKGROUND_CONTEXT, // context 传递信号中断信息
    options: { readonly background?: boolean } = {}, // 决定“取消范围是否包含后台任务”
  ): Promise<void> {
    const conversation = await this.#conversation(context)
    // abort 是 durable 操作；不是只取消本地 Promise，重启后也能看见已请求取消
    await conversation.abort(context, options)
  }

  /**
   * 分叉。`at` 默认取最新可见条目：调用方不必自己算 entryId。
   * 新会话仍是 ownerless，history 通过 parent 链继承，历史不丢
   */
  async fork(
    context: Context = BACKGROUND_CONTEXT,
    at?: EntryId, // 在 xxx 地方分叉的
    options: { readonly agent?: AgentChange } = {},
  ): Promise<Conversation> {
    const conversation = await this.#conversation(context)
    // fork 的位置必须是一条真实 entry；不传则从当前可见历史的最新 entry 分叉。
    const entryId = at ?? (await this.#lastEntryId(conversation, context))
    return await conversation.fork(
      // fork 保存 parent + at 引用，不复制全部 entries；后续两条分支各自追加。
      entryId,
      {
        ownership: { kind: "ownerless" },
        agent: options.agent ?? {}, 
      },
      context,
    )
  }

  /**
   * 重置模型上下文（写入 `pi.reset` / head 边界），不删除以前的 entries
   * handoff 会作为新上下文开头的交接说明
   */
  async reset(
    context: Context = BACKGROUND_CONTEXT,
    handoff?: string,
  ): Promise<void> {
    const conversation = await this.#conversation(context)
    await conversation.reset(handoff, context)
  }

  /**
   * 请求压缩上下文。`conversation.compact()` 只创建并返回 taskId；
   * 再用 `harness.waitForTask()` 等到 task 进入 terminal，调用方拿到的是最终结果
   */
  async compact(
    context: Context = BACKGROUND_CONTEXT,
    instructions?: string,
  ): Promise<SettledTask<CompactionResult>> {
    const conversation = await this.#conversation(context)
    const taskId = await conversation.compact(instructions, context)
    return await this.#harness.waitForTask(taskId, context)
  }

  /** 读取当前会话的排队项；`pi.inbox` 尚未创建时按空数组处理 */
  async inbox(
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<readonly InboxItem[]> {
    return await this.#inboxItems(this.#conversationId, context)
  }

  /**
   * 忙判定 `pi.live.run`，不靠某个本地的异步任务来猜，必需是已提交并正在执行的异步任务，该任务回落到 pi.live.run 中
   * `harness.snapshot()` 读取一个 document 当前快照，不创建 watch，也不修改状态
   */
  async isBusy(
    conversationId: ConversationId,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<boolean> {
    // LiveDoc， 读取 doc 中的 pi.live.run 字段
    const live = await this.#harness.snapshot(LiveDoc, conversationId, context)
    return live?.run !== undefined
  }

  /**
   * 查看“如果现在让模型回答，它会看到哪些历史消息”。返回值同时包含对应的会话记录。
   * reset / 压缩前的旧记录仍保存在 Storage，但可能不会再发给模型；这里会按这些规则过滤。
   * 传入 `at` 时，表示只看到该 entry 为止的历史：可用来先查看“若从这里 fork，新会话会带什么上下文”，不会真的创建 fork。
   */
  async contextView(
    context: Context = BACKGROUND_CONTEXT,
    at?: EntryId,
  ): Promise<ContextView> {
    const conversation = await this.#conversation(context)
    return await conversation.context(
      context,
      at === undefined ? undefined : { at },
    )
  }

  /**
   * 分页读取条目
   * `conversation.entries()` 会自动沿 fork 的 parent 链读取继承历史；第三个参数是分页 cursor，首次读取为 undefined。
   */
  async entries(
    context: Context = BACKGROUND_CONTEXT,
    limit = 20,
    order: "ascending" | "descending" = "descending",
  ): Promise<readonly EntryRecord[]> {
    const conversation = await this.#conversation(context)
    const page = await conversation.entries(
      { order },
      limit,
      undefined,
      context,
    )
    return page.items
  }

  /**
   * 取 watchk, **切换会话不销毁它**：切回来仍是同一个 seq 序列
   * 用完由 `closeWatches()` 统一停止
   */
  async view(
    context: Context = BACKGROUND_CONTEXT,
    conversationId: ConversationId = this.#conversationId,
  ): Promise<ConversationWatch> {
    const cached = this.#watches.get(conversationId)
    if (cached !== undefined) return cached

    const conversation = await this.#harness.conversation(
      conversationId,
      context,
    )

    if (conversation === undefined) throw new Error(`会话不存在：${String(conversationId)}`)
  
    // watch 先给当前完整 ConversationView，之后持续给每次已提交变更；必须 stop() 释放订阅
    const watch = await conversation.watch(context)
    this.#watches.set(conversationId, watch)
    return watch
  }

  /** 停掉所有 watch（幂等） */
  async closeWatches(): Promise<void> {
    const watches = [...this.#watches.values()]
    this.#watches.clear()
    await Promise.all(watches.map(async watch => await watch.stop()))
  }

  /** 按当前 id 重新取得 Conversation 句柄；Manager 不缓存句柄，状态始终以 Harness/Storage 为准 */
  async #conversation(context: Context): Promise<Conversation> {
    const conversation = await this.#harness.conversation(
      this.#conversationId,
      context,
    )
    if (conversation === undefined) throw new Error(`会话不存在：${String(this.#conversationId)}`)
    return conversation
  }

  /** 获取排队项 */
  async #inboxItems(
    conversationId: ConversationId,
    context: Context,
  ): Promise<readonly InboxItem[]> {
    const inbox = await this.#harness.snapshot(
      InboxDoc,
      conversationId,
      context,
    )
    return inbox?.items ?? []
  }

  /** 用降序第一页的第一项取得最新可见 entry，作为默认 fork 点 */
  async #lastEntryId(
    conversation: Conversation,
    context: Context,
  ): Promise<EntryId> {
    const page = await conversation.entries(
      { order: "descending" },
      1,
      undefined,
      context,
    )
    const entry = page.items[0]
    if (entry === undefined) throw new Error("当前会话没有可 fork 的条目：请先发一条消息。")
    return entry.id
  }
}

/** root 会话 id 的再导出：调用方不用从 SDK 里掏 */
export { ROOT_CONVERSATION_ID }