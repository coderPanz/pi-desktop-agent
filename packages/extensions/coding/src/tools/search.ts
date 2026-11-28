/**
 * `grep` / `glob`：只读检索工具。
 *
 * 为什么要有它们：AI coding 里最高频的动作是「找符号、找文件」。
 * 只靠 `bash` 跑 `rg` 会把这件事塞进 shell（要审批、输出截断、还要过沙箱），
 * 而这里是纯读、可并行、`replay: safe`，失败也只返回一句原因。
 *
 * 边界：只在工作区内遍历（同一套 `PathGuard`），不跟随软链，跳过依赖与构建目录，
 * 并尽量遵守工作区根 `.gitignore`（见 `loadIgnoreRules` 的限制）。
 *
 * 性能取舍：默认字面量模式直接在整段文本上找位置、不回 slice 每一行；
 * 大文件按上限跳过。宁可少扫，也不把主进程拖死。
 */
import { defineTool } from "@earendil-works/pi-durable"
import type { ExecutionEnv } from "@earendil-works/pi-durable/env"
import type { Context } from "@earendil-works/chord"
import { Type } from "typebox"

import type { PathGuard } from "../guard.ts"
import { toolError } from "../results.ts"

/** 依赖、版本库与构建产物：进去只会拖慢搜索，命中也不是用户要的。 */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules", ".git", "dist", "out", "build", ".next", ".nuxt", ".turbo",
  "coverage", ".cache", "__pycache__", ".venv", "venv", ".idea", ".DS_Store",
])

const MAX_FILES = 5_000
const MAX_FILE_BYTES = 512 * 1024
const MAX_RESULTS = 200
const MAX_DEPTH = 12
const PREVIEW_CHARS = 200
const MAX_IGNORE_RULES = 500
/** 同时读多少个文件：读是 I/O，串行等待占了大头；并发太多又会把文件句柄与内存打满。 */
const READ_CONCURRENCY = 16

type FileEntry = { readonly absolute: string; readonly relative: string; readonly size: number }

type Rule = { readonly match: (relative: string, isDir: boolean) => boolean }

type WalkResult =
  | { readonly ok: true; readonly files: readonly FileEntry[]; readonly truncated: boolean }
  | { readonly ok: false; readonly reason: string }

