/**
 * 执行环境工厂
 */
import type { Context } from "@earendil-works/chord"
import type { ExecutionEnv } from "@earendil-works/pi-durable/env"
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node" // pi 封装的 node 环境
import type { EnvTarget } from "@earendil-works/pi-durable"

import { prepareSandbox, sandboxModeFromEnv, sandboxNetworkFromEnv, withSandbox } from "./sandbox.ts"
import type { SandboxMode, SandboxNetwork } from "./sandbox.ts"

// node 环境配置
export type NodeEnvOptions = {
  readonly workspace: string // 工作区目录
  readonly shellPath?: string // shell 路径
  readonly shellEnv?: NodeJS.ProcessEnv // shell 环境变量
  readonly sandbox?: SandboxMode // sandbox、不设 PI_SANDBOX，macOS 为 "seatbelt"，其它平台 "off"
  readonly sandboxNetwork?: SandboxNetwork // 沙箱网络策略，缺省默认 deny
}

/** 单建的 createNodeEnv 里可以不传 workspace  */
export type CreateNodeEnvOptions = Omit<NodeEnvOptions, "workspace"> & {
  readonly workspace?: string
}

// 创建带沙箱安全的 pi-node 环境
export function createNodeEnv(cwd: string, options: CreateNodeEnvOptions = {}): ExecutionEnv {
  /**
   * 返回一个【基于 Node 的执行环境对象】
   * 实例上的字段：
   * - id = "node:local": 本地环境身份标识-用于缓存，参考 guard.ts canonicalRoot
   * - cwd：当期工作目录
   * - shellPath：指定用哪个 shell 跑字符串命令
   * - shellEnv：额外注入给子进程的环境变量，后续可以显示的传递新增的环境变量给子进程
   * - activeChildPids = new Set()：记录当前还活着的子进程 pid
   */
  const env = new NodeExecutionEnv({
    cwd,
    ...(options.shellPath === undefined
      ? {}
      : { shellPath: options.shellPath }),
    ...(options.shellEnv === undefined ? {} : { shellEnv: options.shellEnv }),
  })

  const mode = options.sandbox ?? sandboxModeFromEnv()
  // 如果沙箱没有启用-则无需处理直接返回
  if (mode === "off") return env

  /**
   * shell 程序的可执行文件路径：/bin/bash、/bin/zsh、Windows 上的 …\Git\bin\bash.exe 这种，后续用来 spawn(shellPath, ["-c", "你的命令"])
   * why 字符串 命令时采用到 shellPath？ shell 是一个解释器，把字符串命令解析为内核能够调用的 argv 形式

   * Node 的 API，最终落到系统调用
   * spawn("/bin/bash", ["-c", "pnpm test && echo done | tee log"])
      ↓
    execve("/bin/bash", ["/bin/bash", "-c", "pnpm test && echo done | tee log"], env)
      ↓
    内核加载 /bin/bash 这个可执行文件，把这 3 个参数交给它 
   */
  const shell = options.shellPath ?? process.env["SHELL"] ?? "/bin/sh"
  // 沙箱准备
  const sandbox = prepareSandbox({
    workspace: options.workspace ?? cwd,
    network: options.sandboxNetwork ?? sandboxNetworkFromEnv(),
    shell,
  })
  // 装饰器：沙箱包裹装饰后的 pi node 执行环境
  return withSandbox(env, sandbox, shell)
}

/**
 * 创建 node 环境工厂
 */
export function createNodeEnvFactory(
  options: NodeEnvOptions,
): (target: EnvTarget, context: Context) => ExecutionEnv {
  const { workspace } = options
  return (target) => createNodeEnv(target.cwd ?? workspace, options)
}
