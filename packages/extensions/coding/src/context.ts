/**
 * 项目上下文：把工作区的约定与结构塞进 system prompt，让模型不用先 `list_dir` 摸索。
 *
 * 只读、可缓存：`AGENTS.md` 与 `package.json` 按 mtime 判断是否重读，顶层结构每次现列（便宜）。
 * 这里不写入任何东西——注入的是"事实"，不是"指令"，模型仍以 `read` 看到的真实文件为准。
 */
import type { ExecutionEnv } from "@earendil-works/pi-durable/env"
import type { PromptSection } from "@earendil-works/pi-durable"
import type { Context } from "@earendil-works/chord"

/** 约定文档最多注入多少字符：再长会挤占上下文，模型可以自己 `read`。 */
const AGENTS_LIMIT = 4_000
/** 顶层条目最多列多少个。 */
const ENTRY_LIMIT = 40
/** 命令列表最多展示多少条 script。 */
const SCRIPT_LIMIT = 20
/** 依赖/产物目录不列，和检索工具保持一致。 */
const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", ".cache", "out"])

type Cached = {
  readonly agentsMtime: number
  readonly pkgMtime: number
  readonly agents: string | undefined
  readonly scripts: readonly string[]
  readonly name: string | undefined
}

/** 每个工作区一份缓存；mtime 变了才重读文件。 */
const cache = new Map<string, Cached>()

async function readIfExists(env: ExecutionEnv, file: string, context: Context): Promise<{ text: string; mtimeMs: number } | undefined> {
  const info = await env.fileInfo(file, context)
  if (!info.ok || info.value.kind !== "file") return undefined
  const text = await env.readTextFile(file, context)
  if (!text.ok) return undefined
  return { text: text.value, mtimeMs: info.value.mtimeMs }
}

/** 从 package.json 里取脚本名与命令，给模型一个"这个项目怎么跑"的提示。 */
function scriptsOf(json: string): { name: string | undefined; scripts: readonly string[] } {
  try {
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed !== "object" || parsed === null) return { name: undefined, scripts: [] }
    const record = parsed as { name?: unknown; scripts?: unknown }
    const name = typeof record.name === "string" ? record.name : undefined
    const scripts = typeof record.scripts === "object" && record.scripts !== null
      ? Object.entries(record.scripts as Record<string, unknown>)
          .filter(([, value]) => typeof value === "string")
          .slice(0, SCRIPT_LIMIT)
          .map(([key, value]) => `${key}: ${(value as string).slice(0, 120)}`)
      : []
    return { name, scripts }
  } catch {
    return { name: undefined, scripts: [] }
  }
}

async function topLevel(env: ExecutionEnv, workspace: string, context: Context): Promise<readonly string[]> {
  const listed = await env.listDir(workspace, context)
  if (!listed.ok) return []
  return listed.value
    .filter(entry => !SKIP.has(entry.name))
    .slice(0, ENTRY_LIMIT)
    .map(entry => (entry.kind === "directory" ? `${entry.name}/` : entry.name))
    .sort()
}

async function render(workspace: string, env: ExecutionEnv, context: Context): Promise<string | undefined> {
  const agentsFile = `${workspace}/AGENTS.md`
  const pkgFile = `${workspace}/package.json`
  const agents = await readIfExists(env, agentsFile, context)
  const pkg = await readIfExists(env, pkgFile, context)
  const cached = cache.get(workspace)
  let entry: Cached
  if (cached !== undefined && cached.agentsMtime === (agents?.mtimeMs ?? 0) && cached.pkgMtime === (pkg?.mtimeMs ?? 0)) {
    entry = cached
  } else {
    const parsed = pkg === undefined ? { name: undefined, scripts: [] } : scriptsOf(pkg.text)
    entry = {
      agentsMtime: agents?.mtimeMs ?? 0,
      pkgMtime: pkg?.mtimeMs ?? 0,
      agents: agents?.text,
      scripts: parsed.scripts,
      name: parsed.name,
    }
    cache.set(workspace, entry)
  }

  const parts: string[] = []
  if (entry.name !== undefined) parts.push(`项目：${entry.name}`)
  if (entry.scripts.length > 0) parts.push(`可用脚本（用 bash 执行）：\n${entry.scripts.map(line => `- ${line}`).join("\n")}`)
  const entries = await topLevel(env, workspace, context)
  if (entries.length > 0) parts.push(`顶层结构：${entries.join(" ")}`)
  parts.push(await commitStyle(workspace, env, context))
  if (entry.agents !== undefined && entry.agents.trim() !== "") {
    const text = entry.agents.trim()
    parts.push(`AGENTS.md（项目约定，必要时用 read 看全文）：\n${text.length > AGENTS_LIMIT ? `${text.slice(0, AGENTS_LIMIT)}…` : text}`)
  }
  if (parts.length === 0) return undefined
  return parts.join("\n\n")
}

/**
 * 把工作区约定注入 system prompt。
 *
 * 失败一律静默（返回 undefined）：拿不到上下文不是错误，模型还可以自己 `read`。
 */
