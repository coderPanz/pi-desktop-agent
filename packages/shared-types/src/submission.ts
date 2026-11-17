import type { ConversationId, EntryId, ViewSnapshot } from "./frame.ts"

/** 已提交的用户输入状态，不传原始输入或任意错误对象。终态在 run 结束后仍可读取。 */
export type InputSubmissionView = {
  readonly id: number
  readonly conversationId: ConversationId
  readonly entryId?: EntryId
} & (
  | { readonly status: "queued" | "placed" | "done" }
  | { readonly status: "unanswered"; readonly reason: string; readonly message: string }
)

/** 初次读取可能迟于推送回来：旧提交或旧状态不能覆盖新状态。 */
export function mergeSubmissionView(
  current: InputSubmissionView | undefined,
  incoming: InputSubmissionView | undefined,
): InputSubmissionView | undefined {
  if (incoming === undefined) return current
  if (current === undefined || incoming.conversationId !== current.conversationId) return incoming
  // 后续排队输入尚未开始，不能遮住当前轮次的终态；下个输入 placed 后才切换展示。
  if (incoming.status === "queued" && current.status !== "queued") return current
  if (current.status === "queued" && incoming.status !== "queued") return incoming
  if (incoming.id < current.id) return current
  if (incoming.id > current.id) return incoming
  if (current.status === "done" || current.status === "unanswered") return current
  return incoming
}

/** 在多个可能乱序到达的提交状态中，选出当前界面应该保留并展示的那一条状态 */
export function submissionFailure(
  submission: InputSubmissionView | undefined,
  snapshot: ViewSnapshot | undefined,
): string | undefined {
  if (submission?.status !== "unanswered" || snapshot === undefined) return undefined
  if (submission.conversationId !== snapshot.conversation.id) return undefined
  if (submission.reason === "aborted" || submission.reason === "reset") return undefined
  if (submission.entryId !== undefined && !snapshot.entries.some(entry => entry.id === submission.entryId)) {
    return undefined
  }
  return submission.message
}
