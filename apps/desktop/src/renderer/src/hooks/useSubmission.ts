import { useEffect, useState } from "react"
// 新消息来了，跟旧状态比一下谁更该显示在同一个会话里，当前这轮的状态比"排队中"重要， 新的提交比旧的提交重要，已经失败/完成的结果不能被后来的旧消息盖掉；不该换的时候就把原来那个对象原样返回。
import { mergeSubmissionView } from "@pi/shared-types"
import type { ConversationId, InputSubmissionView } from "@pi/shared-types"

import { invoke, subscribe } from "../ipc.ts"

// 最终提交的指令的完成状态，指令生命周期监控
export function useSubmission(conversationId: ConversationId | undefined): InputSubmissionView | undefined {
  // 初始化指令的提交状态
  const [submission, setSubmission] = useState<InputSubmissionView | undefined>(undefined)

  useEffect(() => {
    setSubmission(undefined)
    if (conversationId === undefined) return
    let active = true
    const accept = (incoming: InputSubmissionView | undefined): void => {
      if (
        !active ||
        (incoming !== undefined && incoming.conversationId !== conversationId)
      )
        return
      setSubmission(current => mergeSubmissionView(current, incoming))
    }
    // 渲染进程程序订阅 submission 
    // 新建订阅在触发提交
    const stop = subscribe("submission", accept)
    void invoke("conv.submission", { conversationId })
      .then(accept)
      .catch(() => {})
    return () => {
      active = false
      stop()
    }
  }, [conversationId]) // 会话 id 更新后重新追踪指令提交状态

  return submission?.conversationId === conversationId ? submission : undefined
}
