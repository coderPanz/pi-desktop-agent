/**
 * 消息列表：已确定的条目 + 正在生成的那段文本。
 *
 * 「流式与最终结果不同显」的规则：
 *   - 只渲染已写进库的条目（`snapshot.entries`）；
 *   - 生成中的文本来自 `pi.live.generation.message`，只在**还在跑**时显示；
 *   - 如果这段文本已经和最后一条 assistant 条目逐字相同（刚提交完的瞬间），只显示条目那一条。
 *
 * 这样就不会出现「同一段回答先是流式、落库后又出现一遍」。
 */
import { useEffect, useRef } from "react"

import { EntryKind, entryText, liveGenerationText } from "@pi/shared-types"
import type { ViewEntry, ViewSnapshot } from "@pi/shared-types"

import type { QueuedItem, ToolSlot } from "../docs.ts"
import { MarkdownText } from "./Markdown.tsx"
import { ToolCard } from "./ToolCard.tsx"

export type MessageListProps = {
  readonly snapshot: ViewSnapshot | undefined
  readonly running: boolean
  readonly tools: readonly ToolSlot[]
  readonly queued: readonly QueuedItem[]
}

export function MessageList({ snapshot, running, tools, queued }: MessageListProps) {
  const bottom = useRef<HTMLDivElement | null>(null)
  const entries = snapshot === undefined ? [] : visibleEntries(snapshot.entries)
  const liveText = snapshot === undefined ? undefined : liveGenerationText(snapshot)
  const lastAssistant = snapshot === undefined ? undefined : lastAssistantText(snapshot.entries)

  // 正在生成的文本与最后一条已落库回答相同 → 只显示已落库那条，避免重复。
  const streaming = running && liveText !== undefined && liveText !== lastAssistant

  // 内容一变就滚到底：聊天界面滚到底比保住滚动位置更符合预期。
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" })
  }, [entries.length, liveText, tools.length, queued.length])

  return (
    <div className="min-h-[260px] space-y-3 overflow-y-auto rounded border border-[#262b36] bg-[#171a22] p-3">
      {entries.map((entry) => (
        <EntryRow key={entry.id} entry={entry} />
      ))}

      {tools.map((slot) => (
        <ToolCard key={slot.callId} slot={slot} />
      ))}

      {streaming ? (
        <div>
          <p className="text-[10px] tracking-widest text-[#4b5563] uppercase">正在生成</p>
          <MarkdownText text={liveText} />
        </div>
      ) : null}

      {running && !streaming ? <p className="text-[11px] text-[#4b5563]">生成中…</p> : null}

      {queued.length === 0 ? null : (
        <div className="rounded border border-[#1e3a5f] bg-[#0f172a] px-3 py-2">
          <p className="text-[10px] tracking-widest text-[#60a5fa] uppercase">
            排队 {queued.length} 条（等当前这轮结束）
          </p>
          {queued.map((item) => (
            <p key={item.id} className="mt-1 truncate text-[12px] text-[#9aa2b1]">
              {item.mode === "steer" ? "插话：" : ""}
              {item.text === "" ? "（记录）" : item.text}
            </p>
          ))}
        </div>
      )}

      <div ref={bottom} />
    </div>
  )
}

/**
 * 只挑界面要显示的条目。
 *
 * - 系统提示不显示：它记的是这一轮的 system prompt + 工具清单；
 * - 文本为空的 assistant 是「只带工具调用」的那一条，工具卡已经代表了它，不单独占一行。
 */
function visibleEntries(entries: readonly ViewEntry[]): readonly ViewEntry[] {
  return entries.filter((entry) => {
    if (entry.kind === EntryKind.system) return false
    if (entry.kind === EntryKind.assistant) return entryText(entry).trim() !== ""
    return (
      entry.kind === EntryKind.user ||
      entry.kind === EntryKind.toolResult ||
      entry.kind === EntryKind.reset ||
      entry.kind === EntryKind.compaction
    )
  })
}

/** 最后一条 assistant 的文本，用来判断流式文本是否已经在库里了。 */
function lastAssistantText(entries: readonly ViewEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry !== undefined && entry.kind === EntryKind.assistant) return entryText(entry)
  }
  return undefined
}

function EntryRow({ entry }: { readonly entry: ViewEntry }) {
  if (entry.kind === EntryKind.reset) {
    const handoff = entryText(entry)
    return (
      <p className="text-center text-[11px] text-[#4b5563]">
        ── 上下文已重置{handoff === "" ? "" : `：${handoff}`} ──
      </p>
    )
  }
  if (entry.kind === EntryKind.compaction) {
    return <p className="text-center text-[11px] text-[#4b5563]">── 上下文已压缩 ──</p>
  }

  // 工具结果：折叠成一行，展开看输出。本轮结束后 `pi.live.tools` 会被清空，
  // 这里是从会话记录里回看「工具到底做了什么」的唯一入口。
  if (entry.kind === EntryKind.toolResult) {
    const text = entryText(entry)
    return (
      <details className="rounded border border-[#1a1f28] bg-[#12151c] px-3 py-2">
        <summary className="cursor-pointer text-[11px] text-[#6b7280]">工具结果</summary>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-[#9aa2b1]">
          {text === "" ? "（没有输出）" : text}
        </pre>
      </details>
    )
  }

  if (entry.kind === EntryKind.user) {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded bg-[#1e293b] px-3 py-2 whitespace-pre-wrap text-[13px] text-[#e6e8ef]">
          {entryText(entry)}
        </p>
      </div>
    )
  }

  return (
    <div>
      <p className="text-[10px] tracking-widest text-[#4b5563] uppercase">助手</p>
      <MarkdownText text={entryText(entry)} />
    </div>
  )
}
