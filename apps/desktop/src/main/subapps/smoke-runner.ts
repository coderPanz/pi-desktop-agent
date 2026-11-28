/**
 * M1 smoke：候选 tool.mjs 在独立 Seatbelt 子进程内完成一次最小创建与调用。
 *
 * 不能把主进程的 `api.env` 当作沙箱：现有 withSandbox 只包装 exec。本模块仅在主进程
 * 写好临时文件后，通过受限 node 子进程执行不可信候选源码。
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { createNodeEnv, seatbeltAvailable } from "@pi/core"
import type { SubappSmokeResult } from "@pi/shared-types"

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_OUTPUT_BYTES = 32 * 1024
const MARKER = "__PI_SUBAPP_SMOKE__"

export type SmokeRunnerOptions = {
  timeoutMs?: number
  now?: () => number
}

const BOOTSTRAP = String.raw`
const marker = ${JSON.stringify(MARKER)}
const toolUrl = process.argv[2]
const text = value => typeof value === "string" ? value : JSON.stringify(value)
const emit = value => process.stdout.write(marker + JSON.stringify(value) + "\n")
const Type = new Proxy({}, { get: () => (...args) => ({ args }) })
const defineTool = tool => tool
const env = {
  async listDir() { return [] },
  async readTextFile() { return "" },
  async readTextLines() { return [] },
  async exists() { return false },
}
try {
  const imported = await import(toolUrl)
  if (typeof imported.default !== "function") throw new Error("tool.mjs default export 必须是 create 工厂函数。")
  const created = await imported.default({ Type, defineTool })
  if (created === null || typeof created !== "object" || Array.isArray(created)) {
    throw new Error("create 工厂必须返回 { tools, actions }。")
  }
  const { tools, actions } = created
  if (!Array.isArray(tools) || tools.length === 0) throw new Error("M1 create.tools 必须是非空数组。")
  if (actions === null || typeof actions !== "object" || Array.isArray(actions) || Object.keys(actions).length !== 0) {
    throw new Error("M1 create.actions 必须为空对象。")
  }
  for (const tool of tools) {
    if (tool === null || typeof tool !== "object" || typeof tool.name !== "string" || typeof tool.execute !== "function") {
      throw new Error("create.tools 包含无效工具定义。")
    }
  }
  await tools[0].execute({}, { env }, {})
  emit({ ok: true, tools: tools.map(tool => tool.name) })
} catch (error) {
  emit({ ok: false, error: error instanceof Error ? error.message : text(error) })
  process.exitCode = 1
}
`

function summary(output: string): string {
  const normalized = output.trim()
  return normalized.length <= 1_000 ? normalized : `${normalized.slice(0, 997)}...`
}

function markerPayload(output: string): { ok: boolean; error?: string } | undefined {
  const line = output.split("\n").reverse().find(item => item.startsWith(MARKER))
  if (line === undefined) return undefined
  try {
    return JSON.parse(line.slice(MARKER.length)) as { ok: boolean; error?: string }
  } catch {
    return undefined
  }
}

/**
 * 运行一次最小 smoke。非 macOS 或系统没有 Seatbelt 时明确返回 skipped，而不是无隔离降级执行。
 */
export async function runSubappSmoke(
  toolSource: string,
  options: SmokeRunnerOptions = {},
): Promise<SubappSmokeResult> {
  if (process.platform !== "darwin" || !seatbeltAvailable()) {
    return { status: "skipped", summary: "当前平台没有可用 Seatbelt，拒绝无隔离 smoke。" }
  }

  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const startedAt = now()
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-subapp-smoke-"))
  const workspace = path.join(root, "workspace")
  const toolFile = path.join(workspace, "tool.mjs")
  const bootstrapFile = path.join(workspace, "bootstrap.mjs")
  let env: ReturnType<typeof createNodeEnv> | undefined
  try {
    await mkdir(workspace, { recursive: true })
    await Promise.all([
      writeFile(toolFile, toolSource, { encoding: "utf8", mode: 0o600 }),
      writeFile(bootstrapFile, BOOTSTRAP, { encoding: "utf8", mode: 0o600 }),
    ])
    env = createNodeEnv(workspace, { workspace, sandbox: "seatbelt", sandboxNetwork: "deny" })
    let output = ""
    const result = await env.exec(
      [process.execPath, bootstrapFile, pathToFileURL(toolFile).href],
      {
        cwd: workspace,
        timeout: timeoutMs,
        onOutput: text => {
          if (Buffer.byteLength(output, "utf8") >= MAX_OUTPUT_BYTES) return
          const available = MAX_OUTPUT_BYTES - Buffer.byteLength(output, "utf8")
          output += Buffer.from(text, "utf8").subarray(0, available).toString("utf8")
        },
      },
      BACKGROUND_CONTEXT,
    )
    const durationMs = now() - startedAt
    const payload = markerPayload(output)
    if (!result.ok) return { status: "failed", durationMs, summary: summary(output || result.error.message) }
    if (result.value.exitCode !== 0 || payload?.ok !== true) {
      return { status: "failed", durationMs, summary: summary(payload?.error ?? (output || `子进程退出码 ${result.value.exitCode}`)) }
    }
    return { status: "passed", durationMs, summary: "最小工厂创建与首次 execute 调用成功。" }
  } catch (error) {
    return {
      status: "failed",
      durationMs: now() - startedAt,
      summary: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await env?.cleanup(BACKGROUND_CONTEXT).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
}
