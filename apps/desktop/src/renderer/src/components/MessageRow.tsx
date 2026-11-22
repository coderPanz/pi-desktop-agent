import { EntryKind, entryText } from "@pi/shared-types"
import type { ViewEntry } from "@pi/shared-types"

import { AssistantAvatar } from "./AssistantAvatar.tsx"
import { Icon } from "./Icon.tsx"
import { MarkdownText } from "./Markdown.tsx"

/** 条目的类型与内容都来自已提交副本；分隔线只对应真实上下文边界。 */
export function MessageRow({ entry }: { readonly entry: ViewEntry }) {
  if (entry.kind === EntryKind.reset || entry.kind === EntryKind.compaction) {
    const handoff = entry.kind === EntryKind.reset ? entryText(entry) : ""
    return (
      <div className="flex items-center gap-4 py-2 text-[11px] text-tertiary">
        <span className="h-px min-w-4 flex-1 bg-divider" />
        <p className="max-w-[80%] text-center">{entry.kind === EntryKind.reset ? "上下文已重置" : "上下文已压缩"}{handoff === "" ? "" : `：${handoff}`}</p>
        <span className="h-px min-w-4 flex-1 bg-divider" />
      </div>
    )
  }

  if (entry.kind === EntryKind.toolResult) {
    const text = entryText(entry)
    return (
      <details className="overflow-hidden rounded-xl border border-divider bg-subtle/45">
        <summary className="flex items-center gap-2.5 px-3.5 py-3 text-[12px] text-secondary hover:bg-hover">
          <Icon name="tool" className="text-tertiary" /><span>工具结果</span>
          <Icon name="chevron" className="pi-disclosure ml-auto size-3 text-tertiary" />
        </summary>
        <pre className="max-h-64 overflow-auto border-t border-divider px-4 py-3 font-mono text-[12px] leading-6 whitespace-pre-wrap text-secondary">{text === "" ? "（没有输出）" : text}</pre>
      </details>
    )
  }

  if (entry.kind === EntryKind.user) {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-2xl rounded-tr-md bg-user px-4 py-3 text-[14px] leading-6 whitespace-pre-wrap text-primary">{entryText(entry)}</p>
      </div>
    )
  }

  return (
    <div className="min-w-0">
      <div className="mb-2.5 flex items-center gap-2 text-[12px] font-medium text-secondary">
        <AssistantAvatar className="size-7" />WorkPi
      </div>
      <MarkdownText text={entryText(entry)} />
    </div>
  )
}
