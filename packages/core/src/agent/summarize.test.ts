/** 侧栏标题的纯函数：字数按 code point 算、截断加省略号、模型输出清洗。 */
import assert from "node:assert/strict"
import { test } from "node:test"

import { cleanTitle, clipTitle, countChars, TITLE_MAX_CHARS } from "./summarize.ts"

test("字数按 code point 算：emoji 与生僻字不被劈开", () => {
  assert.equal(countChars("部署脚本排查"), 6)
  assert.equal(countChars("😀😀"), 2)
  assert.equal(countChars("𠀀𠀁"), 2)
})

test("截断：不超过上限原样返回，超过才加省略号", () => {
  assert.equal(TITLE_MAX_CHARS, 10)
  assert.equal(clipTitle("短标题"), "短标题")
  assert.equal(clipTitle("一二三四五六七八九十"), "一二三四五六七八九十")
  assert.equal(clipTitle("一二三四五六七八九十一"), "一二三四五六七八九十…")
  // 多行压成一行
  assert.equal(clipTitle("第一行\n第二行"), "第一行 第二行")
})

test("清洗模型输出：去引号、去前缀、去句末标点、只取第一行", () => {
  assert.equal(cleanTitle("「部署脚本排查」"), "部署脚本排查")
  assert.equal(cleanTitle("标题：部署脚本排查。"), "部署脚本排查")
  assert.equal(cleanTitle('- "登录失败排查"'), "登录失败排查")
  assert.equal(cleanTitle("1. 接口超时排查\n解释：……"), "接口超时排查")
  assert.equal(cleanTitle("   "), undefined)
  assert.equal(cleanTitle("一二三四五六七八九十一二"), "一二三四五六七八九十…")
})

test("摘要提示词要求保持原文语言，不翻译成中文", async () => {
  const { createTitleSummarizer } = await import("./summarize.ts")
  let prompt = ""
  const models = {
    getAvailable: async () => [{ id: "m", api: "anthropic-messages", provider: "p", baseUrl: "", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 1000, maxTokens: 100 }],
    completeSimple: async (_model: unknown, context: { messages: readonly { content: unknown }[] }) => {
      prompt = String(context.messages[0]?.content ?? "")
      return { role: "assistant", content: [{ type: "text", text: '"deploy scripts"' }], api: "anthropic-messages", provider: "p", model: "m", timestamp: 0, usage: {} }
    },
  }
  const summarize = createTitleSummarizer(() => models as never)
  const title = await summarize("please fix the deploy script that keeps timing out")
  assert.equal(title, "deploy scr…", "英文输入给英文标题")
  assert.ok(prompt.includes("相同的语言"), "提示词要求同语言")
  assert.ok(!prompt.includes("中文标题"), "不再强制中文")
})
