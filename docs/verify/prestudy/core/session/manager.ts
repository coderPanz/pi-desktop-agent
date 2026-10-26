/**
 * 会话管理器：把 Harness 的会话操作收成几个方法。
 * 只做转发与订阅，不做任何打印 —— 打印交给 CLI / 场景脚本，阶段 5 换成 IPC 时可原样复用。
 */

import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import {
  InboxDoc,
  type AgentChange,
  type Conversation,
  type ConversationId,
  type ConversationView,
  type EntryId,
  type Harness,
  type WatchHandle,
} from "@earendil-works/pi-durable";

/** 忙碌策略。 */
export type WhenBusy = "followUp" | "steer" | "reject";

/** 收到帧时的回调（CLI 用它打印）。 */
export type FrameHandler = (id: ConversationId, view: ConversationView) => void;

export class SessionManager {
  readonly #harness: Harness;
  readonly #onFrame: FrameHandler | undefined;
  /** 每个会话一个订阅句柄。 */
  readonly #watches = new Map<ConversationId, WatchHandle<ConversationView>>();
  /** 每个会话的最新副本，供 busy / 列表 / 打印使用。 */
  readonly #views = new Map<ConversationId, ConversationView>();
  activeId: ConversationId | undefined;

  constructor(harness: Harness, onFrame?: FrameHandler) {
    this.#harness = harness;
    this.#onFrame = onFrame;
  }

  /** 取根会话、开始订阅，并设为当前会话。 */
  async init(ctx: Context): Promise<Conversation> {
    const root = await this.#harness.root(ctx);
    await this.watch(root.id, ctx);
    this.activeId = root.id;
    return root;
  }

  /** 订阅一个会话（已订阅则跳过）。切换会话时不销毁订阅，切走期间的帧不会丢。 */
  async watch(id: ConversationId, ctx: Context): Promise<void> {
    if (this.#watches.has(id)) return;
    const conversation = await this.#conversation(id, ctx);
    const watch = await conversation.watch(ctx);
    this.#views.set(id, watch.value); // start() 不重放历史，先存下初始快照
    this.#watches.set(id, watch);
    watch.start(async (value) => {
      this.#views.set(id, value);
      this.#onFrame?.(id, value);
    });
  }

  view(id: ConversationId): ConversationView | undefined {
    return this.#views.get(id);
  }

  /** 是否在跑：只看 pi.live.run，不猜 promise。 */
  busy(id: ConversationId): boolean {
    const live = this.view(id)?.docs["pi.live"] as { run?: unknown } | undefined;
    return live?.run !== undefined;
  }

  ids(): ConversationId[] {
    return [...this.#views.keys()].sort((left, right) => left - right);
  }

  active(): ConversationId {
    if (this.activeId === undefined) throw new Error("还没有活动会话");
    return this.activeId;
  }

  switchTo(id: ConversationId): void {
    if (!this.#views.has(id)) throw new Error(`会话 ${id} 不存在`);
    this.activeId = id;
  }

  /** 新建独立会话（新会话不会继承根会话的配置，agent 里要把模型给它）。 */
  async create(ctx: Context, agent?: AgentChange): Promise<Conversation> {
    const conversation = await this.#harness.createConversation({
      ownership: { kind: "ownerless" },
      ...(agent === undefined ? {} : { agent }),
    }, ctx);
    await this.watch(conversation.id, ctx);
    return conversation;
  }

  /** 提交一条输入；requestId 每次新生成，方便日志对账。 */
  async submit(id: ConversationId, text: string, whenBusy: WhenBusy | undefined, ctx: Context) {
    const conversation = await this.#conversation(id, ctx);
    const requestId = randomUUID();
    const submission = await conversation.submit({
      type: "input",
      content: text,
      requestId,
      ...(whenBusy === undefined ? {} : { whenBusy }),
    }, ctx);
    return { requestId, submission };
  }

  /** 中断：返回耗时。取消 wait 的 ctx 不会停工作，只有这个会。 */
  async abort(id: ConversationId, ctx: Context): Promise<number> {
    const conversation = await this.#conversation(id, ctx);
    const startedAt = Date.now();
    await conversation.abort(ctx);
    return Date.now() - startedAt;
  }

  /** 从某条可见 entry 分叉。 */
  async fork(id: ConversationId, at: EntryId, ctx: Context): Promise<Conversation> {
    const conversation = await this.#conversation(id, ctx);
    const forked = await conversation.fork(at, { ownership: { kind: "ownerless" } }, ctx);
    await this.watch(forked.id, ctx);
    return forked;
  }

  /** 开新上下文；handoff 会进入模型上下文。 */
  async reset(id: ConversationId, handoff: string, ctx: Context): Promise<void> {
    await (await this.#conversation(id, ctx)).reset(handoff, ctx);
  }

  /** 手动压缩并等任务结束（compact 只返回 TaskId）。 */
  async compact(id: ConversationId, hint: string | undefined, ctx: Context) {
    const conversation = await this.#conversation(id, ctx);
    const startedAt = Date.now();
    const taskId = await conversation.compact(hint, ctx);
    await this.#harness.waitForTask(taskId, ctx);
    return { taskId, elapsedMs: Date.now() - startedAt };
  }

  /** 排队中的输入；undefined 表示文档没写过，属于正常值。 */
  async inbox(id: ConversationId, ctx: Context) {
    return (await this.#harness.snapshot(InboxDoc, id, ctx))?.items;
  }

  /** 读条目（升序）。 */
  async entries(id: ConversationId, ctx: Context) {
    const conversation = await this.#conversation(id, ctx);
    return (await conversation.entries({ order: "ascending" }, 200, undefined, ctx)).items;
  }

  /** 模型上下文，用于验证 reset / compact。 */
  async messages(id: ConversationId, ctx: Context) {
    const conversation = await this.#conversation(id, ctx);
    return (await conversation.context(ctx)).messages;
  }

  async waitForIdle(id: ConversationId, ctx: Context): Promise<void> {
    await (await this.#conversation(id, ctx)).waitForIdle(ctx);
  }

  async dispose(): Promise<void> {
    const watches = [...this.#watches.values()];
    this.#watches.clear();
    await Promise.all(watches.map((watch) => watch.stop()));
  }

  async #conversation(id: ConversationId, ctx: Context): Promise<Conversation> {
    const conversation = await this.#harness.conversation(id, ctx);
    if (conversation === undefined) throw new Error(`会话 ${id} 不存在`);
    return conversation;
  }
}
