/**
 * 输入框：Enter 发送，Shift+Enter 换行
 *
 * 发送后不清空本地「乐观消息」——界面不插入任何未提交的内容，
 * 用户消息出现在列表里，是因为它已经作为条目写进库并随帧推回来。
 */
import { useState } from "react"

import { Icon } from "./Icon.tsx"

export type ComposerProps = {
  readonly disabled: boolean
  readonly running: boolean
  readonly onSend: (text: string) => void
  readonly onAbort: () => void
}

// 消息编辑与发送
export function Composer({ disabled, running, onSend, onAbort }: ComposerProps) {
  // 消息草稿
  const [draft, setDraft] = useState("")

  const send = (): void => {
    const text = draft.trim()
    if (text === "" || disabled) return
    setDraft("")
    onSend(text)
  }

  return (
    <div className="shrink-0 px-6 pt-3 pb-5">
      <div className="mx-auto max-w-[760px]">
        <div className="flex items-end gap-2 rounded-2xl border border-control-border bg-surface p-3 shadow-input transition-[border-color,box-shadow] duration-150 focus-within:border-accent/50 focus-within:ring-3 focus-within:ring-accent/10">
          <textarea
            aria-label="消息输入"
            className="max-h-40 min-h-12 min-w-0 flex-1 resize-y bg-transparent px-1 py-2 text-[14px] leading-6 text-primary outline-none placeholder:text-tertiary"
            placeholder={disabled ? "先选一个会话…" : "说点什么…"}
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
          <div className="flex shrink-0 items-center gap-1.5 pb-1">
            <button className="flex h-8 items-center gap-1.5 rounded-lg border border-control-border bg-subtle/60 px-2.5 text-[12px] font-medium text-secondary hover:bg-subtle active:bg-hover" disabled={!running} onClick={onAbort} title="中断当前回答（等 pi.live.run 消失后生效）">
              <Icon name="stop" className="size-3" />停止
            </button>
            <button className="flex h-8 items-center gap-1 rounded-lg bg-accent px-3 text-[12px] font-medium text-white shadow-control hover:bg-accent-hover active:bg-accent-active" disabled={disabled || draft.trim() === ""} onClick={send}>
              发送<Icon name="arrow-up" className="size-3.5" />
            </button>
          </div>
        </div>
        <p className="mt-2.5 text-center text-[11px] text-tertiary">Enter 发送 · Shift+Enter 换行</p>
      </div>
    </div>
  )
}
