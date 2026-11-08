/** Node 侧静态渲染验收，避免为了测试把 Node 能力引入 renderer。鼠标/键盘另在 Electron 验收。 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import type { ViewSnapshot } from "@pi/shared-types"
import { App } from "../renderer/src/App.tsx"
import { ApprovalBar } from "../renderer/src/components/ApprovalBar.tsx"
import { Composer } from "../renderer/src/components/Composer.tsx"
import { MarkdownText } from "../renderer/src/components/Markdown.tsx"
import { MessageList } from "../renderer/src/components/MessageList.tsx"
import { ToolCard } from "../renderer/src/components/ToolCard.tsx"

const noop = () => {}

test("浅色工作区保留所有入口、诊断与输入的禁用状态", () => {
  const app = renderToStaticMarkup(createElement(App))
  for (const label of ["Pi Agent Desktop", "会话侧栏", "Agent 工作区", "新建", "分叉", "压缩", "重置", "副本同步状态", "重连", "停止", "发送"]) {
    assert.ok(app.includes(label), `${label} 应保留`)
  }
  const idle = renderToStaticMarkup(createElement(Composer, { disabled: false, running: false, onSend: noop, onAbort: noop }))
  assert.match(idle, /aria-label="消息输入"/)
  assert.equal((idle.match(/disabled=""/g) ?? []).length, 2, "空草稿不能发送，空闲时不能停止")
  const running = renderToStaticMarkup(createElement(Composer, { disabled: false, running: true, onSend: noop, onAbort: noop }))
  assert.equal((running.match(/disabled=""/g) ?? []).length, 1, "生成中保留停止入口")
})

test("新的消息布局仍过滤内部条目并去重流式正文，Markdown 保持转义", () => {
  const snapshot: ViewSnapshot = {
    conversation: { id: 1 },
    entries: [
      { id: 1, conversationId: 1, kind: "pi.system", model: [{ content: "SYSTEM_SHOULD_HIDE" }] },
      { id: 2, conversationId: 1, kind: "pi.assistant", model: [{ content: [] }] },
      { id: 3, conversationId: 1, kind: "pi.user", model: [{ content: "<script>UNTRUSTED_USER</script>" }] },
      { id: 4, conversationId: 1, kind: "pi.assistant", model: [{ content: "FINAL_RESPONSE" }] },
    ],
    docs: { "pi.live": { generation: { message: { content: "FINAL_RESPONSE" } } } },
  }
  const html = renderToStaticMarkup(createElement(MessageList, { snapshot, running: true, tools: [], queued: [] }))
  assert.ok(!html.includes("SYSTEM_SHOULD_HIDE"))
  assert.equal((html.match(/FINAL_RESPONSE/g) ?? []).length, 1)
  assert.ok(html.includes("&lt;script&gt;UNTRUSTED_USER&lt;/script&gt;"))
  assert.ok(!html.includes("<script>"))
  const markdown = renderToStaticMarkup(createElement(MarkdownText, { text: "## 标题\n\n| 工具 | 状态 |\n| --- | --- |\n| read | 完成 |\n\n```\nconst value = 1\n```\n\n<script>alert(1)</script>" }))
  assert.match(markdown, /<h2>标题<\/h2>/)
  assert.match(markdown, /<table/)
  assert.match(markdown, /<pre/)
  assert.ok(markdown.includes("const value = 1"))
  assert.ok(!markdown.includes("<script>"))
})

test("审批、工具错误、嵌套调用与排队内容在新视觉层中完整保留", () => {
  const approvals = renderToStaticMarkup(createElement(ApprovalBar, {
    pending: [{ id: "a1", conversationId: 1, callId: "c1", tool: "write", summary: "write: demo.md", createdAt: 1 }], onRespond: noop,
  }))
  for (const text of ["write: demo.md", "允许", "拒绝", "超时"]) assert.ok(approvals.includes(text))
  const slot = { callId: "c1", name: "write", status: "done" as const, output: "TOOL_ERROR_OUTPUT", isError: true, entryId: 5, droppedBytes: 10, droppedLines: 1, nested: [] }
  const tool = renderToStaticMarkup(createElement(ToolCard, { slot: { ...slot, nested: [{ ...slot, name: "nested-tool", callId: "nested", isError: false }] } }))
  for (const text of ["write", "已完成", "出错", "TOOL_ERROR_OUTPUT", "nested-tool", "10 字节"]) assert.ok(tool.includes(text))
  assert.match(tool, /aria-expanded="true"/)
  const queued = renderToStaticMarkup(createElement(MessageList, { snapshot: undefined, running: true, tools: [], queued: [{ id: 1, mode: "followUp", text: "QUEUED_INPUT" }] }))
  assert.ok(queued.includes("排队 1 条"))
  assert.ok(queued.includes("QUEUED_INPUT"))
})