/** `**\/*.ts` 这类写法转成正则：`**` 跨目录、`*` 不跨、`?` 单字符。 */
function globRegExp(pattern: string): RegExp {
  let source = ""
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index += 1
        if (pattern[index + 1] === "/") {
          index += 1
          source += "(?:.*/)?"
        } else {
          source += ".*"
        }
      } else {
        source += "[^/]*"
      }
      continue
    }
    if (char === "?") {
      source += "[^/]"
      continue
    }
    source += (char ?? "").replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${source}$`)
}

/**
 * 读工作区根的 `.gitignore`。
 *
 * 只处理常见形态：注释、空行、目录（结尾 `/`）、无斜杠的名字（任意层级按 basename 匹配）、
 * 带斜杠的锚定路径、`*` / `**` / `?`。**不支持 `!` 取反**（取反规则直接忽略，宁可多扫也不漏扫）。
 * 只读根目录这一个文件：嵌套 `.gitignore` 的规则不生效。
 */
async function loadIgnoreRules(env: ExecutionEnv, root: string, context: Context): Promise<readonly Rule[]> {
  const read = await env.readTextFile(`${root}/.gitignore`, context)
  if (!read.ok) return []
  const rules: Rule[] = []
  for (const raw of read.value.split("\n")) {
    if (rules.length >= MAX_IGNORE_RULES) break
    const line = raw.trim()
    if (line === "" || line.startsWith("#") || line.startsWith("!")) continue
    const directoryOnly = line.endsWith("/")
    const body = directoryOnly ? line.slice(0, -1) : line
    if (body === "") continue
    if (body.startsWith("/")) {
      const pattern = globRegExp(body.slice(1))
      rules.push({ match: (relative, isDir) => (!directoryOnly || isDir) && pattern.test(relative) })
      continue
    }
    if (!body.includes("/")) {
      const pattern = globRegExp(body)
      rules.push({
        match: (relative, isDir) => {
          if (directoryOnly && !isDir) return false
          const segments = relative.split("/")
          return segments.some((segment, index) => {
            if (pattern.test(segment)) return true
            // 目录规则命中某一层后，整棵子树都算被忽略
            return index < segments.length - 1 && pattern.test(segments.slice(index).join("/"))
          })
        },
      })
      continue
    }
    const pattern = globRegExp(body)
    rules.push({ match: (relative, isDir) => (!directoryOnly || isDir) && pattern.test(relative) })
  }
  return rules
}

function ignored(rules: readonly Rule[], relative: string, isDir: boolean): boolean {
  for (const rule of rules) if (rule.match(relative, isDir)) return true
  return false
}

/** 递归收集文件；跳过软链（避免走出工作区）、依赖目录与被忽略的路径，按相对路径排序保证输出稳定。 */
async function walkFiles(
  env: ExecutionEnv,
  root: string,
  context: Context,
  rules: readonly Rule[],
): Promise<WalkResult> {
  const files: FileEntry[] = []
  let truncated = false

  const visit = async (dir: string, prefix: string, depth: number): Promise<string | undefined> => {
    const listed = await env.listDir(dir, context)
    if (!listed.ok) {
      if (depth === 1) return `无法列出 ${dir}：${listed.error.message}`
      return undefined // 子目录读不了就跳过，不因为一个坏目录让整次搜索失败
    }
    for (const entry of listed.value) {
      if (files.length >= MAX_FILES) {
        truncated = true
        return undefined
      }
      if (SKIP_DIRS.has(entry.name)) continue
      const relative = `${prefix}${entry.name}`
      if (entry.kind === "directory") {
        if (depth >= MAX_DEPTH) continue
        if (ignored(rules, relative, true)) continue
        const failure = await visit(entry.path, `${relative}/`, depth + 1)
        if (failure !== undefined) return failure
        if (truncated) return undefined
        continue
      }
      if (entry.kind !== "file") continue
      if (ignored(rules, relative, false)) continue
      files.push({ absolute: entry.path, relative, size: entry.size })
    }
    return undefined
  }

  const failure = await visit(root, "", 1)
  if (failure !== undefined) return { ok: false, reason: failure }
  files.sort((left, right) => (left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0))
  return { ok: true, files, truncated }
}

/** 二进制判定：出现 NUL 就当作二进制，不喂给模型。 */
function looksBinary(text: string): boolean {
  return text.includes("\u0000")
}

function clip(text: string): string {
  const trimmed = text.replace(/\s+$/, "")
  return trimmed.length > PREVIEW_CHARS ? `${trimmed.slice(0, PREVIEW_CHARS)}…` : trimmed
}

function lineStart(text: string, index: number): number {
  return text.lastIndexOf("\n", index - 1) + 1
}

/** 字面量搜索：在整段文本上找位置，只对命中行取 slice，避免给每一行分配字符串。 */
function scanLiteral(
  text: string,
  needle: string,
  caseSensitive: boolean,
  onMatch: (lineNumber: number, line: string) => boolean,
): void {
  const haystack = caseSensitive ? text : text.toLowerCase()
  const target = caseSensitive ? needle : needle.toLowerCase()
  let from = 0
  let lineNumber = 0
  let counted = 0
  while (from <= haystack.length) {
    const hit = haystack.indexOf(target, from)
    if (hit === -1) return
    // 只数到命中位置所在行；每命中一次往前推进，整体是线性扫描
    lineNumber += countNewlines(text, counted, hit)
    counted = hit
    const start = lineStart(text, hit)
    const newline = text.indexOf("\n", hit)
    const end = newline === -1 ? text.length : newline
    if (!onMatch(lineNumber + 1, text.slice(start, end))) return
    // 同一行只报一次，与正则模式一致；跳到行尾继续
    if (newline === -1) return
    from = newline + 1
  }
}

function countNewlines(text: string, from: number, to: number): number {
  let count = 0
  let index = text.indexOf("\n", from)
  while (index !== -1 && index < to) {
    count += 1
    index = text.indexOf("\n", index + 1)
  }
  return count
}

/** 正则搜索：逐行取文本（正则必须拿到整行）。 */
function scanRegExp(
  text: string,
  matcher: RegExp,
  onMatch: (lineNumber: number, line: string) => boolean,
): void {
  let start = 0
  let lineNumber = 1
  while (start <= text.length) {
    const newline = text.indexOf("\n", start)
    const end = newline === -1 ? text.length : newline
    const line = text.slice(start, end)
    if (matcher.test(line) && !onMatch(lineNumber, line)) return
    if (newline === -1) return
    start = newline + 1
    lineNumber += 1
  }
}

const grepSchema = Type.Object({
  pattern: Type.String({ description: "要查找的内容；默认按子串匹配。" }),
  path: Type.Optional(Type.String({ description: "搜索起点，相对工作区根；默认整个工作区。" })),
  glob: Type.Optional(Type.String({ description: "只搜匹配的文件，如 **/*.ts。" })),
  regex: Type.Optional(Type.Boolean({ description: "把 pattern 当正则（默认按字面子串）。" })),
  caseSensitive: Type.Optional(Type.Boolean({ description: "区分大小写，默认否。" })),
})

const globSchema = Type.Object({
  pattern: Type.String({ description: "文件通配符，支持 ** 与 *，如 **/*.test.ts。" }),
  path: Type.Optional(Type.String({ description: "搜索起点，相对工作区根；默认整个工作区。" })),
})

export function createGrepTool(options: { readonly guard: PathGuard }) {
  const { guard } = options
  return defineTool({
    name: "grep",
    description:
      `在工作区里按内容搜索，输出「路径:行号: 内容」，最多 ${String(MAX_RESULTS)} 条。` +
      "默认按字面子串匹配，`regex: true` 用正则；跳过依赖/构建目录、被根 `.gitignore` 忽略的文件、二进制与超大文件。",
    parameters: grepSchema,
    replay: "safe",
    async execute(args, api, context) {
      const env = api.env
      if (env === undefined) return toolError("no_environment", "没有可用的执行环境，无法搜索。")
      const requested = args.path ?? "."
      const verdict = await guard(requested, env, context)
      if (!verdict.ok) return toolError("path_outside_workspace", verdict.reason)

      const pattern = args.pattern
      if (pattern === "") return toolError("invalid_arguments", "pattern 不能为空。")
      const caseSensitive = args.caseSensitive === true
      let matcher: RegExp | undefined
      if (args.regex === true) {
        try {
          matcher = new RegExp(pattern, caseSensitive ? "" : "i")
        } catch (error) {
          return toolError("invalid_arguments", `正则无效：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      const fileFilter = args.glob === undefined ? undefined : globRegExp(args.glob)
      const rules = await loadIgnoreRules(env, verdict.absolute, context)
      const walked = await walkFiles(env, verdict.absolute, context, rules)
      if (!walked.ok) return toolError("search_failed", walked.reason)

      const lines: string[] = []
      let searched = 0
      let hits = 0
      const record = (relative: string) => (lineNumber: number, line: string): boolean => {
        hits += 1
        lines.push(`${relative}:${String(lineNumber)}: ${clip(line)}`)
        return hits < MAX_RESULTS
      }

      const candidates = walked.files.filter(file =>
        (fileFilter === undefined || fileFilter.test(file.relative)) && file.size <= MAX_FILE_BYTES)

      // 分批并发读、按原顺序扫描：顺序保持不变，结果仍然确定。
      for (let start = 0; start < candidates.length; start += READ_CONCURRENCY) {
        if (hits >= MAX_RESULTS) break
        const batch = candidates.slice(start, start + READ_CONCURRENCY)
        const contents = await Promise.all(batch.map(async file => {
          const read = await env.readTextFile(file.absolute, context)
          return read.ok ? read.value : undefined
        }))
        for (const [index, text] of contents.entries()) {
          if (hits >= MAX_RESULTS) break
          const file = batch[index]
          if (text === undefined || file === undefined) continue
          if (looksBinary(text)) continue
          searched += 1
          if (matcher === undefined) scanLiteral(text, pattern, caseSensitive, record(file.relative))
          else scanRegExp(text, matcher, record(file.relative))
        }
      }

      const diagnostics = [{ severity: "info" as const, code: "search_stats", message: `扫描 ${String(searched)} 个文件，命中 ${String(hits)} 行。` }]
      if (walked.truncated) {
        diagnostics.push({ severity: "info", code: "truncated", message: `只扫描前 ${String(MAX_FILES)} 个文件；缩小 path 或加 glob 更准。` })
      }
      if (hits >= MAX_RESULTS) {
        diagnostics.push({ severity: "info", code: "truncated", message: `只返回前 ${String(MAX_RESULTS)} 条命中。` })
      }
      return {
        output: [{ type: "text" as const, text: lines.length === 0 ? "（没有匹配）" : lines.join("\n") }],
        diagnostics,
      }
    },
  })
}

