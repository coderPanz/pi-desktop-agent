/**
 * 一个工具调用：显示状态与输出摘要。
 *
 * 状态只有三种（`pending → running → done`），同一次调用不会重复出现第二条卡片——
 * 数据来源是 `pi.live.tools`，同一个 `callId` 一直是同一个槽位，被更新而不是被追加。
 */
import { useState } from "react"

import type { ToolSlot } from "../docs.ts"

const LABEL: Record<ToolSlot["status"], string> = {
  pending: "等待中",
  running: "执行中",
  done: "已完成",
}

const COLOR: Record<ToolSlot["status"], string> = {
  pending: "text-[#9aa2b1]",
  running: "text-[#fbbf24]",
  done: "text-[#4ade80]",
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
    <div className="rounded border border-[#262b36] bg-[#12151c]">
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="font-mono text-[11px] text-[#6b7280]">{slot.name}</span>
        <span className={`text-[11px] ${COLOR[slot.status]}`}>{LABEL[slot.status]}</span>
        {slot.isError ? <span className="text-[11px] text-[#f87171]">出错</span> : null}
        <span className="ml-auto text-[10px] text-[#4b5563]">{open ? "收起" : "展开"}</span>
      </button>

      {slot.nested.length === 0 ? null : (
        <div className="space-y-1 border-t border-[#1a1f28] px-3 py-2">
          {slot.nested.map((nested) => (
            <div key={nested.callId} className="font-mono text-[11px] text-[#6b7280]">
              ↳ {nested.name} {LABEL[nested.status]}
            </div>
          ))}
        </div>
      )}

      {open || slot.isError ? (
        <div className="border-t border-[#1a1f28] px-3 py-2">
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-[#9aa2b1]">
            {preview === "" ? "（没有输出）" : preview}
          </pre>
          {dropped === "" ? null : (
            <p className="mt-1 text-[10px] text-[#4b5563]">{dropped}</p>
          )}
        </div>
      ) : null}
    </div>
  )
}
