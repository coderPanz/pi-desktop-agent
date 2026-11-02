/**
 * FrameHub：把「会话视图变了」这件事，变成一串带编号的通知，发给所有订阅者。
 *
 * 它就是一根管子：会话变化 → 取出变化内容（ops）→ 编个号（seq）→ 交给每个 sink 【接受方】
 *
 * 怎么用（三步）：
 *   1. `addSink(fn)` 注册收通知的人（Electron 主进程一般是 `webContents.send`）；
 *   2. `open(会话 id)` 开始盯一个会话，先拿到「当前完整视图 value」和「起始编号 seq」；
 *   3. 之后这个会话每变一次，每个 sink 都会收到一帧 `{ convId, seq, ops }`。
 *
 * 三条约定：
 *   - `open()` 不补发历史：历史已经在返回的 `value` 里，之后只推变化；
 *   - 每个会话各自一条 seq：从 0 开始，每帧 +1，切会话既不回退也不归零；
 *   - 发帧只是分发：慢的 sink 不拖住会话，也不拖住别的 sink（合并/丢弃由 sink 自己决定）。
 *
 * 这个文件里不含 Electron：主进程那边只负责把 sink 接到 `webContents.send` 上。
 * webContents.send 是 Electron 主进程往页面里发消息的唯一常用手段
 */
import type { Context } from "@earendil-works/chord"
import type { Op } from "@earendil-works/chord/delta"
import type { ConversationId, ConversationView, ConversationWatch, Harness } from "@earendil-works/pi-durable"

/**
 * 一帧通知：哪个会话、第几号、这次变了什么。
 * `ops` 是空数组时表示「结构没变」（例如只改了文档内容）。
 */
export type ViewFrame = {
  readonly convId: ConversationId
  readonly seq: number
  readonly ops: readonly Op[]
}

/** 
 * 接收方：收到一帧时被调用的函数。
 * 任何"能吃一帧、返回啥都行"的函数都算
*/
export type FrameSink = (frame: ViewFrame) => void

export type FrameHubOptions = {
  /** 某个 sink 抛错时交给它处理；不传就忽略这个错误，免得一个坏 sink 打断其他 sink。 */
  readonly onError?: (error: unknown) => void
}

type Entry = {
  readonly watch: ConversationWatch
  /** 这个会话已经发到第几号。 */
  seq: number
  /** 是否已停：`close()` 之后迟到的回调直接丢掉。 */
  stopped: boolean
}

/** `open()` 的返回值：一份当前完整视图 + 以后各帧的起始编号。 */
export type OpenedFrame = {
  readonly convId: ConversationId
  /** 当前完整视图：对方拿它当起点，之后收到的帧在它上面叠加。 */
  readonly value: ConversationView
  /** 起始编号：此后每收到一帧就在这个数上 +1。 */
  readonly seq: number
}

/** FrameHub：把「会话视图变了」这件事，变成一串带编号的通知，发给所有订阅者。 */
export class FrameHub {
  readonly #harness: Harness
  /** 所有接收方。 */
  readonly #sinks = new Set<FrameSink>()
  /** 正在盯的会话 → 它的编号与监听句柄。 */
  readonly #entries = new Map<ConversationId, Entry>()
  readonly #onError: ((error: unknown) => void) | undefined

  constructor(harness: Harness, options: FrameHubOptions = {}) {
    this.#harness = harness
    this.#onError = options.onError
  }

  /** 注册一个接收方，返回「注销」函数；调它就不再收到帧。 */
  addSink(sink: FrameSink): () => void {
    this.#sinks.add(sink)
    return () => {
      this.#sinks.delete(sink)
    }
  }

  /**
   * 开始盯一个会话。
   *
   * 返回当前完整视图和起始编号，**不补发历史**——历史已经在 `value` 里了。
   * 已经盯着的会话再调一次，直接给当前状态，不会建第二个监听。
   *
   * 这里的顺序很重要：先取 `watch.value` 当返回值，再调 `start()` 装监听。
   * `start()` 保证不会当场回调，所以同一个变化不会「既在 value 里、又当成一帧推一遍」。
   */
  async open(
    conversationId: ConversationId,
    context: Context,
  ): Promise<OpenedFrame> {
    const existing = this.#entries.get(conversationId)
    if (existing !== undefined) {
      return { convId: conversationId, value: existing.watch.value, seq: existing.seq }
    }

    const conversation = await this.#harness.conversation(conversationId, context)
    if (conversation === undefined) {
      throw new Error(`会话不存在：${String(conversationId)}`)
    }

    const watch = await conversation.watch(context)
    const entry: Entry = { watch, seq: 0, stopped: false }
    this.#entries.set(conversationId, entry)

    // 先记下 value 再 start：start 不会内联回调，也就不会重放历史。
    const opened: OpenedFrame = { convId: conversationId, value: watch.value, seq: entry.seq }

    watch.start(async (_value, ops) => {
      if (entry.stopped) return
      entry.seq += 1
      this.#publish({ convId: conversationId, seq: entry.seq, ops })
    })

    return opened
  }

  /** 不盯这个会话了：编号作废，之后的帧不再发；没盯过就直接返回。 */
  async close(conversationId: ConversationId): Promise<void> {
    const entry = this.#entries.get(conversationId)
    if (entry === undefined) return
    this.#entries.delete(conversationId)
    entry.stopped = true
    await entry.watch.stop()
  }

  /** 全部停掉，退出前调一次即可。 */
  async closeAll(): Promise<void> {
    const ids = [...this.#entries.keys()]
    await Promise.all(ids.map(async (id) => await this.close(id)))
  }

  /** 当前每个会话发到第几号，给重连/对账用（对方拿自己的编号来比对，就知道有没有漏帧）。 */
  cursors(): ReadonlyMap<ConversationId, number> {
    return new Map([...this.#entries].map(([id, entry]) => [id, entry.seq] as const))
  }

  /** 把一帧发给所有接收方；某个抛错就交给 onError，然后继续发下一个。 */
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
