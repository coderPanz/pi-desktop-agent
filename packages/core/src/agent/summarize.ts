/**
 * 侧栏标题：取第一条用户消息，超过 `TITLE_MAX_CHARS` 字就让模型压成 10 字以内。
 *
 * 为什么不用会话里的 AI 回答/主题句：第一条用户消息就是会话的名字，
 * 短就直接用（一个字的模型都不用花），长才花钱压一次，结果落盘（`app.title`）不重复问。
 * 压的时候保持原文语言：中文问句给中文标题，英文问句给英文标题，不做翻译。
 */
import type { Models } from "@earendil-works/pi-ai"

import { pickModel } from "../agent/models.ts"

/** 标题最多几个字（按 code point 算，emoji / 生僻字不会被劈开）。 */
export const TITLE_MAX_CHARS = 10

/** 后台摘要：一行输入，返回压好的标题；失败就返回 undefined，界面继续用截断后的原文。 */
export type SummarizeTitle = (text: string) => Promise<string | undefined>

/** 字数（code point），不是 UTF-16 长度。 */
export function countChars(text: string): number {
  return [...text].length
}

/** 压成一行：去掉换行/多余空白，截到 `max` 字，截断了加省略号。 */
export function clipTitle(text: string, max = TITLE_MAX_CHARS): string {
  const flat = text.replace(/\s+/gu, " ").trim()
  const chars = [...flat]
  if (chars.length <= max) return flat
  return `${chars.slice(0, max).join("")}…`
}

/** 模型常带的包装：引号、`标题：`、列表前缀、句末标点。 */
export function cleanTitle(text: string, max = TITLE_MAX_CHARS): string | undefined {
  const line = (text.split("\n").find(item => item.trim() !== "") ?? "")
    .replace(/^\s*(?:[-*#>]|\d+[.)、])\s*/u, "")
    .replace(/^\s*(?:标题|title)\s*[:：]\s*/iu, "")
    .replace(/^["'“”‘’《「『]+|["'“”‘’》」』]+$/gu, "")
    .replace(/[。！？!?.,;；:：、\s]+$/u, "")
    .trim()
  if (line === "") return undefined
  return clipTitle(line, max)
}

/**
 * 用当前配置的模型压一次标题。
 *
 * 不重试、不流式：这是后台锦上添花的一步，失败就静默放弃（调用方保留截断后的原文）。
 */
export function createTitleSummarizer(resolveModels: () => Models): SummarizeTitle {
  return async text => {
    try {
      const models = resolveModels()
      const model = await pickModel(models)
      const message = await models.completeSimple(model, {
        messages: [
          {
            role: "user",
            content:
              `把下面这条需求压成一个不超过 ${String(TITLE_MAX_CHARS)} 个字的标题，` +
              "**使用与原文相同的语言**（原文是英文就用英文，别翻译成中文）。\n" +
              "只输出标题本身：不要引号、不要句号、不要解释、不要换行。\n\n" +
              text.slice(0, 2000),
            timestamp: Date.now(),
          },
        ],
      })
      const answer = message.content
        .map(block => (block.type === "text" ? block.text : ""))
        .join("")
      return cleanTitle(answer)
    } catch {
      // 没配模型、网络失败、被 abort：都不该让会话列表报错
      return undefined
    }
  }
}
