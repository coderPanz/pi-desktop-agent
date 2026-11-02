/**
 * 执行环境工厂：每个任务用一次，按会话的 `cwd` 建一个 `NodeExecutionEnv`。
 * 说人话就是：在 pi durable 中每执行一次任务就创建一个 pi 封装好的 node 环境。
 * 
 * 不做缓存、不做单例：环境持有子进程句柄与文件监视器，跨会话复用会让「abort 后进程还在跑」这类问题
 * 变得难查。
 * `HarnessOptions.env` 本来也是「每次使用时调用」的语义。
 */
import type { Context } from "@earendil-works/chord"
import type { ExecutionEnv } from "@earendil-works/pi-durable/env"
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node" // pi 封装的 node 环境
import type { EnvTarget } from "@earendil-works/pi-durable"

// node 环境配置选项
export type NodeEnvOptions = {
  readonly workspace: string // 工作区目录
  readonly shellPath?: string // shell 路径
  readonly shellEnv?: NodeJS.ProcessEnv // shell 环境变量
}

/** 创建 node 环境 */
export function createNodeEnv(cwd: string, options: Omit<NodeEnvOptions, "workspace"> = {}): NodeExecutionEnv {
  return new NodeExecutionEnv({
    cwd,
    ...(options.shellPath === undefined ? {} : { shellPath: options.shellPath }),
    ...(options.shellEnv === undefined ? {} : { shellEnv: options.shellEnv }),
  })
}

/**
 * 给 `HarnessOptions.env` 用的工厂：`(target) => new NodeExecutionEnv({ cwd: target.cwd ?? workspace })`。
 * `target.cwd` 是会话 agent 里存的 cwd，缺省时落回工作区根。
 */
export function createNodeEnvFactory(
  options: NodeEnvOptions,
): (target: EnvTarget, context: Context) => ExecutionEnv {
  const { workspace } = options
  return (target) => createNodeEnv(target.cwd ?? workspace, options)
}
