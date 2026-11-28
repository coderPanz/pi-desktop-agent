/** Agent 提出子应用后显示的安装确认页；源码仅供审阅，安装只提交主进程签发的 token。 */
import { useEffect, useState } from "react"
import type { AppSubapp, SubappPreview, SubappProposal } from "@pi/shared-types"

import { invoke } from "../ipc.ts"
import { Icon } from "./Icon.tsx"

export function SubappInstallDialog(props: {
  readonly proposal: SubappProposal
  readonly onClose: () => void
  readonly onInstalled: (item: AppSubapp) => void
}) {
  const [preview, setPreview] = useState<SubappPreview | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [forceRequired, setForceRequired] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    let current = true
    setPreview(undefined)
    setError(undefined)
    setForceRequired(false)
    void invoke("subapp.preview", { candidateId: props.proposal.candidateId })
      .then(value => { if (current) setPreview(value) })
      .catch(cause => { if (current) setError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { current = false }
  }, [props.proposal.candidateId])

  const install = () => {
    if (preview === undefined) return
    if (preview.smoke.status === "failed" && !forceRequired) {
      setForceRequired(true)
      return
    }
    setBusy(true)
    setError(undefined)
    void invoke("subapp.install", {
      installToken: preview.installToken,
      ...(preview.smoke.status === "failed" ? { forceSmokeFailure: true } : {}),
    }).then(item => {
      props.onInstalled(item)
      props.onClose()
    }).catch(cause => {
      setError(cause instanceof Error ? cause.message : String(cause))
    }).finally(() => setBusy(false))
  }

  const capabilities = preview?.manifest.requestedCapabilities ?? props.proposal.manifest.requestedCapabilities
  const smoke = preview?.smoke ?? props.proposal.smoke
  const checks = preview?.staticChecks ?? props.proposal.staticChecks

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-6" role="dialog" aria-modal="true" aria-label="安装子应用" onMouseDown={props.onClose}>
      <div className="flex max-h-[min(760px,calc(100vh-48px))] w-[680px] flex-col rounded-2xl border border-divider bg-surface p-6 shadow-xl" onMouseDown={event => event.stopPropagation()}>
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-[15px] font-semibold text-primary">安装子应用：{props.proposal.manifest.title}</h2>
            <p className="mt-1 font-mono text-[11px] text-tertiary">{props.proposal.manifest.slug} · v{props.proposal.manifest.version}</p>
          </div>
          <button className="rounded p-1 text-tertiary hover:bg-hover hover:text-primary" aria-label="关闭" onClick={props.onClose}>
            <Icon name="close" className="size-4" />
          </button>
        </div>

        <p className="mt-4 rounded-lg border border-warning/20 bg-warning-soft px-3 py-2 text-[12px] leading-5 text-warning">
          此 M1 版本将在桌面应用<strong>主进程</strong>中执行，正式执行尚未隔离。静态规则与 smoke 只证明最小路径可运行，不构成安全沙箱。
        </p>

        <div className="mt-4 grid grid-cols-2 gap-3 text-[12px]">
          <section className="rounded-lg border border-divider bg-canvas p-3">
            <h3 className="font-medium text-secondary">申请能力</h3>
            <ul className="mt-2 space-y-1 text-tertiary">
              <li>工具：{capabilities.tools.join("、")}</li>
              <li>读取：{capabilities.readPaths.join("、") || "无"}</li>
              <li>写入：{capabilities.writePaths.length === 0 ? "无（M1 拒绝）" : capabilities.writePaths.join("、")}</li>
              <li>网络：{capabilities.network ? "申请" : "不申请"}</li>
              <li>命令：{capabilities.runsCommands ? "申请" : "不申请"}</li>
            </ul>
          </section>
          <section className="rounded-lg border border-divider bg-canvas p-3">
            <h3 className="font-medium text-secondary">检查结果</h3>
            <p className={`mt-2 ${smoke.status === "passed" ? "text-success" : smoke.status === "failed" ? "text-danger" : "text-warning"}`}>
              smoke：{smoke.status}{smoke.durationMs === undefined ? "" : `（${smoke.durationMs}ms）`}
            </p>
            <p className="mt-1 text-tertiary">{smoke.summary ?? "尚无摘要"}</p>
          </section>
        </div>

        <section className="mt-3 rounded-lg border border-divider bg-canvas p-3 text-[12px]">
          <h3 className="font-medium text-secondary">静态规则</h3>
          <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
            {checks.map(item => <li key={item.rule} className={item.status === "passed" ? "text-success" : "text-danger"}>{item.status === "passed" ? "✓" : "×"} {item.rule}{item.message === undefined ? "" : `：${item.message}`}</li>)}
          </ul>
        </section>

        {preview === undefined ? <p className="mt-3 text-[12px] text-tertiary">正在取得候选源码与一次性安装许可…</p> : (
          <details className="mt-3 min-h-0 rounded-lg border border-divider bg-canvas p-3 text-[12px]">
            <summary className="cursor-pointer font-medium text-secondary">查看 tool.mjs 源码</summary>
            <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-surface p-3 font-mono text-[11px] text-primary">{preview.files.tool}</pre>
          </details>
        )}

        {forceRequired ? <p className="mt-3 rounded-lg border border-danger/20 bg-danger-soft px-3 py-2 text-[12px] leading-5 text-danger">该候选未通过 smoke。再次点击“仍然安装”即表示你确认继续安装。</p> : null}
        {error === undefined ? null : <p role="alert" className="mt-3 rounded-lg border border-danger/20 bg-danger-soft px-3 py-2 text-[12px] text-danger">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button className="rounded-lg border border-control-border px-3 py-2 text-[12px] text-secondary hover:bg-hover" disabled={busy} onClick={props.onClose}>取消</button>
          <button className="rounded-lg bg-accent px-3.5 py-2 text-[12px] font-medium text-white hover:bg-accent-hover disabled:opacity-50" disabled={busy || preview === undefined} onClick={install}>
            {busy ? "安装中…" : forceRequired ? "仍然安装" : "安装"}
          </button>
        </div>
      </div>
    </div>
  )
}
