/**
 * 桌面工作区：展示主进程副本，将用户意图交给 IPC；视觉层不预测会话、审批或生成状态。
 */
import { useCallback, useEffect, useState } from "react"

import { submissionFailure } from "@pi/shared-types"
import type { ConversationId } from "@pi/shared-types"

import { ApprovalBar } from "./components/ApprovalBar.tsx"
import { Composer } from "./components/Composer.tsx"
import { Icon } from "./components/Icon.tsx"
import { MessageList } from "./components/MessageList.tsx"
import { compactionFailure, generationFailure, isRunning, queuedItems, toolSlots } from "./docs.ts"
import { invoke } from "./ipc.ts"
import { useConversation } from "./useConversation.ts"
import { useApprovals, useHost } from "./useHost.ts"
import { useSubmission } from "./useSubmission.ts"

export function App() {
  const host = useHost()
  const [selected, setSelected] = useState<ConversationId | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busyAction, setBusyAction] = useState<string | undefined>(undefined)

  const conversation = useConversation(selected)
  const approvals = useApprovals(selected)
  const submission = useSubmission(selected)

  // 起始会话由主进程给（root），界面不自己猜。
  useEffect(() => {
    if (selected === undefined && host.info !== undefined) setSelected(host.info.rootConversationId)
  }, [host.info, selected])

  const snapshot = conversation.snapshot
  const running = snapshot !== undefined && isRunning(snapshot)
  const retryFailure = snapshot === undefined ? undefined : generationFailure(snapshot)
  const terminalFailure = submissionFailure(submission, snapshot)
  const compactionError = snapshot === undefined ? undefined : compactionFailure(snapshot)
  const queued = snapshot === undefined ? [] : queuedItems(snapshot)
  const tools = snapshot === undefined ? [] : toolSlots(snapshot)

  /** 所有动作都走同一个错误出口：失败只提示，不改界面状态。 */
  const run = useCallback(async (label: string, action: () => Promise<void>) => {
    setBusyAction(label)
    setError(undefined)
    try {
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusyAction(undefined)
    }
  }, [])

  const send = (text: string): void => {
    if (selected === undefined) return
    void run("发送", async () => {
      await invoke("conv.submit", { conversationId: selected, text })
      await host.refresh()
    })
  }

  const abort = (): void => {
    if (selected === undefined) return
    void run("停止", async () => {
      await invoke("conv.abort", { conversationId: selected })
    })
  }

  const create = (): void => {
    void run("新建", async () => {
      const created = await invoke("conv.create", {})
      await host.refresh()
      setSelected(created.conversationId)
    })
  }

  const fork = (): void => {
    if (selected === undefined) return
    void run("分叉", async () => {
      const forked = await invoke("conv.fork", { conversationId: selected })
      await host.refresh()
      setSelected(forked.conversationId)
    })
  }

  const compact = (): void => {
    if (selected === undefined) return
    void run("压缩", async () => {
      await invoke("conv.compact", { conversationId: selected })
      await host.refresh()
    })
  }

  const reset = (): void => {
    if (selected === undefined) return
    void run("重置", async () => {
      await invoke("conv.reset", { conversationId: selected })
      await host.refresh()
    })
  }

  return (
    <main data-platform={host.info?.platform} className="pi-app flex h-dvh min-h-0 flex-col overflow-hidden font-sans text-[13px] text-primary">
      <Header
        platform={host.info?.platform}
        node={host.info?.node}
        model={host.info?.model?.modelId}
        scheduling={host.status?.scheduling}
        modelHint={host.info?.model === undefined ? "未配置模型：请设置 ANTHROPIC_* 环境变量" : undefined}
      />

      {error === undefined ? null : (
        <Banner tone="error" onDismiss={() => setError(undefined)}>{error}</Banner>
      )}
      {retryFailure === undefined && terminalFailure === undefined ? null : (
        <Banner tone="warn">
          生成失败：{retryFailure?.message ?? terminalFailure}
          {retryFailure?.retryAt === undefined ? "" : "（等待自动重试）"}
        </Banner>
      )}
      {compactionError === undefined ? null : (
        <Banner tone="warn">压缩失败：{compactionError}</Banner>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[244px_minmax(0,1fr)]">
        <aside aria-label="会话侧栏" className="flex min-h-0 flex-col border-r border-divider bg-sidebar px-3.5 pt-5 pb-4 backdrop-blur-xl">
          <div className="flex items-center justify-between px-2">
            <h2 className="text-[12px] font-semibold text-secondary">会话</h2>
            <button className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-accent hover:bg-selection active:bg-selection/70" disabled={busyAction !== undefined} onClick={create} title="新建会话">
              <Icon name="plus" className="size-3.5" />新建
            </button>
          </div>

          <div className="mt-3 min-h-0 flex-1 space-y-1 overflow-y-auto" aria-label="会话列表">
            {host.conversations.map((item) => (
              <button
                key={item.id}
                data-conversation-id={item.id}
                aria-pressed={item.id === selected}
                onClick={() => setSelected(item.id)}
                className={`flex w-full items-start gap-2.5 rounded-lg px-3 py-2.5 text-left ${item.id === selected ? "bg-selection text-accent" : "text-secondary hover:bg-hover active:bg-hover"}`}
              >
                <Icon name={item.parent === undefined ? "message" : "branch"} className="mt-0.5" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium">会话 #{item.id}</span>
                  {item.parent === undefined ? null : <span className="mt-0.5 block text-[11px] text-secondary">← #{item.parent.conversationId}</span>}
                  {item.busy || item.queued > 0 ? (
                    <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-secondary">
                      {item.busy ? <span>忙</span> : null}
                      {item.queued > 0 ? <span>排队 {item.queued}</span> : null}
                    </span>
                  ) : null}
                </span>
              </button>
            ))}
          </div>

          <div className="mt-5 shrink-0 border-t border-divider pt-4">
            <p className="mb-2 px-2 text-[11px] font-medium text-tertiary">会话操作</p>
            <div className="grid grid-cols-3 gap-1.5">
              {([
                { label: "分叉", icon: "branch", action: fork, hint: "从最新一条消息分出新会话" },
                { label: "压缩", icon: "compress", action: compact, hint: "把长历史压成摘要" },
                { label: "重置", icon: "reset", action: reset, hint: "清空上下文，不删历史" },
              ] as const).map((button) => (
                <button key={button.label} className="flex items-center justify-center gap-1.5 rounded-lg border border-control-border/70 bg-surface/65 px-1.5 py-2 text-[12px] text-secondary shadow-control hover:bg-surface active:bg-subtle" disabled={selected === undefined || busyAction !== undefined || running} title={button.hint} onClick={button.action}>
                  <Icon name={button.icon} className="size-3.5" />{button.label}
                </button>
              ))}
            </div>
          </div>
        </aside>

        <section aria-label="Agent 工作区" className="flex min-h-0 min-w-0 flex-col bg-canvas">
          <DebugBar
            convId={conversation.convId}
            status={conversation.status}
            seq={conversation.seq}
            entries={snapshot?.entries.length ?? 0}
            docs={Object.keys(snapshot?.docs ?? {}).length}
            resyncs={conversation.resyncs}
            stale={conversation.stale}
            onResync={conversation.resync}
          />
          <ApprovalBar pending={approvals.pending} onRespond={(id, approved) => {
            void run("审批", async () => { await approvals.respond(id, approved) })
          }} />
          <MessageList snapshot={snapshot} running={running} tools={tools} queued={queued} />
          <Composer disabled={selected === undefined} running={running} onSend={send} onAbort={abort} />
        </section>
      </div>
    </main>
  )
}

function Header(props: {
  readonly platform: string | undefined
  readonly node: string | undefined
  readonly model: string | undefined
  readonly scheduling: string | undefined
  readonly modelHint: string | undefined
}) {
  return (
    <header className="pi-titlebar flex min-h-16 shrink-0 items-center gap-6 border-b border-divider bg-toolbar px-6 py-2 backdrop-blur-xl">
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-[10px] border border-divider bg-surface/85 text-accent shadow-control"><Icon name="sparkles" className="size-4.5" /></span>
        <div className="min-w-0">
          <h1 className="truncate text-[14px] font-semibold tracking-tight">Pi Agent Desktop</h1>
          <p className="mt-0.5 truncate text-[11px] text-tertiary">{props.platform === undefined ? "启动中…" : `${props.platform} · node ${String(props.node)}`}</p>
        </div>
      </div>
      <div className="flex min-w-0 shrink-0 items-center gap-3">
        {props.model === undefined ? null : (
          <span className="flex items-center gap-1.5 rounded-lg border border-divider bg-surface/70 px-2.5 py-1.5 text-[12px] text-secondary" title={props.model}>
            <Icon name="model" className="size-3.5 text-tertiary" /><span className="pi-model-label max-w-56 truncate">{props.model}</span>
          </span>
        )}
        {props.scheduling === undefined ? null : (
          <span className="flex items-center gap-1.5 text-[11px] text-secondary"><span className={`size-1.5 rounded-full ${props.scheduling === "running" ? "bg-success" : "bg-tertiary"}`} />调度 {props.scheduling}</span>
        )}
      </div>
      {props.modelHint === undefined ? null : <span className="max-w-56 text-[11px] text-warning">{props.modelHint}</span>}
    </header>
  )
}

function Banner(props: { readonly tone: "warn" | "error"; readonly children: React.ReactNode; readonly onDismiss?: () => void }) {
  return (
    <div role="alert" className={`mx-5 my-2 flex shrink-0 items-start gap-2.5 rounded-xl border px-4 py-3 text-[12px] leading-5 ${props.tone === "error" ? "border-danger/15 bg-danger-soft text-danger" : "border-warning/15 bg-warning-soft text-warning"}`}>
      <Icon name="alert" className="mt-0.5" />
      <span className="min-w-0 flex-1 break-words">{props.children}</span>
      {props.onDismiss === undefined ? null : <button className="shrink-0 rounded px-1.5 py-0.5 font-medium hover:bg-danger/5" onClick={props.onDismiss}>知道了</button>}
    </div>
  )
}

/** 保留所有验收信息，但以低干扰的工具条呈现，不占据对话的视觉中心。 */
function DebugBar(props: {
  readonly convId: ConversationId | undefined
  readonly status: string
  readonly seq: number
  readonly entries: number
  readonly docs: number
  readonly resyncs: number
  readonly stale: number
  readonly onResync: () => void
}) {
  return (
    <div aria-label="副本同步状态" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-divider px-5 py-2.5 font-mono text-[10px] text-tertiary">
      <span className="font-medium text-secondary">conv #{props.convId ?? "—"}</span>
      <span>status {props.status}</span><span>seq {props.seq}</span><span>entries {props.entries}</span><span>docs {props.docs}</span>
      <span className={props.resyncs === 0 && props.stale === 0 ? "" : "text-warning"}>重连 {props.resyncs} · 丢弃 {props.stale}</span>
      <button className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 font-sans text-[11px] text-secondary hover:bg-hover hover:text-accent" onClick={props.onResync} title="重新同步会话副本"><Icon name="refresh" className="size-3" />重连</button>
    </div>
  )
}
