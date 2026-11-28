/**
 * 展开在卡片里的内联编辑器：点文件即可读可改，停止输入后自动保存。
 *
 * 三个控制写入次数的旋钮（写盘按整文件覆盖，次数比单次成本更值得管）：
 * 1. 防抖 1s：连续输入只在停顿后写一次
 * 2. 最长等待 5s：一直不停地打字也会强制落盘一次，避免长时间不写
 * 3. 内容没变不写：删了又补回同样内容不算改动
 *
 * 写盘用 mtime 做乐观锁：磁盘在编辑期间被改过（例如 Agent 又写了同一个文件）就暂停自动保存，
 * 把选择权交给用户（覆盖 / 重新加载），避免互相覆盖。
 *
 * 保存后不立刻刷新「本轮改动」：那会每敲一段就跑一次 git，等编辑停下来再刷新。
 */
import { useEffect, useRef, useState } from "react"

import { invoke } from "../ipc.ts"

/** 停止输入多久后写盘。 */
const AUTOSAVE_MS = 1_000
/** 连续输入时的最长等待：到点强制写一次。 */
const MAX_WAIT_MS = 5_000
/** 写盘后隔多久刷新「本轮改动」：把连续的几次保存合并成一次 git 统计。 */
const REFRESH_MS = 3_000
/**
 * 超过这个大小的文件不自动保存：自动保存是整文件覆盖，大文件连打字会放大 IO，
 * 也更容易让同步盘反复上传。改为手动 ⌘S，并明确提示“未保存”。
 */
const AUTOSAVE_LIMIT_BYTES = 512 * 1024

export type InlineFileEditorProps = {
  readonly path: string
  /** 写盘成功后通知外层刷新「本轮改动」（内部已合并多次保存）。 */
  readonly onSaved: () => void
}

export function InlineFileEditor({ path, onSaved }: InlineFileEditorProps) {
  const [content, setContent] = useState("")
  const [saved, setSaved] = useState("")
  const [mtimeMs, setMtimeMs] = useState(0)
  const [status, setStatus] = useState<"loading" | "ready" | "saving" | "conflict" | "error">("loading")
  const [error, setError] = useState<string | undefined>(undefined)

  /** 防抖定时器 */
  const timer = useRef<number | undefined>(undefined)
  /** 本轮连续输入的开始时间（用于最长等待） */
  const burstStart = useRef<number | undefined>(undefined)
  /** 冲突后停止自动保存，等用户决定 */
  const paused = useRef(false)
  /** 大文件：不自动保存，只能 ⌘S */
  const manualOnly = useRef(false)
  /** 最近一次写盘成功的内容，避免用 state 判断带来闭包问题 */
  const savedRef = useRef("")
  /** 是否有已保存但还没通知外层的改动 */
  const pendingNotify = useRef(false)
  const refreshTimer = useRef<number | undefined>(undefined)
  const notify = useRef(onSaved)
  notify.current = onSaved

  const scheduleRefresh = (): void => {
    pendingNotify.current = true
    window.clearTimeout(refreshTimer.current)
    // 连续保存只在停下来之后刷新一次 git 统计
    refreshTimer.current = window.setTimeout(() => {
      if (!pendingNotify.current) return
      pendingNotify.current = false
      notify.current()
    }, REFRESH_MS)
  }

  const load = async (): Promise<void> => {
    setStatus("loading")
    setError(undefined)
    paused.current = false
    try {
      const file = await invoke("file.read", { path })
      setContent(file.content)
      setSaved(file.content)
      savedRef.current = file.content
      setMtimeMs(file.mtimeMs)
      manualOnly.current = new TextEncoder().encode(file.content).length > AUTOSAVE_LIMIT_BYTES
      setStatus("ready")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setStatus("error")
    }
  }

  useEffect(() => {
    void load()
    return () => {
      window.clearTimeout(timer.current)
      window.clearTimeout(refreshTimer.current)
      // 收起编辑器时把还没刷新的改动补上
      if (pendingNotify.current) notify.current()
    }
  }, [path])

  const flush = async (text: string): Promise<void> => {
    burstStart.current = undefined
    setStatus("saving")
    try {
      const result = await invoke("file.write", { path, content: text, mtimeMs })
      if (result.status === "conflict") {
        paused.current = true
        setMtimeMs(result.mtimeMs)
        setStatus("conflict")
        return
      }
      setMtimeMs(result.mtimeMs)
      setSaved(text)
      savedRef.current = text
      setStatus("ready")
      scheduleRefresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setStatus("error")
    }
  }

  const change = (text: string): void => {
    setContent(text)
    if (paused.current) return
    window.clearTimeout(timer.current)
    // 内容没变（例如删了又补回）：丢掉待写的定时器，什么都不做
    if (text === savedRef.current) {
      burstStart.current = undefined
      setStatus("ready")
      return
    }
    // 大文件不自动写：用户按 ⌘S 才保存
    if (manualOnly.current) {
      setStatus("ready")
      return
    }
    const now = Date.now()
    burstStart.current ??= now
    // 打字不停时也要落盘：等到最长等待就立刻写
    const waited = now - burstStart.current
    const delay = Math.max(0, Math.min(AUTOSAVE_MS, MAX_WAIT_MS - waited))
    timer.current = window.setTimeout(() => { void flush(text) }, delay)
  }

  const overwrite = (): void => {
    paused.current = false
    void flush(content)
  }

  if (status === "loading") return <p className="mt-1 text-[11px] text-tertiary">正在读取…</p>
  if (status === "error") {
    return (
      <div className="mt-1 rounded-lg border border-danger/15 bg-danger-soft px-2.5 py-1.5">
        <p role="alert" className="text-[11px] leading-5 text-danger">{error ?? "无法打开"}</p>
      </div>
    )
  }

  return (
    <div className="mt-1">
      <textarea
        aria-label={`编辑 ${path}`}
        className="max-h-80 min-h-24 w-full resize-y rounded-lg border border-control-border bg-canvas px-2.5 py-2 font-mono text-[11px] leading-5 text-primary outline-none focus:border-accent/60"
        spellCheck={false}
        value={content}
        onChange={event => change(event.target.value)}
        onKeyDown={event => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
            event.preventDefault()
            void flush(event.currentTarget.value)
          }
        }}
      />
      <div className="mt-1 flex items-center gap-2 text-[10px]">
        <span className={status === "conflict" ? "text-warning" : "text-tertiary"}>
          {status === "saving"
            ? "保存中…"
            : status === "conflict"
              ? "磁盘内容已被改过，自动保存已暂停"
              : content === saved
                ? "已保存"
                : manualOnly.current
                  ? "大文件：⌘S 保存"
                  : "即将保存…"}
        </span>
        {status === "conflict" ? (
          <>
            <button className="rounded border border-warning/30 px-1.5 py-0.5 text-warning hover:bg-warning/10" onClick={overwrite}>覆盖磁盘</button>
            <button className="rounded border border-control-border px-1.5 py-0.5 text-secondary hover:bg-subtle" onClick={() => void load()}>重新加载</button>
          </>
        ) : null}
      </div>
    </div>
  )
}
