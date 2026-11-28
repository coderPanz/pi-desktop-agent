/** 本轮改动：统计来自主进程（git 现算），diff 点开某个文件才拉。 */
import { useCallback, useEffect, useState } from "react"
import type { ChangeSummaryView, ConversationId } from "@pi/shared-types"

import { invoke } from "../ipc.ts"

export type ChangesHandle = {
  readonly summary: (ChangeSummaryView & { readonly rounds?: number }) | undefined
  /** 当前看的是第几轮基线：0 = 本轮。 */
  readonly round: number
  readonly setRound: (round: number) => void
  /** 可选基线轮数。 */
  readonly rounds: number
  /** 拉单个文件的 patch；返回 undefined 表示拿不到（无基线/非 git）。 */
  readonly loadDiff: (path: string) => Promise<string | undefined>
}

/** `revision` 变化时重取统计：一轮结束后条目数会变，据此刷新。 */
export function useChanges(conversationId: ConversationId | undefined, revision: number): ChangesHandle {
  const [summary, setSummary] = useState<(ChangeSummaryView & { readonly rounds?: number }) | undefined>(undefined)
  const [round, setRoundState] = useState(0)

  // 换会话回到「本轮」
  useEffect(() => { setRoundState(0) }, [conversationId])

  useEffect(() => {
    setSummary(undefined)
    if (conversationId === undefined) return
    let active = true
    void invoke("changes.get", { conversationId, round })
      .then(value => { if (active) setSummary(value) })
      .catch(() => {})
    return () => { active = false }
  }, [conversationId, revision, round])

  const setRound = useCallback((next: number) => { setRoundState(Math.max(0, next)) }, [])

  const loadDiff = useCallback(async (path: string) => {
    if (conversationId === undefined) return undefined
    try {
      const result = await invoke("changes.diff", { conversationId, path, round })
      return result.patch
    } catch {
      return undefined
    }
  }, [conversationId, round])

  return { summary, round, setRound, rounds: summary?.rounds ?? 1, loadDiff }
}
