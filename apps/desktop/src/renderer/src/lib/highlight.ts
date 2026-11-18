/**
 * 聊天里代码块的高亮：Shiki（VS Code 同款 TextMate 语法）。
 *
 * 四个决定：
 * 1. 用 `createHighlighterCoreSync` + JS 正则引擎：不碰 Oniguruma 的 wasm，
 *    所以不需要给 `index.html` 的 CSP 开 `'wasm-unsafe-eval'`，也不用打包 `.wasm`；
 * 2. 高亮同步完成：`react-markdown` 走的是 `processor.runSync`，异步插件会直接抛错；
 * 3. 语言与主题静态引入，只装常见的那十几种；不认识的语言原样渲染，不报错；
 * 4. 按 `(lang, code)` 做一层小缓存：流式每 32ms 重解析一次，同一段代码不该重复分词。
 */
import { createHighlighterCoreSync } from "shiki/core"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"
import bash from "shiki/langs/bash.mjs"
import css from "shiki/langs/css.mjs"
import diff from "shiki/langs/diff.mjs"
import html from "shiki/langs/html.mjs"
import js from "shiki/langs/js.mjs"
import json from "shiki/langs/json.mjs"
import jsx from "shiki/langs/jsx.mjs"
import markdown from "shiki/langs/markdown.mjs"
import python from "shiki/langs/python.mjs"
import ts from "shiki/langs/ts.mjs"
import tsx from "shiki/langs/tsx.mjs"
import yaml from "shiki/langs/yaml.mjs"
import githubLight from "shiki/themes/github-light-default.mjs"

import type { HastNode } from "./streamReveal.ts"

const THEME = "github-light-default"

const highlighter = createHighlighterCoreSync({
  themes: [githubLight],
  langs: [ts, tsx, js, jsx, json, bash, python, html, css, yaml, markdown, diff],
  engine: createJavaScriptRegexEngine({ forgiving: true }),
  // 少一个语言/主题不该在控制台刷警告：聊天里的语言标签本来就是模型随手写的
  warnings: false,
})

/** 模型常写的别名，落到我们装了的语法上；`text` 之类的普通文本直接不高亮。 */
const ALIAS: Readonly<Record<string, string>> = {
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  shellscript: "bash",
  console: "bash",
  yml: "yaml",
  md: "markdown",
  node: "js",
  mjs: "js",
  cjs: "js",
  mts: "ts",
  cts: "ts",
}

/** `(lang, code) → hast` 的小缓存：只留最近 64 条。 */
const CACHE_LIMIT = 64
const cache = new Map<string, HastNode>()

/** 这个语言能不能高亮（已装 + 认得别名）。 */
export function canHighlight(language: string | undefined): language is string {
  if (language === undefined) return false
  return highlighter.getLoadedLanguages().includes(ALIAS[language] ?? language)
}

/** 把一段代码高亮成 hast（`pre > code > span`）；失败或语言不认识时返回 undefined，调用方原样渲染。 */
export function highlightCode(code: string, language: string): HastNode | undefined {
  if (code === "") return undefined
  const lang = ALIAS[language] ?? language
  if (!highlighter.getLoadedLanguages().includes(lang)) return undefined

  const key = `${lang}\u0000${code}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  let result: HastNode | undefined
  try {
    result = highlighter.codeToHast(code, { lang, theme: THEME }) as HastNode
  } catch {
    // 语法错误、还没写完的代码片段：不高亮也不能让消息渲染失败
    return undefined
  }

  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (oldest.done !== true) cache.delete(oldest.value)
  }
  cache.set(key, result)
  return result
}
