/**
 * 输入框：Enter 发送，Shift+Enter 换行。
 *
 * 发送后不清空本地「乐观消息」——界面不插入任何未提交的内容，
 * 用户消息出现在列表里，是因为它已经作为条目写进库并随帧推回来。
 */
import { useState } from "react"

export type ComposerProps = {
  readonly disabled: boolean
  readonly running: boolean
  readonly onSend: (text: string) => void
  readonly onAbort: () => void
}

export function Composer({ disabled, running, onSend, onAbort }: ComposerProps) {
  const [draft, setDraft] = useState("")

  const send = (): void => {
    const text = draft.trim()
    if (text === "" || disabled) return
    setDraft("")
    onSend(text)
  }

  return (
    <div className="flex items-end gap-2">
      <textarea
        className="max-h-40 min-h-[44px] flex-1 resize-y rounded border border-[#262b36] bg-[#12151c] px-3 py-2 text-[13px] text-[#e6e8ef] outline-none focus:border-[#3b82f6]"
        placeholder={disabled ? "先选一个会话…" : "说点什么…（Enter 发送，Shift+Enter 换行）"}
        rows={1}
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            send()
          }
        }}
      />
      <button
        className="rounded bg-[#1d4ed8] px-3 py-2 text-[13px] text-[#e0e7ff] disabled:opacity-40"
        disabled={disabled || draft.trim() === ""}
        onClick={send}
      >
        发送
      </button>
      <button
        className="rounded border border-[#262b36] px-3 py-2 text-[13px] text-[#9aa2b1] disabled:opacity-40"
        disabled={!running}
        onClick={onAbort}
        title="中断当前回答（等 pi.live.run 消失后生效）"
      >
        停止
      </button>
    </div>
  )
}
