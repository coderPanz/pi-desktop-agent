/**
 * 当「会话变了」的时候，通过该层处理将会话帧 变成一串带编号的通知，发给所有接收方
 *
 * 用法三步：
 *   1. `addSink(fn)` 注册接收方（Electron 里就是 `webContents.send`）；
 *   2. `open(会话 id)` 开始盯，拿到当前副本和起始帧号；
 *   3. 之后每次变化，每个接收方都会收到一帧 `{ convId, seq, ops }`。
 *
 * 三条约定：
 *   - `open()` 不补发历史，历史已经在返回的副本里；
 *   - 每个会话一条 seq，从 0 开始、每帧 +1，切会话不归零；
 *   - 发帧只是分发：慢的接收方不拖住会话，也不拖住别的接收方。
 */
import type { Context } from "@earendil-works/chord"

import { UserError } from "../errors.ts"
import type { ConversationId, ConversationWatch, Harness } from "@earendil-works/pi-durable"
import type { OpenedView, ViewFrame } from "@pi/shared-types"

import { materializeView } from "../harness/materialize.ts"

/** 帧的形状定义在 `@pi/shared-types`（渲染进程也要用）；这里只管什么时候发。 */
export type { ViewFrame }

/** 接收方：收到一帧就调一次。 */
export type FrameSink = (frame: ViewFrame) => void

export type FrameHubOptions = {
  /** 某个接收方抛错时交给它处理；不传就忽略，免得一个坏接收方打断其他。 */
  readonly onError?: (error: unknown) => void
}

type Entry = {
  readonly watch: ConversationWatch
  /** 已经发到第几号。 */
  seq: number
  /** 已停：`close()` 之后迟到的回调直接丢掉。 */
  stopped: boolean
}

/** `open()` 的返回值：当前副本 + 起始帧号。 */
export type OpenedFrame = OpenedView

/** 一个会话一条通知流。 */
export class FrameHub {
  readonly #harness: Harness
  /** 所有接收方。 */
  readonly #sinks = new Set<FrameSink>()
  /** 会话 id → 它的帧号与监听句柄。 */
  readonly #entries = new Map<ConversationId, Entry>()
  readonly #onError: ((error: unknown) => void) | undefined

  constructor(harness: Harness, options: FrameHubOptions = {}) {
    this.#harness = harness
    this.#onError = options.onError
  }

  /** 注册接收方，返回取消订阅的函数。 */
  addSink(sink: FrameSink): () => void {
    this.#sinks.add(sink)
    return () => {
      this.#sinks.delete(sink)
    }
  }

  /**
   * 开始盯一个会话，返回当前副本和起始帧号。
   *
   * 不补发历史：历史已经在副本里。
   * 同一会话重复调用不会建第二个监听，直接给当前状态。
   *
   * 顺序要紧：先取 `watch.value`，再 `start()` 装监听——
   * 同一个变化才不会既算进副本、又被当成一帧推一遍。
   */
  async open(
    conversationId: ConversationId,
    context: Context,
  ): Promise<OpenedFrame> {
    const existing = this.#entries.get(conversationId)
    if (existing !== undefined) {
      return {
        convId: conversationId,
        snapshot: materializeView(existing.watch.value),
        seq: existing.seq,
      }
    }

    const conversation = await this.#harness.conversation(conversationId, context)
    if (conversation === undefined) {
      throw new UserError(`会话不存在：${String(conversationId)}`)
    }

    const watch = await conversation.watch(context)
    const entry: Entry = { watch, seq: 0, stopped: false }
    this.#entries.set(conversationId, entry)

    // 先取值再装监听：start() 不会当场回调，历史就不会被重推一遍
    const opened: OpenedFrame = {
      convId: conversationId,
      snapshot: materializeView(watch.value),
      seq: entry.seq,
    }

    watch.start(async (_value, ops) => {
      if (entry.stopped) return
      entry.seq += 1
      this.#publish({ convId: conversationId, seq: entry.seq, ops })
    })

    return opened
  }

  /** 不再盯这个会话：之后的帧不再发；没盯过就直接返回。 */
  async close(conversationId: ConversationId): Promise<void> {
    const entry = this.#entries.get(conversationId)
    if (entry === undefined) return
    this.#entries.delete(conversationId)
    entry.stopped = true
    await entry.watch.stop()
  }

  /** 全部停掉，退出前调一次。 */
  async closeAll(): Promise<void> {
    const ids = [...this.#entries.keys()]
    await Promise.all(ids.map(async (id) => await this.close(id)))
  }

  /** 每个会话已发到第几号，重连时用来比对有没有漏帧。 */
  cursors(): ReadonlyMap<ConversationId, number> {
    return new Map([...this.#entries].map(([id, entry]) => [id, entry.seq] as const))
  }

  /** 发给所有接收方；某个抛错就交给 onError，然后继续发下一个。 */
  #publish(frame: ViewFrame): void {
    for (const sink of this.#sinks) {
      try {
        sink(frame)
      } catch (error) {
        this.#onError?.(error)
      }
    }
  }
}
