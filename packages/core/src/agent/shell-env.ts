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
  const exec = env.exec.bind(env)
  env.exec = (command, options, context: Context) => exec(command, {
    ...options,
    // SDK 在 inheritEnv=true 时还会合并 process.env；仅过滤 shellEnv 不够。
    inheritEnv: false,
    env: safeShellEnvironment(options?.inheritEnv === false ? {} : base, options?.env ?? {}),
  }, context)
}
