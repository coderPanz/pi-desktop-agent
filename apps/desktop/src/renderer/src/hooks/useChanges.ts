/** 本轮改动：统计来自主进程（git 现算），diff 点开某个文件才拉。 */
import { useCallback, useEffect, useState } from "react"
import type { ChangeSummaryView, ConversationId } from "@pi/shared-types"

import { invoke } from "../ipc.ts"

export type ChangesHandle = {
  readonly summary: ChangeSummaryView | undefined
  /** 拉单个文件的 patch；返回 undefined 表示拿不到（无基线/非 git）。 */
  readonly loadDiff: (path: string) => Promise<string | undefined>
}

/** `revision` 变化时重取统计：一轮结束后条目数会变，据此刷新。 */
export function useChanges(conversationId: ConversationId | undefined, revision: number): ChangesHandle {
  const [summary, setSummary] = useState<ChangeSummaryView | undefined>(undefined)

  useEffect(() => {
    setSummary(undefined)
    if (conversationId === undefined) return
    let active = true
    void invoke("changes.get", { conversationId })
      .then(value => { if (active) setSummary(value) })
      .catch(() => {})
    return () => { active = false }
  }, [conversationId, revision])

  const loadDiff = useCallback(async (path: string) => {
    if (conversationId === undefined) return undefined
    try {
      const result = await invoke("changes.diff", { conversationId, path })
      return result.patch
    } catch {
      return undefined
    }
  }, [conversationId])

  return { summary, loadDiff }
}
