/**
 * 消息列表只画已提交条目与 live 文本；最终回答与同内容的流式片段不重复显示。
 */
import { useEffect, useRef } from "react"

import { EntryKind, entryText, liveGenerationText } from "@pi/shared-types"
import type { ViewEntry, ViewSnapshot } from "@pi/shared-types"

import type { QueuedItem, ToolSlot } from "../docs.ts"
import { Icon } from "./Icon.tsx"
import { MessageRow } from "./MessageRow.tsx"
import { StreamingMarkdown } from "./StreamingMarkdown.tsx"
import { ToolCard } from "./ToolCard.tsx"

export type MessageListProps = {
  readonly snapshot: ViewSnapshot | undefined
  readonly running: boolean
  readonly tools: readonly ToolSlot[]
  readonly queued: readonly QueuedItem[]
}

// 已提交历史 + 实时生成 + 实时工具状态 + 排队输入统一组织成对话区 UI 的组件
export function MessageList({ snapshot, running, tools, queued }: MessageListProps) {
  const bottom = useRef<HTMLDivElement | null>(null)
  const entries = snapshot === undefined ? [] : visibleEntries(snapshot.entries)
  const liveText = snapshot === undefined ? undefined : liveGenerationText(snapshot)
  const lastAssistant = snapshot === undefined ? undefined : lastAssistantText(snapshot.entries)
  const streaming = running && liveText !== undefined && liveText !== lastAssistant
  const empty = entries.length === 0 && !running && tools.length === 0 && queued.length === 0

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" })
  }, [entries.length, liveText, tools.length, queued.length])

  return (
    <div aria-label="会话内容" className="min-h-0 flex-1 overflow-y-auto">
      <div className={`mx-auto w-full max-w-[760px] px-6 py-8 ${empty ? "flex min-h-full flex-col items-center justify-center" : "space-y-6"}`}>
        {empty ? (
          <div className="max-w-80 pb-8 text-center">
            <span className="mx-auto mb-5 flex size-14 items-center justify-center rounded-[18px] border border-divider bg-surface text-accent shadow-control"><Icon name="sparkles" className="size-7" /></span>
            <h2 className="text-[20px] font-semibold tracking-tight text-primary">开始一段对话</h2>
            <p className="mt-2.5 text-[13px] leading-6 text-secondary">{snapshot === undefined ? "正在准备工作区…" : "描述你的任务，Agent 将在本机工作区中协助你。"}</p>
          </div>
        ) : null}

        {entries.map((entry) => <MessageRow key={entry.id} entry={entry} />)}
        {tools.map((slot) => <ToolCard key={slot.callId} slot={slot} />)}

        {streaming ? (
          <div>
            <p className="mb-2.5 flex items-center gap-2 text-[12px] font-medium text-secondary"><Icon name="sparkles" className="size-3.5 text-accent" />正在生成</p>
            <StreamingMarkdown text={liveText} />
          </div>
        ) : null}
        {running && !streaming ? <p className="flex items-center gap-2 text-[12px] text-secondary"><Icon name="sparkles" className="size-3.5 text-accent" />生成中…</p> : null}

        {queued.length === 0 ? null : (
          <div className="rounded-xl border border-accent/10 bg-selection/35 px-4 py-3">
            <p className="mb-1.5 flex items-center gap-2 text-[12px] font-medium text-accent"><Icon name="message" className="size-3.5" />排队 {queued.length} 条（等当前这轮结束）</p>
            {queued.map((item) => (
              <p key={item.id} className="mt-1 truncate text-[12px] leading-5 text-secondary">{item.mode === "steer" ? "插话：" : ""}{item.text === "" ? "（记录）" : item.text}</p>
            ))}
          </div>
        )}
        <div ref={bottom} />
      </div>
    </div>
  )
}

function visibleEntries(entries: readonly ViewEntry[]): readonly ViewEntry[] {
  return entries.filter((entry) => {
    if (entry.kind === EntryKind.system) return false
    if (entry.kind === EntryKind.assistant) return entryText(entry).trim() !== ""
    return entry.kind === EntryKind.user || entry.kind === EntryKind.toolResult || entry.kind === EntryKind.reset || entry.kind === EntryKind.compaction
  })
}

function lastAssistantText(entries: readonly ViewEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry !== undefined && entry.kind === EntryKind.assistant) return entryText(entry)
  }
  return undefined
}
