/**
 * 本轮改动卡片：改完给用户 review，不打断 coding 流程。
 *
 * git 仓库才展示逐文件 diff（点开该文件才拉）；非 git 只列本轮触达的路径并说明原因。
 * 故意不落盘 patch：每轮存 diff 会让磁盘长期膨胀。
 */
import { useState } from "react"
import type { ChangeSummaryView } from "@pi/shared-types"

import { Icon } from "./Icon.tsx"

const MAX_LINES = 400

export type ChangeSummaryCardProps = {
  readonly summary: ChangeSummaryView | undefined
  /** 非 git 时本轮触达的文件（来自工具调用参数），用来给出可读的列表。 */
  readonly touchedPaths: readonly string[]
  readonly onOpenFile: (path: string) => void
  readonly loadDiff: (path: string) => Promise<string | undefined>
}

export function ChangeSummaryCard({ summary, touchedPaths, onOpenFile, loadDiff }: ChangeSummaryCardProps) {
  const [open, setOpen] = useState(false)
  const [patches, setPatches] = useState<Readonly<Record<string, string | undefined>>>({})

  const files = summary?.files ?? []
  const repo = summary?.repo === true
  // 两种数据源都空就不显示卡片：没改东西不必占版面
  if (files.length === 0 && (repo || touchedPaths.length === 0)) return null

  const added = files.reduce((sum, file) => sum + file.added, 0)
  const removed = files.reduce((sum, file) => sum + file.removed, 0)

  const toggle = (): void => setOpen(value => !value)

  const showPatch = async (file: string): Promise<void> => {
    if (patches[file] !== undefined) return
    const patch = await loadDiff(file)
    setPatches(current => ({ ...current, [file]: patch }))
  }

  return (
    <div className="overflow-hidden rounded-xl border border-divider bg-surface">
      <button className="flex w-full items-center gap-2.5 px-3.5 py-3 text-left hover:bg-subtle/70" onClick={toggle} aria-expanded={open}>
        <Icon name="tool" className="text-tertiary" />
        <span className="text-[12px] font-medium text-primary">本轮改动</span>
        {repo ? (
          <span className="text-[11px] text-tertiary">
            {files.length} 个文件
            <span className="ml-1.5 text-success">+{added}</span>
            <span className="ml-1 text-danger">−{removed}</span>
          </span>
        ) : (
          <span className="text-[11px] text-tertiary">{touchedPaths.length} 个文件</span>
        )}
        <span className="ml-auto text-[11px] text-tertiary">{open ? "收起" : "展开"}</span>
        <Icon name="chevron" className={`pi-disclosure size-3 text-tertiary ${open ? "rotate-90" : ""}`} />
      </button>

      {open ? (
        <div className="border-t border-divider bg-subtle/50 px-3.5 py-3">
          {repo ? null : (
            <>
              <p className="mb-2 text-[11px] leading-5 text-tertiary">
                本轮改了 {touchedPaths.length} 个文件：{touchedPaths.join("、")}
              </p>
              <p className="mb-2 text-[11px] leading-5 text-warning">当前工作区不在 git 仓库，无法显示 diff。</p>
            </>
          )}
          {(repo ? files.map(file => file.path) : []).map(file => (
            <div key={file} className="mb-2 last:mb-0">
              <div className="flex items-center gap-2">
                <button className="min-w-0 flex-1 truncate text-left font-mono text-[11px] text-secondary hover:text-accent" title={file} onClick={() => { void showPatch(file) }}>
                  {file}
                </button>
                <button className="shrink-0 rounded-md border border-control-border bg-surface px-2 py-0.5 text-[10px] text-secondary hover:bg-subtle hover:text-accent" onClick={() => onOpenFile(file)}>打开</button>
              </div>
              {patches[file] === undefined ? null : <DiffView patch={patches[file] ?? ""} />}
            </div>
          ))}
          {summary?.truncated === true ? <p className="mt-2 text-[11px] text-tertiary">改动较多，只统计了前 200 个文件。</p> : null}
        </div>
      ) : null}
    </div>
  )
}

function DiffView({ patch }: { readonly patch: string }) {
  if (patch === "") return <p className="mt-1 text-[11px] text-tertiary">（没有可显示的 diff）</p>
  const lines = patch.split("\n").slice(0, MAX_LINES)
  return (
    <pre className="mt-1 max-h-72 overflow-auto rounded-lg border border-divider bg-canvas px-3 py-2 font-mono text-[11px] leading-5">
      {lines.map((line, index) => (
        <div key={index} className={line.startsWith("+") && !line.startsWith("+++") ? "text-success" : line.startsWith("-") && !line.startsWith("---") ? "text-danger" : "text-secondary"}>{line === "" ? " " : line}</div>
      ))}
    </pre>
  )
}