export function projectContextSection(workspace: string): PromptSection {
  return {
    key: "project",
    async render(input, context) {
      const env = input.env
      if (env === undefined) return undefined
      return await render(workspace, env, context).catch(() => undefined)
    },
  }
}
/** 提交规范的缓存（独立于文件缓存）：`git log` 每次现跑太浪费，60 秒够新。 */
const commitStyleCache = new Map<string, { readonly at: number; readonly text: string }>()
const COMMIT_STYLE_TTL_MS = 60_000
/** 扫多少条最近提交来判断风格。 */
const LOG_SAMPLE = 50
/** 判定为 Conventional Commits 的阈值：一半以上提交符合就算。 */
const CONVENTIONAL_RATIO = 0.5
/** 从规范文档里摘多少行与提交有关的说明。 */
const CONVENTION_LINES = 8

const CONVENTIONAL = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?!?: .+/

/** 我们的通用规范：项目没有自己的约定时用它。 */
const DEFAULT_STYLE = [
  "提交信息格式（项目没有自己的规范，按这个来）：",
  "- 第一行是标题，不超过 50 字，直接说明「做了什么」，结尾不加句号",
  "- 需要解释原因时，空一行再写正文，讲「为什么」而不是重复标题",
  "- 用中文；不写 emoji、不写「update」「fix bug」这类空话",
  "- 一次提交只做一件事；与本次无关的改动不要顺手带上",
].join("\n")

async function gitText(env: ExecutionEnv, workspace: string, argv: readonly string[], context: Context): Promise<string | undefined> {
  let text = ""
  const result = await env.exec([...argv], { cwd: workspace, timeout: 10, onOutput: chunk => { text += chunk } }, context)
  if (!result.ok || result.value.exitCode !== 0) return undefined
  return text
}

/** 从 CONTRIBUTING / AGENTS 里挑出与「commit」有关的行，作为项目规范摘录。 */
function commitLines(text: string): readonly string[] {
  const lines = text.split("\n").filter(line => /commit|提交/i.test(line) && line.trim() !== "")
  return lines
    .slice(0, CONVENTION_LINES)
    // 行首的列表符号由我们自己加，先剥掉原有的 `-` / `*`
    .map(line => line.trim().replace(/^[-*]\s+/, "").slice(0, 160))
}

/**
 * 探测项目的提交规范：
 * 1. 有 `commitlint` 配置 → 认为用 Conventional Commits
 * 2. 否则看最近提交的样式，符合 Conventional Commits 的过半也算
 * 3. 规范文档里提到提交的行，一并摘给模型
 * 4. 都没有 → 用我们的通用规范
 */
async function commitStyle(workspace: string, env: ExecutionEnv, context: Context): Promise<string> {
  const cached = commitStyleCache.get(workspace)
  if (cached !== undefined && Date.now() - cached.at < COMMIT_STYLE_TTL_MS) return cached.text

  const parts: string[] = []
  const lint = await Promise.all([
    env.exists(`${workspace}/commitlint.config.js`, context),
    env.exists(`${workspace}/commitlint.config.cjs`, context),
    env.exists(`${workspace}/.commitlintrc.json`, context),
    env.exists(`${workspace}/.commitlintrc.js`, context),
  ])
  const hasCommitlint = lint.some(result => result.ok && result.value)

  // 规范文档里的提交说明（AGENTS.md 正文已单独注入，这里只看 CONTRIBUTING 类文件）
  const docs = await Promise.all([
    readIfExists(env, `${workspace}/CONTRIBUTING.md`, context),
    readIfExists(env, `${workspace}/.github/CONTRIBUTING.md`, context),
    readIfExists(env, `${workspace}/COMMIT_CONVENTION.md`, context),
  ])
  const docLines = docs.flatMap(doc => (doc === undefined ? [] : commitLines(doc.text)))

  // 最近提交的样式
  const log = await gitText(env, workspace, ["git", "log", "-n", String(LOG_SAMPLE), "--pretty=%s"], context)
  const subjects = log === undefined ? [] : log.split("\n").map(line => line.trim()).filter(line => line !== "")
  const conventionalCount = subjects.filter(subject => CONVENTIONAL.test(subject)).length
  const usesConventional = hasCommitlint || (subjects.length >= 5 && conventionalCount / subjects.length >= CONVENTIONAL_RATIO)

  if (usesConventional) {
    parts.push("提交规范：Conventional Commits（`type(scope): 说明`，type 取 feat/fix/docs/refactor/test/chore 等）。")
    const sample = subjects.find(subject => CONVENTIONAL.test(subject))
    if (sample !== undefined) parts.push(`最近提交示例：${sample}`)
  }
  if (docLines.length > 0) parts.push(`项目文档里的提交要求：\n${docLines.map(line => `- ${line}`).join("\n")}`)
  if (parts.length === 0) parts.push(DEFAULT_STYLE)

  const text = parts.join("\n")
  commitStyleCache.set(workspace, { at: Date.now(), text })
  return text
}
