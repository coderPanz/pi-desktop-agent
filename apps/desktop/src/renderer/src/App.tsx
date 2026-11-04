/**
 * 最小可用的桌面页：验证 §2.1 的接线，而不是成品聊天界面。
 *
 * 它要证明四件事：
 *   1. `app.info` / `conv.list` 能拿到主进程给的数据；
 *   2. `conv.open` 的副本能叠帧（`seq` 连续，不重复、不倒退）；
 *   3. `conv.submit` 能提交，`conv.abort` 能中断；
 *   4. 审批请求能弹出来，答复能真的放行/拒绝。
 *
 * 调试条（seq / 重连 / 丢帧）是这一阶段的验收标准，成品界面会把它收进开发者面板。
 */
import { useCallback, useEffect, useState } from "react"

import { entryText, liveGenerationText, liveIsRunning, liveTools } from "@pi/shared-types"
import type {
  ApprovalView,
  ConversationId,
  ConversationSummary,
  HostInfo,
  HostStatus,
  ViewEntry,
} from "@pi/shared-types"

import { invoke, subscribe } from "./ipc.ts"
import { useConversation } from "./useConversation.ts"

export function App() {
  const [info, setInfo] = useState<HostInfo | undefined>()
  const [status, setStatus] = useState<HostStatus | undefined>()
  const [summaries, setSummaries] = useState<readonly ConversationSummary[]>([])
  const [selected, setSelected] = useState<ConversationId | undefined>()
  const [approvals, setApprovals] = useState<readonly ApprovalView[]>([])
  const [draft, setDraft] = useState("")
  const [error, setError] = useState<string | undefined>()

  const conversation = useConversation(selected)

  /** 启动：拿应用信息，然后把起始会话设为 root。 */
  useEffect(() => {
    void (async () => {
      try {
        const [hostInfo, hostStatus] = await Promise.all([
          invoke("app.info", {}),
          invoke("app.status", {}),
        ])
        setInfo(hostInfo)
        setStatus(hostStatus)
        setSelected(hostInfo.rootConversationId)
      } catch (cause) {
        setError(text(cause))
      }
    })()
  }, [])

  /** 宿主状态推送；没收到推送时用 `app.status` 手动刷新。 */
  useEffect(() => subscribe("host.status", setStatus), [])

  /** 会话列表：切换后刷新一次，够用。 */
  const refreshList = useCallback(async () => {
    try {
      setSummaries(await invoke("conv.list", { limit: 50 }))
    } catch (cause) {
      setError(text(cause))
    }
  }, [])

  useEffect(() => {
    void refreshList()
  }, [refreshList, selected])

  /** 审批：先拉当前全量，再跟推送。 */
  useEffect(() => {
    if (selected === undefined) return
    let active = true
    void invoke("approval.list", { conversationId: selected })
      .then((pending) => {
        if (active) setApprovals(pending)
      })
      .catch(() => {})

    const stop = subscribe("approval", (payload) => {
      if (payload.conversationId === selected) setApprovals(payload.pending)
    })
    return () => {
      active = false
      stop()
    }
  }, [selected])

  const submit = async (): Promise<void> => {
    const textValue = draft.trim()
    if (textValue === "" || selected === undefined) return
    setDraft("")
    try {
      // 调用主进程的 conv.submit 接口，提交用户输入
      await invoke("conv.submit", { conversationId: selected, text: textValue })
    } catch (cause) {
      setError(text(cause))
    }
  }

  const respond = async (id: string, approved: boolean): Promise<void> => {
    try {
      // 调用主进程的 approval.respond 接口，批准/拒绝审批请求
      await invoke("approval.respond", { id, approved })
    } catch (cause) {
      setError(text(cause))
    }
  }

  // 判断是否正在生成
  const running = conversation.snapshot !== undefined && liveIsRunning(conversation.snapshot)
  // 获取生成文本
  const liveText = conversation.snapshot === undefined ? undefined : liveGenerationText(conversation.snapshot)
  const tools = conversation.snapshot === undefined ? [] : liveTools(conversation.snapshot)

  return (
    <main className="flex min-h-full flex-col gap-4 p-6 text-sm">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-base font-semibold text-[#e6e8ef]">Pi Agent Desktop</h1>
        <span className="text-xs text-[#6b7280]">
          {info === undefined
            ? "启动中…"
            : `${info.platform} · node ${info.node}${info.electron === undefined ? "" : ` · electron ${info.electron}`}`}
        </span>
        {status === undefined ? null : (
          <span className="text-xs text-[#6b7280]">
            调度 {status.scheduling} · 任务 {status.tasks}（跑 {status.running}，卡 {status.blocked}）· 提交{" "}
            {status.submissions}
          </span>
        )}
        {info?.model === undefined ? null : (
          <span className="text-xs text-[#6b7280]">{info.model.modelId}</span>
        )}
      </header>

      {error === undefined ? null : (
        <div className="rounded border border-[#7f1d1d] bg-[#2a1417] px-3 py-2 text-xs text-[#fca5a5]">
          {error}
          <button className="ml-2 underline" onClick={() => setError(undefined)}>
            知道了
          </button>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-[200px_1fr]">
        <aside className="space-y-1">
          <div className="flex items-center justify-between">
            <h2 className="text-xs tracking-widest text-[#6b7280] uppercase">会话</h2>
            <button
              className="text-xs text-[#60a5fa]"
              onClick={() => {
                void (async () => {
                  try {
                    const created = await invoke("conv.create", {})
                    setSelected(created.conversationId)
                  } catch (cause) {
                    setError(text(cause))
                  }
                })()
              }}
            >
              新建
            </button>
          </div>
          {summaries.map((item) => (
            <button
              key={item.id}
              onClick={() => setSelected(item.id)}
              className={`block w-full rounded px-2 py-1 text-left text-xs ${
                item.id === selected ? "bg-[#1f2937] text-[#e6e8ef]" : "text-[#9aa2b1] hover:bg-[#171a22]"
              }`}
            >
              #{item.id}
              {item.busy ? " · 忙" : ""}
              {item.queued > 0 ? ` · 排队 ${String(item.queued)}` : ""}
            </button>
          ))}
        </aside>

        <section className="space-y-3">
          {/* 验收标准：seq 连续、没有丢帧、没有重连。 */}
          <div className="rounded border border-[#262b36] bg-[#12151c] px-3 py-2 font-mono text-[11px] text-[#6b7280]">
            conv #{conversation.convId ?? "—"} · status {conversation.status} · seq {conversation.seq} ·
            entries {conversation.snapshot?.entries.length ?? 0} · 重连 {conversation.resyncs} · 丢弃{" "}
            {conversation.stale}
            <button className="ml-2 text-[#60a5fa]" onClick={conversation.resync}>
              重连
            </button>
          </div>

          {approvals.length === 0 ? null : (
            <div className="space-y-2">
              {approvals.map((request) => (
                <div
                  key={request.id}
                  className="rounded border border-[#78350f] bg-[#2a1f0f] px-3 py-2 text-xs text-[#fcd34d]"
                >
                  <div className="font-mono">{request.summary}</div>
                  <div className="mt-2 flex gap-2">
                    <button
                      className="rounded bg-[#166534] px-2 py-1 text-[#dcfce7]"
                      onClick={() => void respond(request.id, true)}
                    >
                      允许
                    </button>
                    <button
                      className="rounded bg-[#7f1d1d] px-2 py-1 text-[#fee2e2]"
                      onClick={() => void respond(request.id, false)}
                    >
                      拒绝
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="min-h-[240px] space-y-2 overflow-y-auto rounded border border-[#262b36] bg-[#171a22] p-3">
            {conversation.status === "error" ? (
              <p className="text-xs text-[#fca5a5]">{conversation.error}</p>
            ) : null}
            {(conversation.snapshot?.entries ?? []).map((entry) => (
              <EntryRow key={entry.id} entry={entry} />
            ))}
            {liveText === undefined ? null : (
              <p className="whitespace-pre-wrap text-[#c7ccd8]">{liveText}</p>
            )}
            {tools.map((tool) => (
              <div key={String(tool["callId"])} className="font-mono text-[11px] text-[#6b7280]">
                [tool] {String(tool["name"])} {String(tool["status"])}
              </div>
            ))}
            {running ? <p className="text-[11px] text-[#4b5563]">生成中…</p> : null}
          </div>

          <div className="flex gap-2">
            <input
              className="flex-1 rounded border border-[#262b36] bg-[#12151c] px-3 py-2 text-[#e6e8ef] outline-none"
              placeholder="说点什么…"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault()
                  void submit()
                }
              }}
            />
            <button className="rounded bg-[#1d4ed8] px-3 py-2 text-[#e0e7ff]" onClick={() => void submit()}>
              发送
            </button>
            <button
              className="rounded border border-[#262b36] px-3 py-2 text-[#9aa2b1]"
              onClick={() => {
                if (selected === undefined) return
                void invoke("conv.abort", { conversationId: selected }).catch((cause: unknown) =>
                  setError(text(cause)),
                )
              }}
            >
              停止
            </button>
          </div>
        </section>
      </div>
    </main>
  )
}

/** 一条条目：只按 kind 决定怎么显示，内容一律当不可信文本。 */
function EntryRow({ entry }: { readonly entry: ViewEntry }) {
  const mine = entry.kind === "pi.user"
  const tool = entry.kind === "pi.tool-result"
  return (
    <div className={mine ? "text-right" : ""}>
      <div className="text-[10px] tracking-widest text-[#4b5563] uppercase">
        {mine ? "你" : tool ? "工具结果" : entry.kind === "pi.assistant" ? "助手" : entry.kind}
      </div>
      <p className={`whitespace-pre-wrap ${tool ? "font-mono text-[11px] text-[#9aa2b1]" : "text-[#c7ccd8]"}`}>
        {entryText(entry)}
      </p>
    </div>
  )
}

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
