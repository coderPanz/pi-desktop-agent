/**
 * 把会话的变化打印到终端
 *
 * 两条规矩：
 *   1. 正在生成的回答优先显示，落盘后换成最终那条，两份不同时显示；
 *   2. 只往后补新字符，不整段重画，否则流式会重复、倒退。
 */
import {
  applyFrame,
  entryText,
  EntryKind,
  lastAssistantEntry,
  liveGenerationText,
  liveIsRunning,
  liveTools,
} from "@pi/shared-types"
import type { JsonObject, OpenedView, ViewEntry, ViewFrame, ViewSnapshot } from "@pi/shared-types"

/** 往哪写：终端用 stdout，测试里塞进数组。 */
export type Writable = {
  write(chunk: string): void
}

export type ConversationRendererOptions = {
  readonly out: Writable
  /** 打印每帧的编号和改动条数，查丢帧用。 */
  readonly traceFrames?: boolean
}

/** 一个会话一个实例；切会话就换新的，帧号和已打文本都不沿用。 */
export class ConversationRenderer {
  readonly #out: Writable
  readonly #traceFrames: boolean
  #snapshot: ViewSnapshot | undefined
  #seq = 0
  #frames = 0
  /** 已经打出来的回答，下一帧只补它后面的部分。 */
  #printed = ""
  /** 上次打过的回答条目 id，防止同一条打两遍。 */
  #lastAssistantId: number | undefined
  /** 已经处理过的条目 id。 */
  readonly #seen = new Set<number>()
  /** 每个工具调用上次显示的状态。 */
  readonly #tools = new Map<string, string>()

  constructor(options: ConversationRendererOptions) {
    this.#out = options.out
    this.#traceFrames = options.traceFrames ?? false
  }

  /** 当前帧号。 */
  get seq(): number {
    return this.#seq
  }

  /** 收到过多少帧。 */
  get frames(): number {
    return this.#frames
  }

  /** 已经打出来的回答文本。 */
  get text(): string {
    return this.#printed
  }

  /** 打开会话：打出历史条数和最后一条回答。 */
  open(opened: OpenedView): void {
    this.#snapshot = opened.snapshot
    this.#seq = opened.seq
    for (const entry of opened.snapshot.entries) this.#seen.add(entry.id)

    this.#out.write(
      `── 会话 #${String(opened.convId)} · ${String(opened.snapshot.entries.length)} 条历史 ──\n`,
    )

    const last = lastAssistantEntry(opened.snapshot.entries)
    if (last === undefined) return
    this.#lastAssistantId = last.id
    const text = entryText(last)
    if (text === "") return
    this.#out.write(`${text}\n`)
    this.#printed = text
  }

  /** 收到一帧：更新本地副本，再打印新增内容。 */
  apply(frame: ViewFrame): void {
    this.#frames += 1
    if (this.#snapshot !== undefined) this.#snapshot = applyFrame(this.#snapshot, frame.ops)
    this.#seq = frame.seq

    if (this.#traceFrames) {
      this.#out.write(`[frame ${String(frame.seq)}] ops=${String(frame.ops.length)}\n`)
    }

    const snapshot = this.#snapshot
    if (snapshot === undefined) return

    this.#renderNewEntries(snapshot)
    this.#renderTools(snapshot)
    this.#renderAssistant(snapshot)
  }

  /** 打印新出现的条目：用户输入、重置、压缩、工具报错。回答交给 #renderAssistant。 */
  #renderNewEntries(snapshot: ViewSnapshot): void {
    for (const entry of snapshot.entries) {
      if (this.#seen.has(entry.id)) continue
      this.#seen.add(entry.id)

      if (entry.kind === EntryKind.user) {
        this.#out.write(`\n› ${entryText(entry)}\n`)
        // 新一轮开始，回答要从头打，不能接着上一轮续写
        this.#printed = ""
        continue
      }
      if (entry.kind === EntryKind.reset) {
        const handoff = entryText(entry)
        this.#out.write(`\n── 上下文已重置${handoff === "" ? "" : `：${handoff}`} ──\n`)
        this.#printed = ""
        continue
      }
      if (entry.kind === EntryKind.compaction) {
        this.#out.write("\n── 上下文已压缩 ──\n")
        continue
      }
      if (entry.kind === EntryKind.toolResult) {
        // 状态行已经打过了，结果正文太长，只在出错时提一句
        if (toolResultIsError(entry)) this.#out.write("\n[tool] 返回错误（详见会话记录）\n")
        continue
      }
      if (entry.kind === EntryKind.assistant || entry.kind === EntryKind.system) continue

      this.#out.write(`\n[${entry.kind}]\n`)
    }
  }

  /** 工具状态一变就打一行，同一个状态不重复打。 */
  #renderTools(snapshot: ViewSnapshot): void {
    for (const slot of liveTools(snapshot)) {
      const callId = slot["callId"] // 工具调用 ID
      const name = slot["name"] // 工具名称
      const status = slot["status"] // 工具状态
      if (typeof callId !== "string" || typeof name !== "string" || typeof status !== "string") continue
      if (this.#tools.get(callId) === status) continue
      this.#tools.set(callId, status) // 工具状态缓存，避免重复打印
      this.#out.write(`\n[tool] ${name} ${status}\n`)
    }
  }

  /**
   * 打回答：正在生成的优先，落盘后换成最终那条。
   * 注意：正在生成但还没文字时先不动，否则会把上一条回答重打一遍。
   */
  #renderAssistant(snapshot: ViewSnapshot): void {
    const streaming = liveGenerationText(snapshot)
    if (streaming !== undefined) {
      this.#emit(streaming)
      return
    }
    if (liveIsRunning(snapshot)) return

    const last = lastAssistantEntry(snapshot.entries)
    if (last === undefined || last.id === this.#lastAssistantId) return
    const text = entryText(last)
    if (text === "") return
    this.#lastAssistantId = last.id
    this.#emit(text)
  }

  /** 往后补新字符；不是在上一版基础上追加的，就换行重打。 */
  #emit(text: string): void {
    if (text === this.#printed) return
    if (this.#printed !== "" && text.startsWith(this.#printed)) {
      this.#out.write(text.slice(this.#printed.length))
    } else {
      if (this.#printed !== "") this.#out.write("\n")
      this.#out.write(text)
    }
    this.#printed = text
  }
}

function toolResultIsError(entry: ViewEntry): boolean {
  const first = entry.model?.[0]
  return isObject(first) && first["isError"] === true
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
