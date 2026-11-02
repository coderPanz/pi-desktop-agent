/**
 * 骨架页
 *   1. Electron 加载了渲染进程（本地文件 / dev server）；
 *   2. preload 的 contextBridge 注入成功（sandbox: true 下仍然可用）；
 *   3. React 19 + Tailwind 4 的构建链路可用。
 *
 */
const bridgeResult: string = window.pi?.debug.ping() ?? "未注入（preload 未生效）"

const rows: readonly { label: string; value: string; ok: boolean }[] = [
  { label: "渲染进程", value: "React 19 + Vite + Tailwind 4", ok: true },
  { label: "preload 桥接", value: `window.pi.debug.ping() → ${bridgeResult}`, ok: bridgeResult === "pong" },
  { label: "主进程", value: "单实例锁 + 安全窗口配置已就位", ok: true },
]

const nextSteps: readonly string[] = [
  "阶段 1：watch() 帧 → applyFrame → 终端流式输出",
  "阶段 2：coding 扩展（4 工具 + 三档审批）",
  "阶段 3：SessionManager + apps/cli",
  "阶段 4：SQLite 持久化与五类崩溃恢复",
  "阶段 5：HarnessHost + IPC 契约（先跑 pnpm gate）",
]

export function App() {
  return (
    <main className="min-h-full p-8">
      <div className="mx-auto max-w-2xl">
        <p className="text-xs tracking-widest text-[#6b7280] uppercase">pi agent desktop</p>
        <h1 className="mt-2 text-2xl font-semibold text-[#e6e8ef]">骨架就绪</h1>
        <p className="mt-2 text-sm leading-relaxed text-[#9aa2b1]">
          本机 Agent 工作台：对话、工具执行、知识沉淀、界面状态全部落在可恢复的本地存储里。
          当前只搭好工程骨架，聊天界面与 Harness 从阶段 5、6 接入。
        </p>

        <section className="mt-6 overflow-hidden rounded-lg border border-[#262b36] bg-[#171a22]">
          {rows.map((row) => (
            <div
              key={row.label}
              className="flex items-start gap-3 border-b border-[#262b36] px-4 py-3 last:border-b-0"
            >
              <span className={row.ok ? "text-[#4ade80]" : "text-[#f87171]"}>{row.ok ? "✓" : "✗"}</span>
              <span className="w-28 shrink-0 text-sm text-[#9aa2b1]">{row.label}</span>
              <span className="text-sm text-[#e6e8ef]">{row.value}</span>
            </div>
          ))}
        </section>

        <section className="mt-8">
          <h2 className="text-sm font-medium text-[#9aa2b1]">接下来</h2>
          <ul className="mt-3 space-y-1.5">
            {nextSteps.map((step) => (
              <li key={step} className="text-sm text-[#c7ccd8]">
                <span className="mr-2 text-[#4b5563]">·</span>
                {step}
              </li>
            ))}
          </ul>
        </section>

        <p className="mt-8 text-xs text-[#4b5563]">
          方案与验收门见 <span className="text-[#6b7280]">docs/知识中心/技术方案.md</span>；
          施工图见 <span className="text-[#6b7280]">docs/知识中心/V1开发路线.md</span>。
        </p>
      </div>
    </main>
  )
}
