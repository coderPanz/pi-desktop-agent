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