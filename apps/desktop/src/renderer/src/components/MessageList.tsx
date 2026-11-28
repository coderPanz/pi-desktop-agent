/**
 * 消息列表只画已提交条目与 live 文本；最终回答与同内容的流式片段不重复显示。
 */
import { useEffect } from "react"

import { EntryKind, entryText, liveGenerationText } from "@pi/shared-types"
import type { ChangeSummaryView, ViewEntry, ViewSnapshot } from "@pi/shared-types"

import { toolCallPath, toolResultCallId } from "../docs.ts"
import type { QueuedItem, ToolSlot } from "../docs.ts"
import { useStickToBottom } from "../hooks/useStickToBottom.ts"
import { AssistantAvatar } from "./AssistantAvatar.tsx"
import { Icon } from "./Icon.tsx"
import { ChangeSummaryCard } from "./ChangeSummaryCard.tsx"
import { MessageRow } from "./MessageRow.tsx"
import { StreamingMarkdown } from "./StreamingMarkdown.tsx"
import { ToolCard } from "./ToolCard.tsx"

export type MessageListProps = {
  readonly snapshot: ViewSnapshot | undefined
  readonly running: boolean
  readonly tools: readonly ToolSlot[]
  readonly queued: readonly QueuedItem[]
  /** 打开工作区文件（主进程校验边界后交给系统）。 */
  readonly onOpenFile: (path: string) => void
  /** 复制路径到剪贴板。 */
  readonly onCopyPath: (path: string) => void
  /** 文件写盘后刷新「本轮改动」。 */
  readonly onEdited: () => void
  /** 把文件撤销到本轮基线。 */
  readonly onRevert: (path: string) => Promise<boolean>
  /** 本轮改动（git 现算）；非 git 时用 `touchedPaths` 列表降级展示。 */
  readonly changes: {
    readonly summary: ChangeSummaryView | undefined
    readonly loadDiff: (path: string) => Promise<string | undefined>
    readonly round: number
    readonly rounds: number
    readonly setRound: (round: number) => void
  }
  readonly touchedPaths: readonly string[]
}

// 已提交历史 + 实时生成 + 实时工具状态 + 排队输入统一组织成对话区 UI 的组件
export function MessageList({ snapshot, running, tools, queued, onOpenFile, onCopyPath, onEdited, onRevert, changes, touchedPaths }: MessageListProps) {
  const entries = snapshot === undefined ? [] : visibleEntries(snapshot.entries)
  const liveText = snapshot === undefined ? undefined : liveGenerationText(snapshot)
  const lastAssistant = snapshot === undefined ? undefined : lastAssistantText(snapshot.entries)
  const streaming = running && liveText !== undefined && liveText !== lastAssistant
  const empty = entries.length === 0 && !running && tools.length === 0 && queued.length === 0
  // 只有用户本来就在底部时才跟随流式内容；往上翻就不动，靠「回到最新」回去
  const { scroller, content, stuck, onScroll, follow, nudge } = useStickToBottom(snapshot?.conversation.id)
  const lastEntry = entries.at(-1)

  // 自己发出的消息、重置：无论之前滚到哪，都回到最新（那时用户关心的就是刚发生的事）
  useEffect(() => {
    if (lastEntry === undefined) return
    if (lastEntry.kind !== EntryKind.user && lastEntry.kind !== EntryKind.reset) return
    follow()
  }, [lastEntry?.id, lastEntry?.kind, follow])

  // 条目从流式节点变成正式消息时高度会变但不一定触发 ResizeObserver；贴底时补一次。
  useEffect(() => {
    nudge()
  }, [entries.length, liveText?.length, nudge])

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} onScroll={onScroll} aria-label="会话内容" className="h-full overflow-y-auto">
        <div ref={content} className={`mx-auto w-full max-w-[var(--pi-content-max)] px-6 py-8 ${empty ? "flex min-h-full flex-col items-center justify-center" : "space-y-6"}`}>
          {empty ? (
            <div className="max-w-80 pb-8 text-center">
              <AssistantAvatar className="mx-auto mb-5 size-16 shadow-control" />
              <h2 className="text-[20px] font-semibold tracking-tight text-primary">开始一段对话</h2>
              <p className="mt-2.5 text-[13px] leading-6 text-secondary">{snapshot === undefined ? "正在准备工作区…" : "描述你的任务，Agent 将在本机工作区中协助你。"}</p>
            </div>
          ) : null}

          {entries.map((entry) => {
            const callId = snapshot === undefined ? undefined : toolResultCallId(entry)
            const path = snapshot === undefined || callId === undefined ? undefined : toolCallPath(snapshot, callId)
            return (
              <MessageRow key={entry.id} entry={entry} path={path} onOpenFile={onOpenFile} onCopyPath={onCopyPath} />
            )
          })}
          {tools.map((slot) => (
            <ToolCard
              key={slot.callId}
              slot={slot}
              path={snapshot === undefined ? undefined : toolCallPath(snapshot, slot.callId)}
              onOpenFile={onOpenFile}
              onCopyPath={onCopyPath}
            />
          ))}

          {streaming ? (
            <div>
              <p className="mb-2.5 flex items-center gap-2 text-[12px] font-medium text-secondary"><AssistantAvatar className="size-6" />正在生成</p>
              <StreamingMarkdown text={liveText} />
            </div>
          ) : null}
          {running && !streaming ? <p className="flex items-center gap-2 text-[12px] text-secondary"><AssistantAvatar className="size-6" />生成中…</p> : null}

          {empty ? null : (
            <ChangeSummaryCard
              summary={changes.summary}
              touchedPaths={touchedPaths}
              onOpenFile={onOpenFile}
              onEdited={onEdited}
              onRevert={onRevert}
              round={changes.round}
              rounds={changes.rounds}
              onRoundChange={changes.setRound}
              loadDiff={changes.loadDiff}
            />
          )}

          {queued.length === 0 ? null : (
            <div className="rounded-xl border border-accent/10 bg-selection/35 px-4 py-3">
              <p className="mb-1.5 flex items-center gap-2 text-[12px] font-medium text-accent"><Icon name="message" className="size-3.5" />排队 {queued.length} 条（等当前这轮结束）</p>
              {queued.map((item) => (
                <p key={item.id} className="mt-1 truncate text-[12px] leading-5 text-secondary">{item.mode === "steer" ? "插话：" : ""}{item.text === "" ? "（记录）" : item.text}</p>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 只有用户离开底部时才出现；点一下回到最新并恢复跟随。 */}
      {stuck ? null : (
        <button
          aria-label="回到最新"
          className="absolute bottom-5 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-control-border bg-surface/95 px-3 py-1.5 text-[12px] text-secondary shadow-control backdrop-blur-sm hover:bg-subtle hover:text-primary"
          onClick={follow}
        >
          <Icon name="arrow-up" className="size-3 rotate-180" />
          回到最新
        </button>
      )}
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
