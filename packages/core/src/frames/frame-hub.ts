/**
 * 会话变更通知中心
 *
 * 用法三步：
 *   1. `addSink(fn)` 注册接收方
 *   2. `open(会话 id)` 开始监听，拿到当前副本和起始帧号；
 *   3.  之后每次变化，每个接收方都会收到一帧 `{ convId, seq, ops }`。
 */
import type { Context } from "@earendil-works/chord"

import { UserError } from "../errors.ts"
import type { ConversationId, ConversationWatch, Harness } from "@earendil-works/pi-durable"
import type { OpenedView, ViewFrame } from "@pi/shared-types"

import { materializeView } from "../harness/materialize.ts"

export type { ViewFrame }

/** 接收方：收到一帧就调一次 */
export type FrameSink = (frame: ViewFrame) => void

export type FrameHubOptions = {
  /** 接收方报错时在这儿处理 */
  readonly onError?: (error: unknown) => void
}

// 会话帧类型
type Entry = {
  readonly watch: ConversationWatch // 这个会话的变化从哪来
  seq: number // 已经发到第几号
  stopped: boolean // 是否已停止监听
}

export type OpenedFrame = OpenedView // 当前副本 + 起始帧号

/** 会话变更通知中心 class */
export class FrameHub {
  readonly #harness: Harness
  /** 所有接收方，每次发帧时挨个调一遍里面的 fn */
  readonly #sinks = new Set<FrameSink>()
  /** 当前正在监听的所有会话， 会话变更后把 seq + 1，把 {convId, seq, ops} 同步分发给 #sinks 里的每个函数 */
  readonly #entries = new Map<ConversationId, Entry>()
  /** FrameHub 的错误上报出口：某个 sink 抛异常时，FrameHub 自己既不打印也不抛出，而是把错误交给这个回调 */
  readonly #onError: ((error: unknown) => void) | undefined

  constructor(harness: Harness, options: FrameHubOptions = {}) {
    this.#harness = harness
    this.#onError = options.onError
  }

  /**
   * 注册接收方
   * 返回值为：取消注册方订阅的函数
   * 意思是我能注册你，也能注销你
  */
  addSink(sink: FrameSink): () => void {
    this.#sinks.add(sink)
    return () => {
      this.#sinks.delete(sink)
    }
  }

  /**
   * 开始监听一个会话
   * 返回值为：当前会话id-副本-起始帧号
  */
  async open(
    conversationId: ConversationId,
    context: Context,
  ): Promise<OpenedFrame> {
    const existing = this.#entries.get(conversationId)
    if (existing !== undefined) {
      return {
        convId: conversationId,
        snapshot: materializeView(existing.watch.value), // 当前会话处理过的副本
        seq: existing.seq,
      }
    }

    // 没有监听过则开启监听

    // 获取会话
    const conversation = await this.#harness.conversation(
      conversationId,
      context,
    )
    if (conversation === undefined) throw new UserError(`会话不存在：${String(conversationId)}`)
    
    // 开启监听流程
    const watch = await conversation.watch(context)
    // 初始化监听配置
    const entry: Entry = { watch, seq: 0, stopped: false }

    // 记录监听会话
    this.#entries.set(conversationId, entry)

    // 构建当前的opened帧
    const opened: OpenedFrame = {
      convId: conversationId,
      snapshot: materializeView(watch.value),
      seq: entry.seq,
    }

    // 开始监听会话变更
    watch.start(async (_value, ops) => {
      if (entry.stopped) return
      // 会话变更后，seq + 1
      entry.seq += 1
      // 分发变更给所有接收方
      this.#publish({ convId: conversationId, seq: entry.seq, ops })
    })

    return opened
  }

  /** 取消监听会话的变更 */
  async close(conversationId: ConversationId): Promise<void> {
    const entry = this.#entries.get(conversationId)
    if (entry === undefined) return
    this.#entries.delete(conversationId)
    entry.stopped = true
    await entry.watch.stop()
  }

  /** 取消监听所有会话更新 */
  async closeAll(): Promise<void> {
    const ids = [...this.#entries.keys()]
    await Promise.all(ids.map(async id => await this.close(id)))
  }

  /** 每个会话已发到第几号，重连时用来比对有没有漏帧 */
  cursors(): ReadonlyMap<ConversationId, number> {
    return new Map(
      [...this.#entries].map(([id, entry]) => [id, entry.seq] as const),
    )
  }

  /** 发给所有接收方；某个抛错就交给 onError，然后继续发下一个。 */
  #publish(frame: ViewFrame): void {
    for (const sink of this.#sinks) {
      try {
        // 接收方调用用变更
        sink(frame)
      } catch (error) {
        this.#onError?.(error)
      }
    }
  }
}
