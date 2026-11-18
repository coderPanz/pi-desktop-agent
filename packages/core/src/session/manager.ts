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
import { EntryKind, messageContentText } from "@pi/shared-types"
import type { ConversationSummary } from "@pi/shared-types"

import { clipTitle, countChars, TITLE_MAX_CHARS } from "../agent/summarize.ts"
import type { SummarizeTitle } from "../agent/summarize.ts"
import { UserError } from "../errors.ts"
import { latestInputSubmission } from "../harness/submissions.ts"
import type { Context } from "@earendil-works/chord"
// InboxDoc / LiveDoc 是 durable 【已提交】的会话状态：排队消息和当前运行状态。
import {
  AgentDoc,
  InboxDoc,
  LiveDoc,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable"
import { AppTitleDoc, AppTrashDoc } from "@pi/shared-docs"

import type { ConversationPurge } from "../storage/purge.ts"
import type {
  AgentChange,
  CompactionResult,
  Conversation,
  ConversationId,
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

/**
 * 会话摘要的形状由 `@pi/shared-types` 定义（渲染进程也要用），这里只做转出。
 * 两边形状若不一致，编译期就会报错——这正是把契约放在代码里的目的。
 */
export type { ConversationSummary } from "@pi/shared-types"

// 会话管理器选项
export type SessionManagerOptions = {
  readonly harness: Harness
  readonly storage: Storage
  /** 起始会话；默认 root 会话。 */
  readonly conversationId?: ConversationId
  /** 入队策略的**可变**持有者：`HarnessOptions.settings` 每次读取它，改这里立即生效。 */
  readonly modes?: QueueModes
  /** 物理删除能力；内存库没有，缺省时 `delete()` 退回「从会话列表移除」。 */
  readonly purge?: ConversationPurge
  /** 长标题的后台摘要；缺省时不摘要，直接截断第一条用户消息。 */
  readonly summarizeTitle?: SummarizeTitle
  /** 摘要生成好时通知宿主（界面靠推送更新，不用轮询会话列表）。 */
  readonly onTitle?: (conversationId: ConversationId, title: string) => void
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
  #purge: ConversationPurge | undefined // 物理删除（文件库才有）
  #summarizeTitle: SummarizeTitle | undefined // 长标题的后台摘要
  #onTitle: SessionManagerOptions["onTitle"] // 摘要就绪的回调
  /** 正在/已经跑过摘要的会话（按「哪条条目」去重，避免每次列表都再问一次模型）。 */
  #titles = new Map<ConversationId, { readonly from: EntryId; readonly state: "running" | "failed" }>()
  /**
   * 第一条用户消息的缓存：一条会话的第一条用户消息写进去就不会再变（重置也不删历史），
   * 所以命中一次就能一直用，列表不必每次回头翻条目。
   */
  #firstUser = new Map<ConversationId, { readonly entryId: EntryId; readonly text: string }>()
  #watches = new Map<ConversationId, ConversationWatch>() // 会话订阅映射

  private constructor(
    conversationId: ConversationId,
    options: SessionManagerOptions,
  ) {
    this.#harness = options.harness
    this.#storage = options.storage
    this.#conversationId = conversationId
    this.#modes = options.modes ?? defaultQueueModes()
    this.#purge = options.purge
    this.#summarizeTitle = options.summarizeTitle
    this.#onTitle = options.onTitle
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
    if (conversation === undefined) throw new UserError(`会话不存在：${String(id)}`)
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
    const hidden = new Set(await this.#hidden(context))
    return await Promise.all(
      page.items
        // 「删除」只是从列表移除：记录仍在库里，这里不返回
        .filter(record => !hidden.has(record.id))
        .map(async record => ({
          id: record.id,
          parent: record.parent,
          busy: await this.isBusy(record.id, context),
          queued: (await this.#inboxItems(record.id, context)).length,
          title: await this.#title(record.id, context),
        })),
    )
  }

  /**
   * 删除会话：不可恢复。
   *
   * - 文件库：交给 `purge` 做物理删除（条目、任务、提交、文档、登记行一起删）。`pi-durable` 的
   *   `Storage` 没有删除接口，所以这是「唯一写者」的唯一例外，见 `storage/purge.ts`；
   * - 内存库（测试、`--memory`）没有 SQL：退回写 `app.trash`，只从会话列表移除。
   *
   * 三种情况直接拒绝：根会话、正在运行、还有子会话（分叉/被 task 拥有）。
   */
  async delete(
    conversationId: ConversationId,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<void> {
    if (conversationId === ROOT_CONVERSATION_ID) throw new UserError("根会话不能删除。")
    if ((await this.#harness.conversation(conversationId, context)) === undefined) {
      throw new UserError(`会话不存在：${String(conversationId)}`)
    }
    if (await this.isBusy(conversationId, context)) {
      throw new UserError(`会话 #${String(conversationId)} 正在运行，先停止再删除。`)
    }
    const id = conversationId as number
    if (this.#purge !== undefined) {
      await this.#purge(id)
      return
    }
    await this.#harness.commit(async tx => {
      const trash = await tx.doc(AppTrashDoc)
      if (!trash.hidden.includes(id)) {
        trash.hidden.push(id)
        trash.hidden.sort((left, right) => left - right)
      }
    }, context)
  }

  /** 已从列表移除的会话 id。 */
  async #hidden(context: Context): Promise<readonly number[]> {
    const trash = await this.#harness.snapshot(AppTrashDoc, context)
    return trash?.hidden ?? []
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
    if (conversation === undefined) throw new UserError(`会话不存在：${String(id)}`)
    this.#conversationId = id
    return conversation
  }

  /** 新建空白会话：默认 ownerless：用户手动开的会话不属于任何 task  */
  async create(
    context: Context = BACKGROUND_CONTEXT,
    options: { readonly agent?: AgentChange } = {},
  ): Promise<Conversation> {
    const rootAgent = await this.#harness.snapshot(AgentDoc, ROOT_CONVERSATION_ID, context)
    return await this.#harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        // SDK 的 ownerless 会话从空 agent 开始；模型默认取 root，显式覆盖（含 null）优先。
        agent: { ...options.agent, model: options.agent?.model === undefined ? rootAgent?.model : options.agent.model },
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

  /** 当前/最近已开始用户输入的持久化状态；后续排队输入不遮住当前轮次失败。 */
  async latestSubmission(conversationId: ConversationId, context: Context = BACKGROUND_CONTEXT) {
    return await latestInputSubmission(this.#storage, conversationId, context)
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

    if (conversation === undefined) throw new UserError(`会话不存在：${String(conversationId)}`)
  
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
    if (conversation === undefined) throw new UserError(`会话不存在：${String(this.#conversationId)}`)
    return conversation
  }

  /**
   * 侧栏标题：第一条用户消息。
   *
   * - 不超过 10 字：直接用原文；
   * - 超过 10 字：先返回截断的原文顶着，同时后台问一次模型压成 10 字以内，写好 `app.title` 后
   *   用 `onTitle` 推给界面（同一个会话 + 同一条条目只问一次）；
   * - 已经存过摘要（`from` 对得上）：直接用，不再问。
   */
  async #title(conversationId: ConversationId, context: Context): Promise<string | undefined> {
    const first = await this.#firstUserText(conversationId, context)
    if (first === undefined) return undefined

    const stored = await this.#harness.snapshot(AppTitleDoc, conversationId, context)
    if (stored !== undefined && stored.from === first.entryId && stored.title !== "") return stored.title

    const clipped = clipTitle(first.text)
    if (countChars(first.text) <= TITLE_MAX_CHARS) return clipped

    const job = this.#titles.get(conversationId)
    if (job === undefined || job.from !== first.entryId) {
      this.#titles.set(conversationId, { from: first.entryId, state: "running" })
      void this.#summarize(conversationId, first)
    }
    return clipped
  }

  /** 后台摘要：成功就落盘 + 通知宿主；失败只记一笔，别每次列会话都重试一遍。 */
  async #summarize(
    conversationId: ConversationId,
    first: { readonly entryId: EntryId; readonly text: string },
  ): Promise<void> {
    const summarize = this.#summarizeTitle
    if (summarize === undefined) return
    const title = await summarize(first.text)
    if (title === undefined) {
      this.#titles.set(conversationId, { from: first.entryId, state: "failed" })
      return
    }
    try {
      await this.#harness.commit(async tx => {
        const doc = await tx.doc(AppTitleDoc, conversationId)
        doc.title = title
        doc.from = first.entryId as number
      }, BACKGROUND_CONTEXT)
    } catch {
      // 会话在摘要期间被删掉/库已关：标题没了不影响任何东西
      this.#titles.delete(conversationId)
      return
    }
    this.#onTitle?.(conversationId, title)
  }

  /** 会话里第一条有文字的用户消息（沿 fork 祖先链找，和界面看到的顺序一致）。 */
  async #firstUserText(
    conversationId: ConversationId,
    context: Context,
  ): Promise<{ readonly entryId: EntryId; readonly text: string } | undefined> {
    const cached = this.#firstUser.get(conversationId)
    if (cached !== undefined) return cached
    const conversation = await this.#harness.conversation(conversationId, context)
    if (conversation === undefined) return undefined
    const page = await conversation.entries({ order: "ascending" }, 20, undefined, context)
    for (const entry of page.items) {
      if (entry.kind !== EntryKind.user) continue
      const text = (entry.model ?? []).map(message => messageContentText(message)).join("").trim()
      if (text === "") continue
      const found = { entryId: entry.id, text }
      this.#firstUser.set(conversationId, found)
      return found
    }
    return undefined
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
    if (entry === undefined) throw new UserError("当前会话没有可 fork 的条目：请先发一条消息。")
    return entry.id
  }
}

/** root 会话 id 的再导出：调用方不用从 SDK 里掏 */
export { ROOT_CONVERSATION_ID }