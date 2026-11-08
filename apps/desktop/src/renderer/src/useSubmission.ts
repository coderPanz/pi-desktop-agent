import { useEffect, useState } from "react"

import { mergeSubmissionView } from "@pi/shared-types"
import type { ConversationId, InputSubmissionView } from "@pi/shared-types"

import { invoke, subscribe } from "./ipc.ts"

/** 初次读取恢复已有结算结果，之后只消费已提交记录的推送；不在发送回调里伪造成功/失败。 */
export function useSubmission(conversationId: ConversationId | undefined): InputSubmissionView | undefined {
  const [submission, setSubmission] = useState<InputSubmissionView | undefined>(undefined)

  useEffect(() => {
    setSubmission(undefined)
    if (conversationId === undefined) return
    let active = true
    const accept = (incoming: InputSubmissionView | undefined): void => {
      if (!active || (incoming !== undefined && incoming.conversationId !== conversationId)) return
      setSubmission(current => mergeSubmissionView(current, incoming))
    }
    // 先订阅再读取，合并时防止迟到的读取结果覆盖更晚的提交或终态。
    const stop = subscribe("submission", accept)
    void invoke("conv.submission", { conversationId }).then(accept).catch(() => {})
    return () => {
      active = false
      stop()
    }
  }, [conversationId])

  // effect 尚未清理旧 state 的那次渲染，也不能把上一会话的错误画出来。
  return submission?.conversationId === conversationId ? submission : undefined
}
