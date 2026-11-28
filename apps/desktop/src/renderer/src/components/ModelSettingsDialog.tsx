/**
 * 模型设置面板：模型 id / 网关地址 / API Key。
 *
 * 规则由主进程决定：环境变量优先时（locked）不允许改；密钥只显示“已保存/来自环境变量”，不回显。
 * 保存后只影响新会话——旧会话保持原模型，这里明确写出来，避免“改了没生效”的误解。
 */
import { useEffect, useState } from "react"
import type { ModelSettingsView } from "@pi/shared-types"

import { Icon } from "./Icon.tsx"

export type ModelSettingsDialogProps = {
  readonly view: ModelSettingsView | undefined
  readonly disabled: boolean
  readonly onClose: () => void
  readonly onSave: (input: { modelId: string; baseUrl?: string; apiKey?: string }) => Promise<void>
  readonly onClearKey: () => Promise<void>
}

export function ModelSettingsDialog({ view, disabled, onClose, onSave, onClearKey }: ModelSettingsDialogProps) {
  const [modelId, setModelId] = useState("")
  const [baseUrl, setBaseUrl] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [saved, setSaved] = useState(false)

  // 打开时用当前生效值填充；密钥永远留空（不回显）。
  useEffect(() => {
    setModelId(view?.modelId ?? "")
    setBaseUrl(view?.baseUrl ?? "")
    setApiKey("")
    setError(undefined)
    // 保存成功后 view 会变，这里不能清掉提示；用户再次编辑时才清。
  }, [view?.modelId, view?.baseUrl])

  const locked = view?.locked === true
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(undefined)
    try {
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const save = () => {
    void run(async () => {
      await onSave({
        modelId: modelId.trim(),
        ...(baseUrl.trim() === "" ? {} : { baseUrl: baseUrl.trim() }),
        ...(apiKey.trim() === "" ? {} : { apiKey: apiKey.trim() }),
      })
      setApiKey("")
      setSaved(true)
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-6" role="dialog" aria-modal="true" aria-label="模型设置" onMouseDown={onClose}>
      <div className="w-[440px] rounded-2xl border border-divider bg-surface p-6 shadow-xl" onMouseDown={event => event.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-primary">模型设置</h2>
          <button className="rounded p-1 text-tertiary hover:bg-hover hover:text-primary" aria-label="关闭" onClick={onClose}>
            <Icon name="close" className="size-4" />
          </button>
        </div>

        {locked ? (
          <p className="mt-3 rounded-lg border border-warning/15 bg-warning-soft px-3 py-2 text-[12px] leading-5 text-warning">
            当前由环境变量 ANTHROPIC_* 提供配置，优先级高于应用内设置；要在这里改，请先移除环境变量。
          </p>
        ) : null}

        <label className="mt-4 block text-[12px] font-medium text-secondary">
          模型 id
          <input className="mt-1.5 w-full rounded-lg border border-control-border bg-canvas px-3 py-2 text-[13px] text-primary outline-none focus:border-accent/60 disabled:opacity-60" value={modelId} disabled={locked || busy || disabled} placeholder="例如 deepseek-v4.1-flash" onChange={event => { setModelId(event.target.value); setSaved(false) }} />
        </label>

        <label className="mt-3 block text-[12px] font-medium text-secondary">
          网关地址（可留空用默认）
          <input className="mt-1.5 w-full rounded-lg border border-control-border bg-canvas px-3 py-2 text-[13px] text-primary outline-none focus:border-accent/60 disabled:opacity-60" value={baseUrl} disabled={locked || busy || disabled} placeholder="https://api.anthropic.com" onChange={event => { setBaseUrl(event.target.value); setSaved(false) }} />
        </label>

        <label className="mt-3 block text-[12px] font-medium text-secondary">
          API Key
          <input type="password" className="mt-1.5 w-full rounded-lg border border-control-border bg-canvas px-3 py-2 text-[13px] text-primary outline-none focus:border-accent/60 disabled:opacity-60" value={apiKey} disabled={locked || busy || disabled} placeholder={view?.key.stored === true ? "已保存（留空表示不修改）" : "未保存，请填写"} onChange={event => { setApiKey(event.target.value); setSaved(false) }} />
        </label>

        <p className="mt-2 text-[11px] leading-5 text-tertiary">
          密钥用系统密钥链加密保存在本机；不会写入会话库或以明文出现在日志里。
          当前凭证来源：{describeKey(view)}
        </p>

        {error === undefined ? null : (
          <p role="alert" className="mt-3 rounded-lg border border-danger/15 bg-danger-soft px-3 py-2 text-[12px] leading-5 text-danger">{error}</p>
        )}
        {saved ? (
          <p className="mt-3 rounded-lg border border-success/20 bg-success-soft px-3 py-2 text-[12px] leading-5 text-success">
            配置已保存，将用于<strong>新建会话</strong>。当前已有会话仍使用各自原来的模型。
          </p>
        ) : null}

        <div className="mt-5 flex items-center justify-between gap-2">
          <button className="rounded-lg border border-control-border px-3 py-2 text-[12px] text-secondary hover:bg-hover disabled:opacity-50" disabled={locked || busy || disabled || view?.key.stored !== true} onClick={() => { void run(onClearKey) }}>
            清除已保存密钥
          </button>
          <div className="flex items-center gap-2">
            <button className="rounded-lg border border-control-border px-3 py-2 text-[12px] text-secondary hover:bg-hover" onClick={onClose}>取消</button>
            <button className="rounded-lg bg-accent px-3.5 py-2 text-[12px] font-medium text-white hover:bg-accent-hover disabled:opacity-50" disabled={locked || busy || disabled || modelId.trim() === ""} onClick={save}>
              {busy ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function describeKey(view: ModelSettingsView | undefined): string {
  if (view === undefined) return "未知"
  if (view.key.stored) return "应用配置（系统密钥链）"
  if (view.key.env) return "ANTHROPIC_API_KEY 环境变量"
  return "未配置"
}