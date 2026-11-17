/**
 * 从副本里读界面要用的数据
 *
 * `snapshot.docs` 是主进程传来的 JSON，一律当不可信数据：每个字段先判断类型再用
 * 文档 kind 定义在 `@pi/shared-types` 的 `DocKind`；这里只做「读到能用的形状」这一步
 */
import { DocKind } from "@pi/shared-types"
import type { JsonObject, ViewSnapshot } from "@pi/shared-types"

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function doc(snapshot: ViewSnapshot, kind: string): JsonObject | undefined {
  const value = snapshot.docs[kind]
  return isObject(value) ? value : undefined
}

/** 从消息内容里取纯文本：可能是字符串，也可能是 `[{type:"text",text}]`。 */
function contentText(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    return value.map((part) => contentText(part)).join("")
  }
  if (isObject(value)) {
    const text = value["text"]
    return typeof text === "string" ? text : ""
  }
  return ""
}

/** 排队中的一条输入。 */
export type QueuedItem = {
  readonly id: number
  readonly mode: "steer" | "followUp" | "write"
  readonly text: string
}

/** `pi.inbox`：等着进上下文的提交。`write` 类型是纯记录，不显示文本。 */
export function queuedItems(snapshot: ViewSnapshot): readonly QueuedItem[] {
  const inbox = doc(snapshot, DocKind.inbox)
  const items = inbox?.["items"]
  if (!Array.isArray(items)) return []

  const queued: QueuedItem[] = []
  for (const item of items) {
    if (!isObject(item)) continue
    const id = item["id"]
    const mode = item["mode"]
    if (typeof id !== "number") continue
    if (mode !== "steer" && mode !== "followUp" && mode !== "write") continue
    queued.push({ id, mode, text: mode === "write" ? "" : contentText(item["content"]) })
  }
  return queued
}

/** 一个工具调用在界面上需要的信息。 */
export type ToolSlot = {
  readonly callId: string
  readonly name: string
  readonly status: "pending" | "running" | "done"
  readonly output: string | undefined
  readonly isError: boolean
  readonly entryId: number | undefined
  readonly droppedBytes: number | undefined
  readonly droppedLines: number | undefined
  readonly nested: readonly ToolSlot[]
}

function slotOf(value: unknown): ToolSlot | undefined {
  if (!isObject(value)) return undefined
  const callId = value["callId"]
  const name = value["name"]
  const status = value["status"]
  if (typeof callId !== "string" || typeof name !== "string") return undefined
  if (status !== "pending" && status !== "running" && status !== "done") return undefined

  const output = value["output"]
  const entryId = value["entryId"] ?? value["entry"]
  const droppedBytes = value["droppedBytes"]
  const droppedLines = value["droppedLines"]
  const isError = value["isError"]

  return {
    callId,
    name,
    status,
    output: typeof output === "string" ? output : undefined,
    isError: isError === true,
    entryId: typeof entryId === "number" ? entryId : undefined,
    droppedBytes: typeof droppedBytes === "number" ? droppedBytes : undefined,
    droppedLines: typeof droppedLines === "number" ? droppedLines : undefined,
    nested: nestedSlotsOf(value["nested"]),
  }
}

function nestedSlotsOf(value: unknown): readonly ToolSlot[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const slot = slotOf(item)
    return slot === undefined ? [] : [slot]
  })
}

/** `pi.live.tools`：本轮的工具调用，按调用顺序。 */
export function toolSlots(snapshot: ViewSnapshot): readonly ToolSlot[] {
  const live = doc(snapshot, DocKind.live)
  const tools = live?.["tools"]
  if (!Array.isArray(tools)) return []
  return tools.flatMap((item) => {
    const slot = slotOf(item)
    return slot === undefined ? [] : [slot]
  })
}

/** 一次生成失败。`pi.live.generation.retry` 是 harness 记下的退避错误。 */
export type GenerationFailure = {
  readonly message: string
  /** 下次重试的时间（毫秒时间戳）；没有就是不再自动重试。 */
  readonly retryAt: number | undefined
}

/** 当前这轮生成是否停在错误上（有 `retry.error` 就是）。 */
export function generationFailure(snapshot: ViewSnapshot): GenerationFailure | undefined {
  const live = doc(snapshot, DocKind.live)
  const generation = live?.["generation"]
  if (!isObject(generation)) return undefined
  const retry = generation["retry"]
  if (!isObject(retry)) return undefined
  const message = retry["error"]
  if (typeof message !== "string" || message === "") return undefined
  const at = retry["at"]
  return { message, retryAt: typeof at === "number" ? at : undefined }
}

/** 最近一次压缩失败（压缩任务结束后仍会留着，直到出现新的摘要）。 */
export function compactionFailure(snapshot: ViewSnapshot): string | undefined {
  const live = doc(snapshot, DocKind.live)
  const failure = live?.["compactionFailure"]
  if (!isObject(failure)) return undefined
  const message = failure["error"]
  return typeof message === "string" && message !== "" ? message : undefined
}

/** 是否在跑（`pi.live.run` 存在即忙），与 `liveIsRunning` 同义，这里给不 import helper 的调用方用。 */
export function isRunning(snapshot: ViewSnapshot): boolean {
  const live = doc(snapshot, DocKind.live)
  return live !== undefined && isObject(live["run"])
}
