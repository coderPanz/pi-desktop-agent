/**
 * 一个工具调用：显示状态与输出摘要。
 *
 * 状态只有三种（`pending → running → done`），同一次调用不会重复出现第二条卡片——
 * 数据来源是 `pi.live.tools`，同一个 `callId` 一直是同一个槽位，被更新而不是被追加。
 */
import { useState } from "react"

import type { ToolSlot } from "../docs.ts"
import { Icon } from "./Icon.tsx"

const LABEL: Record<ToolSlot["status"], string> = {
  pending: "等待中",
  running: "执行中",
  done: "已完成",
}

const COLOR: Record<ToolSlot["status"], string> = {
  pending: "bg-subtle text-secondary",
  running: "bg-warning-soft text-warning",
  done: "bg-success-soft text-success",
}

/** 输出只展示前几百字符；完整结果在会话记录里。 */
const PREVIEW_LIMIT = 600

export function ToolCard({ slot }: { readonly slot: ToolSlot }) {
  const [open, setOpen] = useState(false)
  const output = slot.output ?? ""
  const preview = output.length > PREVIEW_LIMIT && !open ? `${output.slice(0, PREVIEW_LIMIT)}…` : output
  const dropped =
    slot.droppedBytes === undefined && slot.droppedLines === undefined
      ? ""
      : `（省略 ${String(slot.droppedLines ?? 0)} 行 / ${String(slot.droppedBytes ?? 0)} 字节）`

  return (
    <div className="overflow-hidden rounded-xl border border-divider bg-surface">
      <button className="flex w-full items-center gap-2.5 px-3.5 py-3 text-left hover:bg-subtle/70" onClick={() => setOpen((value) => !value)} aria-expanded={open || slot.isError}>
        <Icon name="tool" className="text-tertiary" />
        <span className="font-mono text-[12px] font-medium text-primary">{slot.name}</span>
        <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${COLOR[slot.status]}`}>{LABEL[slot.status]}</span>
        {slot.isError ? <span className="rounded-md bg-danger-soft px-1.5 py-0.5 text-[10px] font-medium text-danger">出错</span> : null}
        <span className="ml-auto text-[11px] text-tertiary">{open ? "收起" : "展开"}</span>
        <Icon name="chevron" className={`pi-disclosure size-3 text-tertiary ${open ? "rotate-90" : ""}`} />
      </button>

      {slot.nested.length === 0 ? null : (
        <div className="space-y-2 border-t border-divider bg-subtle/40 px-4 py-3">
          {slot.nested.map((nested) => (
            <div key={nested.callId} className="flex items-center gap-2 font-mono text-[11px] text-secondary">
              <span className="text-tertiary">↳</span>{nested.name}<span className="ml-auto">{LABEL[nested.status]}</span>
            </div>
          ))}
        </div>
      )}

      {open || slot.isError ? (
        <div className="border-t border-divider bg-subtle/70 px-4 py-3">
          <pre className="max-h-64 overflow-auto font-mono text-[12px] leading-6 whitespace-pre-wrap text-secondary">{preview === "" ? "（没有输出）" : preview}</pre>
          {dropped === "" ? null : <p className="mt-2 text-[11px] text-tertiary">{dropped}</p>}
        </div>
      ) : null}
    </div>
  )
}
