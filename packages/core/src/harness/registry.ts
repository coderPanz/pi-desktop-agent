/**
 * 注册表的安装和配置：一个进程一个 Registry，内置扩展按安装顺序装进去
 *
 * 扩展由调用方注入：core 不知道具体有哪些工具，装什么由宿主决定
 * （`apps/cli` 装 `@pi/ext-coding`，桌面主进程同理；`kb` / `toolsmith` / `smartui` 还是空包）。
 * 注册表可以边跑边改（`install` / `uninstall` 立即发布），所以自举【项目特色】工具的热替换不需要重开 Harness
 */
import { createRegistry } from "@earendil-works/pi-durable" // 创建注册表
import type { Extension, Registry, RegistrySnapshot, ToolRegistration } from "@earendil-works/pi-durable"

/** 注册表选项 */
export type RegistryOptions = {
  /** 内置扩展，按数组顺序安装。 */
  readonly extensions?: readonly Extension[]
}

/** 创建注册表 */
export function createPiRegistry(options: RegistryOptions = {}): Registry<ToolRegistration> {
  const registry = createRegistry<ToolRegistration>() // 创建注册表
  for (const extension of options.extensions ?? []) registry.install(extension) // 遍历扩展并安装在注册表中
  return registry // 返回注册表
}

/** 
 * 注册表摘要 type 
 * 给诊断与启动日志用；只含名字，不含参数 schema。 */
export type RegistrySummary = {
  readonly extensions: readonly string[] // 扩展
  readonly tools: readonly string[] // 工具
  readonly tasks: readonly string[] // 任务
}

/** 
 * 注册表摘要
 * 返回注册表的摘要信息只含名字，不含参数 schema */
export function summarizeRegistry(snapshot: RegistrySnapshot): RegistrySummary {
  return {
    extensions: snapshot.installed().map((extension) => extension.name), // 扩展
    tools: snapshot.tools().map(({ tool }) => tool.name), // 工具
    tasks: snapshot.tasks().map((task) => task.definition.name), // 任务
  }
}
