/** 流式进场的切词与 hast 标记是纯函数，直接在 Node 里验收；DOM 复用与动画曲线另在 Electron 里看。 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { MarkdownText } from "../renderer/src/components/Markdown.tsx"
import { rehypeStreamReveal, revealTokens, safeCut, REVEAL_TOKEN_CLASS, REVEAL_WORD_CLASS } from "../renderer/src/lib/streamReveal.ts"
import type { HastNode } from "../renderer/src/lib/streamReveal.ts"

function paragraph(value: string): HastNode {
  return { type: "root", children: [{ type: "element", tagName: "p", properties: {}, children: [{ type: "text", value }] }] }
}

function classes(node: HastNode): readonly string[] {
  const value = node.properties?.["className"]
  return Array.isArray(value) ? (value as readonly string[]) : []
}

function collect(node: HastNode, tagName: string, out: HastNode[] = []): readonly HastNode[] {
  if (node.tagName === tagName) out.push(node)
  for (const child of node.children ?? []) collect(child, tagName, out)
  return out
}

function text(node: HastNode): string {
  if (node.type === "text") return node.value ?? ""
  return (node.children ?? []).map(text).join("")
}

test("中文按字切、英文按词切，空白原样保留", () => {
  assert.deepEqual(
    revealTokens("你好 world  again").map(token => [token.kind, token.text, token.start]),
    [
      ["word", "你", 0],
      ["word", "好", 1],
      ["space", " ", 2],
      ["word", "world", 3],
      ["space", "  ", 8],
      ["word", "again", 10],
    ],
  )
})

test("偏移从上游接续，空白也带位置（延迟靠它排序）", () => {
  const tokens = revealTokens("ab c", 100)
  assert.deepEqual(tokens.filter(token => token.kind === "word").map(token => token.start), [100, 103])
  assert.deepEqual(tokens.filter(token => token.kind === "space").map(token => token.start), [102])
})

test("揭示切割不劈开代理对", () => {
  const text = "a😀b"
  assert.equal(safeCut(text, 0), 0)
  assert.equal(safeCut(text, 1), 1, "正好切在 emoji 前")
  assert.equal(safeCut(text, 2), 1, "切在 emoji 中间时退回一格")
  assert.equal(safeCut(text, 4), 4)
  assert.equal(safeCut(text, 99), 4)
  assert.equal(text.slice(0, safeCut(text, 2)), "a")
})

test("文本节点被切成词级 span，且不丢字符", () => {
  const tree = paragraph("开始 加粗 收束")
  rehypeStreamReveal({ settledBefore: 0, delayFor: () => 0 })(tree)
  const spans = collect(tree, "span")
  assert.equal(spans.length, 6)
  assert.deepEqual(classes(spans[0] as HastNode), [REVEAL_TOKEN_CLASS, REVEAL_WORD_CLASS])
  assert.equal(text(tree), "开始 加粗 收束")
})

test("落定边界之前的词保留 span 但不再带动画类（结构不随落定变化）", () => {
  const tree = paragraph("你好世界")
  rehypeStreamReveal({ settledBefore: 2, delayFor: () => 0 })(tree)
  const spans = collect(tree, "span")
  assert.equal(spans.length, 4, "落定后仍是 4 个 span：摘掉的只是动画类")
  assert.equal(spans.filter(span => classes(span).includes(REVEAL_WORD_CLASS)).length, 2)
  assert.equal(text(tree), "你好世界")
})

test("代码块（行内与围栏）不做逐词进场", () => {
  const tree: HastNode = {
    type: "root",
    children: [
      { type: "element", tagName: "p", properties: {}, children: [{ type: "element", tagName: "code", properties: {}, children: [{ type: "text", value: "const a = 1" }] }] },
      { type: "element", tagName: "pre", properties: {}, children: [{ type: "element", tagName: "code", properties: {}, children: [{ type: "text", value: "let b = 2" }] }] },
    ],
  }
  rehypeStreamReveal({ settledBefore: 0, delayFor: () => 0 })(tree)
  assert.equal(collect(tree, "span").length, 0)
  assert.equal(text(tree), "const a = 1let b = 2")
})

test("错开延迟由 delayFor 提供，落在 style 上给 CSS 消费", () => {
  const tree = paragraph("一 二")
  rehypeStreamReveal({ settledBefore: 0, delayFor: start => start * 10 })(tree)
  const spans = collect(tree, "span")
  assert.equal(spans[0]?.properties?.["style"], "animation-delay:0ms")
  assert.equal(spans[1]?.properties?.["style"], "animation-delay:20ms")
})

test("真实 Markdown 渲染：标题/列表/表格逐词进场，代码块与历史消息保持原样", () => {
  const reveal = { settledBefore: 0, delayFor: () => 0 }
  const live = renderToStaticMarkup(createElement(MarkdownText, {
    text: "## 标题\n\n- 第一项\n\n```ts\nconst a = 1\n```\n\n| 列 | 值 |\n| --- | --- |\n| a | 1 |\n",
    reveal,
  }))
  for (const tag of ["<h2>", "<ul", "<table", "<pre"]) assert.ok(live.includes(tag), `${tag} 应照常渲染`)
  assert.match(live, /<span class="pi-stream-token pi-stream-word" style="animation-delay:0ms">标<\/span><span class="pi-stream-token pi-stream-word" style="animation-delay:0ms">题<\/span>/)
  // 代码块交给 Shiki 上色，但整块不参与逐词进场
  assert.match(live, /<code class="language-ts">/)
  assert.ok(live.includes("color:"), "代码块应带高亮")
  const codeBlock = live.slice(live.indexOf("<pre"), live.indexOf("</pre>"))
  assert.ok(!codeBlock.includes(REVEAL_TOKEN_CLASS), "代码块里不套进场 span")

  const settled = renderToStaticMarkup(createElement(MarkdownText, { text: "你好 world", reveal: { settledBefore: 999, delayFor: () => 0 } }))
  assert.ok(!settled.includes(REVEAL_WORD_CLASS), "整段落定后不再有动画类")
  assert.ok(settled.includes(REVEAL_TOKEN_CLASS), "span 结构保留，落定不改变排版")

  const committed = renderToStaticMarkup(createElement(MarkdownText, { text: "你好 **world**" }))
  assert.equal(committed.includes(REVEAL_TOKEN_CLASS), false, "历史消息不带进场标记")
})
