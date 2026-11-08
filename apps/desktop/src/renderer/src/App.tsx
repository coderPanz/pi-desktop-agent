/**
 * 桌面主界面：左侧会话列表，右侧当前会话。
 *
 * 这一层只做布局、选中状态和按钮回调；数据来自三个 hook：
 *   - `useHost`         应用信息、宿主状态、会话列表
 *   - `useConversation` 某个会话的只读副本（帧叠加 + 跳号重连）
 *   - `useApprovals`    该会话的待审批请求
 *
 * 一条硬规则：**界面不预测主进程的状态**。发送后不插消息、停止后不标「已停止」、
 * 审批答复后不本地删除——都等帧或推送回来说发生了什么。
 */
import { useCallback, useEffect, useState } from "react"

import type { ConversationId } from "@pi/shared-types"

import { ApprovalBar } from "./components/ApprovalBar.tsx"
import { Composer } from "./components/Composer.tsx"
import { MessageList } from "./components/MessageList.tsx"
import { compactionFailure, generationFailure, isRunning, queuedItems, toolSlots } from "./docs.ts"
import { invoke } from "./ipc.ts"
import { useConversation } from "./useConversation.ts"
import { useApprovals, useHost } from "./useHost.ts"

export function App() {
  const host = useHost()
  const [selected, setSelected] = useState<ConversationId | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busyAction, setBusyAction] = useState<string | undefined>(undefined)

  const conversation = useConversation(selected)
  const approvals = useApprovals(selected)

  // 起始会话由主进程给（root），界面不自己猜。
  useEffect(() => {
    if (selected === undefined && host.info !== undefined) setSelected(host.info.rootConversationId)
  }, [host.info, selected])

  const snapshot = conversation.snapshot
  const running = snapshot !== undefined && isRunning(snapshot)
  const failure = snapshot === undefined ? undefined : generationFailure(snapshot)
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
    <main className="flex min-h-full flex-col gap-3 p-5 text-sm">
      <Header
        platform={host.info?.platform}
        node={host.info?.node}
        model={host.info?.model?.modelId}
        scheduling={host.status?.scheduling}
        modelHint={host.info?.model === undefined ? "未配置模型：请设置 ANTHROPIC_* 环境变量" : undefined}
      />

      {error === undefined ? null : (
        <Banner tone="error" onDismiss={() => setError(undefined)}>
          {error}
        </Banner>
      )}

      {failure === undefined ? null : (
        <Banner tone="warn">
          生成失败：{failure.message}
          {failure.retryAt === undefined ? "" : "（稍后会自动重试一次）"}
        </Banner>
      )}

      {compactionError === undefined ? null : (
        <Banner tone="warn">压缩失败：{compactionError}</Banner>
      )}

      <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-[220px_1fr]">
        <aside className="space-y-1">
          <div className="flex items-center justify-between">
            <h2 className="text-[10px] tracking-widest text-[#6b7280] uppercase">会话</h2>
            <button
              className="text-[11px] text-[#60a5fa] disabled:opacity-40"
              disabled={busyAction !== undefined}
              onClick={create}
            >
              新建
            </button>
          </div>

          {host.conversations.map((item) => (
            <button
              key={item.id}
              onClick={() => setSelected(item.id)}
              className={`block w-full rounded px-2 py-1 text-left text-[11px] ${
                item.id === selected
                  ? "bg-[#1f2937] text-[#e6e8ef]"
                  : "text-[#9aa2b1] hover:bg-[#171a22]"
              }`}
            >
              #{item.id}
              {item.parent === undefined ? "" : ` ← #${item.parent.conversationId}`}
              {item.busy ? " · 忙" : ""}
              {item.queued > 0 ? ` · 排队 ${String(item.queued)}` : ""}
            </button>
          ))}

          <div className="flex flex-wrap gap-1 pt-2 text-[11px]">
            {[
              { label: "分叉", action: fork, hint: "从最新一条消息分出新会话" },
              { label: "压缩", action: compact, hint: "把长历史压成摘要" },
              { label: "重置", action: reset, hint: "清空上下文，不删历史" },
            ].map((button) => (
              <button
                key={button.label}
                className="rounded border border-[#262b36] px-2 py-1 text-[#9aa2b1] disabled:opacity-40"
                disabled={selected === undefined || busyAction !== undefined || running}
                title={button.hint}
                onClick={button.action}
              >
                {button.label}
              </button>
            ))}
          </div>
        </aside>

        <section className="flex min-h-0 flex-col gap-2">
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

          <ApprovalBar
            pending={approvals.pending}
            onRespond={(id, approved) => {
              void run("审批", async () => {
                await approvals.respond(id, approved)
              })
            }}
          />

          <MessageList snapshot={snapshot} running={running} tools={tools} queued={queued} />

          <Composer
            disabled={selected === undefined}
            running={running}
            onSend={send}
            onAbort={abort}
          />
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
    <header className="flex flex-wrap items-center gap-3">
      <h1 className="text-base font-semibold text-[#e6e8ef]">Pi Agent Desktop</h1>
      <span className="text-[11px] text-[#6b7280]">
        {props.platform === undefined ? "启动中…" : `${props.platform} · node ${String(props.node)}`}
      </span>
      {props.scheduling === undefined ? null : (
        <span className="text-[11px] text-[#6b7280]">调度 {props.scheduling}</span>
      )}
      {props.model === undefined ? null : (
        <span className="text-[11px] text-[#6b7280]">{props.model}</span>
      )}
      {props.modelHint === undefined ? null : (
        <span className="text-[11px] text-[#a16207]">{props.modelHint}</span>
      )}
    </header>
  )
}

function Banner(props: {
  readonly tone: "warn" | "error"
  readonly children: React.ReactNode
  readonly onDismiss?: () => void
}) {
  const style =
    props.tone === "error"
      ? "border-[#7f1d1d] bg-[#2a1417] text-[#fca5a5]"
      : "border-[#78350f] bg-[#2a1f0f] text-[#fcd34d]"
  return (
    <div className={`rounded border px-3 py-2 text-[11px] ${style}`}>
      {props.children}
      {props.onDismiss === undefined ? null : (
        <button className="ml-2 underline" onClick={props.onDismiss}>
          知道了
        </button>
      )}
    </div>
  )
}

/** 验收用的一行：seq 是否连续、有没有重连过。成品界面应把它收进开发者面板。 */
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
    <div className="flex flex-wrap items-center gap-2 rounded border border-[#1a1f28] bg-[#0f1218] px-3 py-1 font-mono text-[10px] text-[#4b5563]">
      <span>conv #{props.convId ?? "—"}</span>
      <span>status {props.status}</span>
      <span>seq {props.seq}</span>
      <span>entries {props.entries}</span>
      <span>docs {props.docs}</span>
      <span className={props.resyncs === 0 && props.stale === 0 ? "" : "text-[#fbbf24]"}>
        重连 {props.resyncs} · 丢弃 {props.stale}
      </span>
      <button className="ml-auto text-[#60a5fa]" onClick={props.onResync}>
        重连
      </button>
    </div>
  )
}
