/**
 * 帧协议：主进程与渲染进程之间**唯一**的状态同步方式
 * frame.ts 定义**「界面手里那份会话数据长什么样，以及主进程怎么把变化告诉它」**——界面和主进程必须对同一份数据用同一套说法。
 * 解决了：界面（渲染进程）不允许直接读数据库、也不允许 import pi-durable（那是主进程的东西）。所以界面手里只有一份"复制品"：
 */
import { applyImmutable } from "@earendil-works/chord/delta"
import type { Op } from "@earendil-works/chord/delta"

import type { JsonObject, JsonValue } from "./json.ts"

export type { Op } from "@earendil-works/chord/delta"
export { applyImmutable, isBase } from "@earendil-works/chord/delta"

/** 会话 id / 条目 id / 任务 id 在线上都是普通数字（brand 只在 SDK 内部有意义）。 */
export type ConversationId = number
export type EntryId = number
export type TaskId = number

/**
 * 内置条目 kind。这些字符串一旦落盘就是契约，改它等于让旧会话读不出来。
 */
export const EntryKind = {
  user: "pi.user",
  assistant: "pi.assistant",
  system: "pi.system",
  toolResult: "pi.tool-result", // 工具调用结果
  reset: "pi.reset", // 已完成会话重置
  compaction: "pi.compaction", // 已完成压缩
} as const

/**
 * 内置文档 kind。同上：落盘即契约。
 */
export const DocKind = {
  /** 运行控制与当前生成/工具轮的展示状态。 */
  live: "pi.live",
  /** 等待边界处理的提交队列。 */
  inbox: "pi.inbox",
} as const

/** 一条可见条目。`model` 是消息数组（结构由模型协议决定，渲染层按需守卫）。 */
export type ViewEntry = {
  readonly id: EntryId
  readonly conversationId: ConversationId
  readonly kind: string
  readonly model?: readonly JsonValue[]
  readonly data?: JsonValue
  readonly head?: EntryId
  readonly byTaskId?: TaskId
}

/** 一个会话的结构。`docs` 只放已提交的文档值。 */
export type ViewConversation = {
  readonly id: ConversationId
  /** 分叉来源：从哪个会话的哪条条目继承历史。 */
  readonly parent?: {
    readonly conversationId: ConversationId
    readonly at: EntryId
  }
  readonly owner?: {
    readonly conversationId: ConversationId
    readonly taskId: TaskId
  }
}

/** 渲染进程持有的那份只读副本。 */
export type ViewSnapshot = {
  readonly conversation: ViewConversation
  /** 生效条目，按 id 升序。 */
  readonly entries: readonly ViewEntry[]
  /** 内置文档，按 kind 索引；没创建的文档就是不存在。 */
  readonly docs: Readonly<Record<string, JsonObject>>
}

/** 一帧：哪个会话、第几号、变了什么。 */
export type ViewFrame = {
  readonly convId: ConversationId
  readonly seq: number
  readonly ops: readonly Op[]
}

/** `open()` 的返回值：起点副本 + 起始编号。 */
export type OpenedView = {
  readonly convId: ConversationId
  readonly seq: number
  readonly snapshot: ViewSnapshot
}

/** 把一帧叠加到副本上。不修改入参，返回新对象。 */
export function applyFrame(snapshot: ViewSnapshot, ops: readonly Op[]): ViewSnapshot {
  return applyImmutable(snapshot, ops)
}

/** 从实时状态取「正在生成的回答」文本；还没产出文本时返回 undefined。 */
export function liveGenerationText(snapshot: ViewSnapshot): string | undefined {
  const live = snapshot.docs[DocKind.live]
  if (live === undefined) return undefined
  const generation = live["generation"]
  const message = isObject(generation) ? generation["message"] : undefined
  const text = messageContentText(message)
  return text === "" ? undefined : text
}

/** 是否在跑：`pi.live.run` 存在即忙 */
export function liveIsRunning(snapshot: ViewSnapshot): boolean {
  const live = snapshot.docs[DocKind.live]
  return live !== undefined && isObject(live["run"])
}

/** 列出：本轮工具调用 */
export function liveTools(snapshot: ViewSnapshot): readonly JsonObject[] {
  const live = snapshot.docs[DocKind.live]
  const tools = live === undefined ? undefined : live["tools"]
  if (!Array.isArray(tools)) return []
  return tools.filter((slot): slot is JsonObject => isObject(slot))
}

/** 最后一轮回答条目 */
export function lastAssistantEntry(entries: readonly ViewEntry[]): ViewEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry !== undefined && entry.kind === EntryKind.assistant) return entry
  }
  return undefined
}

/** 
 * 条目里的纯文本：`model` 的每条消息里只取 text 块。
 * 作用：提取文本内容，用于展示
 */
export function entryText(entry: ViewEntry): string {
  const model = entry.model
  if (model === undefined) return ""
  const parts: string[] = []
  for (const message of model) {
    const text = messageContentText(message)
    if (text !== "") parts.push(text)
  }
  return parts.join("")
}

/** 从一条消息里取文本。用结构判断而不是类型断言：数据来自磁盘，坏数据不能炸界面。 */
export function messageContentText(message: unknown): string {
  if (!isObject(message)) return ""
  const content = message["content"]
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block)
      continue
    }
    if (!isObject(block)) continue
    if (block["type"] === "text" && typeof block["text"] === "string") parts.push(block["text"])
  }
  return parts.join("")
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
