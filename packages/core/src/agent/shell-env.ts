import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { Context } from "@earendil-works/chord"
import type { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node"

// 只继承运行工具所需的变量，不把宿主的模型凭证、代理认证或解释器启动钩子交给命令。
const SHELL_ENV_KEYS = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL",
  "TMPDIR", "TMP", "TEMP", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE",
  "LC_COLLATE", "LC_MESSAGES", "LC_MONETARY", "LC_NUMERIC", "LC_TIME",
  "TERM", "COLORTERM", "TZ", "CI",
  "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT",
] as const

/**
 * 从 Finder / Dock 启动时 PATH 只有 `/usr/bin:/bin:...`，`node`、`pnpm` 往往找不到。
 * 这里按「已存在的目录」补常见安装位置，**不执行任何 rc 脚本**（那会把凭证和别名带回来）。
 * nvm / fnm 只取版本号最大的那个，与 `nvm use` 的直觉一致。
 */
const PATH_CANDIDATES = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
] as const

/** 各版本目录按版本号倒序：版本管理器常把 `pnpm` 装在某个特定版本下，只取“最新”会漏掉它。 */
function versionedBins(home: string, root: string, suffix: string): readonly string[] {
  let entries: string[]
  try {
    entries = fs.readdirSync(path.join(home, root))
  } catch {
    return []
  }
  return entries
    .filter(name => /^v?\d/.test(name))
    .sort((left, right) => compareVersions(right, left))
    .map(name => path.join(home, root, name, suffix))
}

function compareVersions(left: string, right: string): number {
  const parts = (value: string): number[] => value.replace(/^v/, "").split(/[.\-+]/).map(part => Number.parseInt(part, 10) || 0)
  const a = parts(left)
  const b = parts(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** 在已有 PATH 后面补上额外目录；只加真实存在的目录，去重并保持顺序。 */
export function augmentPath(value: string | undefined, home: string = os.homedir()): string {
  const parts = (value ?? "").split(path.delimiter).filter(part => part !== "")
  const extra = [
    ...parts,
    ...PATH_CANDIDATES,
    path.join(home, ".local/bin"),
    path.join(home, ".volta/bin"),
    path.join(home, ".bun/bin"),
    path.join(home, ".npm-global/bin"),
    path.join(home, "Library/pnpm"),
    ...versionedBins(home, ".nvm/versions/node", "bin"),
    ...versionedBins(home, ".fnm/node-versions", "installation/bin"),
    path.join(home, ".asdf/shims"),
  ]
  const seen = new Set<string>()
  const result: string[] = []
  for (const dir of extra) {
    if (seen.has(dir) || !fs.existsSync(dir)) continue
    seen.add(dir)
    result.push(dir)
  }
  return result.join(path.delimiter)
}

export function safeShellEnvironment(...sources: readonly NodeJS.ProcessEnv[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const source of sources) {
    for (const key of SHELL_ENV_KEYS) {
      const value = source[key]
      if (value !== undefined) result[key] = value
    }
  }
  return result
}

/** 即使显式关闭内核沙箱，也不应自动把宿主凭证交给 shell。 */
export function restrictShellEnvironment(
  env: NodeExecutionEnv,
  shellEnv: NodeJS.ProcessEnv = {},
): void {
  const base = safeShellEnvironment(process.env, shellEnv)
  const home = base["HOME"] ?? process.env["HOME"] ?? os.homedir()
  base["PATH"] = augmentPath(base["PATH"], home)
  const exec = env.exec.bind(env)
  env.exec = (command, options, context: Context) => exec(command, {
    ...options,
    // SDK 在 inheritEnv=true 时还会合并 process.env；仅过滤 shellEnv 不够。
    inheritEnv: false,
    env: safeShellEnvironment(options?.inheritEnv === false ? {} : base, options?.env ?? {}),
  }, context)
}
