import assert from "node:assert/strict"
import { test } from "node:test"

import type { JsonObject, OpenedView, ViewEntry, ViewFrame, ViewSnapshot } from "@pi/shared-types"
import { EntryKind } from "@pi/shared-types"

import { ConversationRenderer } from "./render.ts"

const CONV = 1

function snapshot(entries: readonly ViewEntry[] = [], docs: Record<string, JsonObject> = {}): ViewSnapshot {
  return { conversation: { id: CONV }, entries, docs }
}

function userEntry(id: number, text: string): ViewEntry {
  return {
    id,
    conversationId: CONV,
    kind: EntryKind.user,
    model: [{ role: "user", content: text }],
  }
}

function assistantEntry(id: number, text: string): ViewEntry {
  return {
    id,
    conversationId: CONV,
    kind: EntryKind.assistant,
    model: [{ role: "assistant", content: [{ type: "text", text }] }],
  }
}

/** 把「正在生成的回答」写成 `pi.live`；`run` 默认在跑。 */
function liveDocs(text: string | undefined, options: { readonly running?: boolean } = {}): JsonObject {
  const generation: JsonObject = { attempt: 1 }
  if (text !== undefined) generation["message"] = { content: [{ type: "text", text }] }
  const live: JsonObject = { generation }
  if (options.running ?? true) live["run"] = { taskId: 1, inputs: [1] }
  return live
}

function set(path: readonly (string | number)[], value: unknown): ViewFrame["ops"][number] {
  return ["s", path as unknown as readonly [string, ...string[]], value] as ViewFrame["ops"][number]
}

function frame(seq: number, ops: readonly ViewFrame["ops"][number][]): ViewFrame {
  return { convId: CONV, seq, ops }
}

function opened(value: ViewSnapshot): OpenedView {
  return { convId: CONV, seq: 0, snapshot: value }
}

function collector(): { out: { write(chunk: string): void }; text(): string } {
  const chunks: string[] = []
  return {
    out: { write: (chunk: string) => void chunks.push(chunk) },
    text: () => chunks.join(""),
  }
}

test("open 打印会话头与最后一条回答，但不计帧、不补历史帧", () => {
  const io = collector()
  const renderer = new ConversationRenderer({ out: io.out })
  renderer.open(opened(snapshot([userEntry(1, "你好"), assistantEntry(2, "在的")])))

  assert.equal(renderer.frames, 0)
  assert.equal(renderer.seq, 0)
  assert.equal(io.text(), "── 会话 #1 · 2 条历史 ──\n在的\n")
  assert.equal(renderer.text, "在的")
})

test("流式只补后缀：三帧拼出完整文本，不重复不倒退", () => {
  const io = collector()
  const renderer = new ConversationRenderer({ out: io.out })
  renderer.open(opened(snapshot()))

  renderer.apply(frame(1, [set(["docs", "pi.live"], liveDocs("你"))]))
  renderer.apply(
    frame(2, [set(["docs", "pi.live", "generation", "message", "content", 0, "text"], "你好")]),
  )
  renderer.apply(
    frame(3, [set(["docs", "pi.live", "generation", "message", "content", 0, "text"], "你好！")]),
  )

  assert.equal(renderer.frames, 3)
  assert.equal(renderer.seq, 3)
  assert.equal(renderer.text, "你好！")
  assert.equal(io.text(), "── 会话 #1 · 0 条历史 ──\n你好！")
})

test("写入库后切到最后一条回答，且不重复打印同一段文本", () => {
  const io = collector()
  const renderer = new ConversationRenderer({ out: io.out })
  renderer.open(opened(snapshot()))

  renderer.apply(frame(1, [set(["docs", "pi.live"], liveDocs("完成"))]))
  const before = io.text()

  // 生成结束：generation 与 run 都消失，同样的文本落成 pi.assistant 条目
  renderer.apply(frame(2, [set(["docs", "pi.live"], {}), set(["entries"], [assistantEntry(10, "完成")])]))

  assert.equal(renderer.text, "完成")
  assert.equal(io.text(), before)
})

test("忙但还没有文本时不把上一条回答当新的打一遍", () => {
  const io = collector()
  const renderer = new ConversationRenderer({ out: io.out })
  renderer.open(opened(snapshot([assistantEntry(2, "旧回答")])))

  // 新一轮开始：run 在跑，generation 还没有 message
  renderer.apply(
    frame(1, [
      set(["entries"], [assistantEntry(2, "旧回答"), userEntry(3, "再来一次")]),
      set(["docs", "pi.live"], liveDocs(undefined)),
    ]),
  )

  assert.equal(io.text(), "── 会话 #1 · 1 条历史 ──\n旧回答\n\n› 再来一次\n")
  assert.equal(renderer.text, "")
})

test("上游整段重写时换行重打，不做错误的后缀拼接", () => {
  const io = collector()
  const renderer = new ConversationRenderer({ out: io.out })
  renderer.open(opened(snapshot()))

  renderer.apply(frame(1, [set(["docs", "pi.live"], liveDocs("草稿"))]))
  renderer.apply(
    frame(2, [set(["docs", "pi.live", "generation", "message", "content", 0, "text"], "结论")]),
  )

  assert.equal(io.text(), "── 会话 #1 · 0 条历史 ──\n草稿\n结论")
})

test("工具状态只在变化时打一行", () => {
  const io = collector()
  const renderer = new ConversationRenderer({ out: io.out })
  renderer.open(opened(snapshot()))

  const running: JsonObject = { callId: "c1", name: "bash", status: "running" }
  renderer.apply(frame(1, [set(["docs", "pi.live"], { tools: [running] })]))
  renderer.apply(frame(2, [set(["docs", "pi.live"], { tools: [running] })]))
  renderer.apply(
    frame(3, [set(["docs", "pi.live"], { tools: [{ callId: "c1", name: "bash", status: "done" }] })]),
  )

  assert.equal(
    io.text(),
    "── 会话 #1 · 0 条历史 ──\n\n[tool] bash running\n\n[tool] bash done\n",
  )
})

test("坏文档不炸终端：pi.live 不是对象时按「没有实时状态」处理", () => {
  const io = collector()
  const renderer = new ConversationRenderer({ out: io.out })
  renderer.open(opened(snapshot([], { "pi.live": 42 as unknown as JsonObject })))

  assert.doesNotThrow(() => renderer.apply(frame(1, [set(["entries"], [])])))
  assert.equal(renderer.text, "")
})

test("traceFrames 打开时每帧打一行编号", () => {
  const io = collector()
  const renderer = new ConversationRenderer({ out: io.out, traceFrames: true })
  renderer.open(opened(snapshot()))
  renderer.apply(frame(7, []))

  assert.match(io.text(), /\[frame 7\] ops=0/)
})
