/** 代码块高亮：Shiki 同步高亮 + 流式时跳过最后一块。纯渲染断言，不需要窗口。 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { MarkdownText } from "../renderer/src/components/Markdown.tsx"
import { canHighlight, highlightCode } from "../renderer/src/lib/highlight.ts"

const fence = (lang: string, code: string): string => `看代码：\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\n结束。\n`

test("认识的语言与常见别名可高亮，其余原样渲染", () => {
  for (const lang of ["ts", "tsx", "js", "json", "bash", "diff", "sh", "shell", "yml", "md"]) {
    assert.equal(canHighlight(lang), true, `${lang} 应可高亮`)
  }
  assert.equal(canHighlight("text"), false)
  assert.equal(canHighlight("brainfuck"), false)
  assert.equal(canHighlight(undefined), false)
})

test("highlightCode 产出 pre > code > span.line + 内联色，且同输入命中缓存", () => {
  const hast = highlightCode("const a: number = 1", "ts")
  assert.ok(hast !== undefined)
  const code = JSON.stringify(hast)
  assert.ok(code.includes('"tagName":"pre"'))
  assert.ok(code.includes("color:"), "token 应带内联颜色")
  assert.equal(highlightCode("const a: number = 1", "ts"), hast, "同一段代码复用缓存")
  assert.equal(highlightCode("代码", "brainfuck"), undefined, "不认识的语言不高亮")
})

test("闭合的代码块：带语言标签、复制按钮与高亮", () => {
  const html = renderToStaticMarkup(createElement(MarkdownText, { text: fence("ts", "const a: number = 1") }))
  assert.match(html, /font-mono text-\[11px\] text-tertiary">ts<\/span>/, "左上显示语言标签")
  assert.match(html, /aria-label="复制代码"/)
  assert.ok(html.includes("<span class=\"line\">"), "按行输出")
  assert.ok(html.includes("color:"), "token 带颜色")
  assert.ok(!html.includes('class="pi-stream-token'), "历史消息不做逐词进场")
})

test("别名走同一套语法；没有语言标签的块只加外壳不高亮", () => {
  const shell = renderToStaticMarkup(createElement(MarkdownText, { text: fence("sh", "echo hi") }))
  assert.match(shell, /text-tertiary">sh<\/span>/, "别名原样显示在标签上")
  assert.ok(shell.includes("color:"), "sh 落到 bash 语法上")

  const plain = renderToStaticMarkup(createElement(MarkdownText, { text: "```\nplain text\n```\n\n结束。" }))
  assert.ok(plain.includes("plain text"))
  assert.ok(plain.includes(">text</span>"), "没有语言标签时标签显示 text")
  assert.ok(!plain.includes("color:"), "没有语言标签不高亮")
})

test("流式中最后一个代码块先不高亮（未闭合的围栏不重复分词）", () => {
  const reveal = { settledBefore: 0, delayFor: () => 0 }
  const open = renderToStaticMarkup(createElement(MarkdownText, {
    text: "看代码：\n\n```ts\nconst a: number = 1\n",
    reveal,
  }))
  assert.ok(open.includes("const a: number = 1"), "代码原样显示")
  assert.ok(!open.includes("color:"), "最后一块先不上色")
  assert.match(open, /text-tertiary">ts<\/span>/, "语言标签照常显示")

  // 后面还有内容时，这一块已经闭合，可以上色
  const closed = renderToStaticMarkup(createElement(MarkdownText, {
    text: "```ts\nconst a: number = 1\n```\n\n接着说：",
    reveal,
  }))
  assert.ok(closed.includes("color:"), "不再是最后一块就上色")
  assert.ok(!closed.includes('class="pi-stream-token pi-stream-word" style="animation-delay:0ms">const'), "代码块内不做逐词进场")
})
