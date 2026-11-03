import assert from "node:assert/strict"
import { test } from "node:test"

import {
  applyFrame,
  entryText,
  EntryKind,
  lastAssistantEntry,
  liveGenerationText,
  liveIsRunning,
  liveTools,
  messageContentText,
} from "./frame.ts"
import type { ViewEntry, ViewSnapshot } from "./frame.ts"
import type { JsonObject, JsonValue } from "./json.ts"
import { isJsonValue } from "./json.ts"

function snapshot(entries: readonly ViewEntry[] = [], docs: Record<string, JsonObject> = {}): ViewSnapshot {
  return { conversation: { id: 1 }, entries, docs }
}

function entry(kind: string, id: number, content: JsonValue): ViewEntry {
  return { id, conversationId: 1, kind, model: [{ role: "assistant", content }] }
}

test("entryText 只取 text 块，忽略 thinking 与图片", () => {
  const value = entry(EntryKind.assistant, 1, [
    { type: "thinking", thinking: "先想想" },
    { type: "text", text: "答案" },
    { type: "image", data: "base64", mimeType: "image/png" },
  ])
  assert.equal(entryText(value), "答案")
})

test("messageContentText 兼容字符串内容与坏数据", () => {
  assert.equal(messageContentText({ content: "纯文本" }), "纯文本")
  assert.equal(messageContentText({ content: null }), "")
  assert.equal(messageContentText(undefined), "")
  assert.equal(messageContentText("字符串不是消息"), "")
})

test("lastAssistantEntry 取最后一条回答，忽略其他 kind", () => {
  const entries = [
    entry(EntryKind.user, 1, "问"),
    entry(EntryKind.assistant, 2, "一"),
    entry(EntryKind.toolResult, 3, "结果"),
    entry(EntryKind.assistant, 9, "二"),
  ]
  assert.equal(lastAssistantEntry(entries)?.id, 9)
  assert.equal(lastAssistantEntry([entry(EntryKind.user, 1, "无回答")]), undefined)
  assert.equal(lastAssistantEntry([]), undefined)
})

test("live 三件套：正在生成的文本、忙闲、工具列表", () => {
  const streaming = snapshot([], {
    "pi.live": { run: { taskId: 1 }, generation: { message: { content: [{ type: "text", text: "生成中" }] } } },
  })
  assert.equal(liveGenerationText(streaming), "生成中")
  assert.equal(liveIsRunning(streaming), true)

  const idle = snapshot([], { "pi.live": { generation: {} } })
  assert.equal(liveGenerationText(idle), undefined)
  assert.equal(liveIsRunning(idle), false)

  const withTools = snapshot([], {
    "pi.live": { tools: [{ callId: "c1", name: "bash", status: "running" }, "坏值", 42] },
  })
  assert.deepEqual(liveTools(withTools), [{ callId: "c1", name: "bash", status: "running" }])
  assert.deepEqual(liveTools(snapshot()), [])
})

test("坏文档不抛错：pi.live 不是对象时按「没有实时状态」处理", () => {
  const broken = snapshot([], { "pi.live": 42 as unknown as JsonObject })
  assert.equal(liveGenerationText(broken), undefined)
  assert.equal(liveIsRunning(broken), false)
  assert.deepEqual(liveTools(broken), [])
})

test("applyFrame 返回新副本，不修改入参", () => {
  const before = snapshot([], {})
  const after = applyFrame(before, [["s", ["docs", "pi.live"], { generation: {} }]])

  assert.notEqual(after, before)
  assert.equal(before.docs["pi.live"], undefined)
  assert.deepEqual(after.docs["pi.live"], { generation: {} })
})

test("isJsonValue 拒绝非严格 JSON", () => {
  assert.equal(isJsonValue({ a: [1, "b", null, true] }), true)
  assert.equal(isJsonValue(Number.NaN), false)
  assert.equal(isJsonValue(undefined), false)
  assert.equal(isJsonValue({ a: () => 1 }), false)
})