export function createGlobTool(options: { readonly guard: PathGuard }) {
  const { guard } = options
  return defineTool({
    name: "glob",
    description:
      `按路径通配符找文件，返回工作区相对路径（按字母序，最多 ${String(MAX_RESULTS)} 条）。` +
      "支持 `**`（跨目录）与 `*`（不跨目录），例如 `**/*.ts`、`src/**/*.tsx`；跳过依赖/构建目录与被根 `.gitignore` 忽略的文件。",
    parameters: globSchema,
    replay: "safe",
    async execute(args, api, context) {
      const env = api.env
      if (env === undefined) return toolError("no_environment", "没有可用的执行环境，无法查找文件。")
      const requested = args.path ?? "."
      const verdict = await guard(requested, env, context)
      if (!verdict.ok) return toolError("path_outside_workspace", verdict.reason)

      const pattern = args.pattern
      if (pattern === "") return toolError("invalid_arguments", "pattern 不能为空。")
      const matcher = globRegExp(pattern)

      const rules = await loadIgnoreRules(env, verdict.absolute, context)
      const walked = await walkFiles(env, verdict.absolute, context, rules)
      if (!walked.ok) return toolError("search_failed", walked.reason)

      const matched = walked.files
        .map(file => file.relative)
        .filter(relative => matcher.test(relative))
        .slice(0, MAX_RESULTS)

      const diagnostics = [{ severity: "info" as const, code: "search_stats", message: `遍历 ${String(walked.files.length)} 个文件，匹配 ${String(matched.length)} 个。` }]
      if (walked.truncated) {
        diagnostics.push({ severity: "info", code: "truncated", message: `只遍历前 ${String(MAX_FILES)} 个文件。` })
      }
      return {
        output: [{ type: "text" as const, text: matched.length === 0 ? "（没有匹配的文件）" : matched.join("\n") }],
        diagnostics,
      }
    },
  })
}