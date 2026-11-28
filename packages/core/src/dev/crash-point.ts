/**
 * 开发排障用的故障注入开关：手动确认强杀后的恢复行为
 * pi-durable 的重要能力是：程序在执行中崩溃后，重新打开 Storage 仍能继续未完成的工作
 * 真实崩溃很难稳定复现，所以在关键位置调用 `crashPoint("...")`：
 * - 平常没有配置时，它立即返回，对正常运行没有影响；
 * - 用环境变量 `PI_CRASH_POINT=after-submit` 启动时，执行到同名位置会立刻杀掉整个 Node 进程；
 * - 清除该变量后重新启动进程，手动检查已提交数据和待恢复任务
 *
 * 用 SIGKILL，而不是 process.exit()：SIGKILL 不给 finally、exit 回调或 Storage 清理/补写的机会，
 * 才接近断电、进程被系统强杀等“突然中断”的场景。
 */
/**
 * 允许注入崩溃的几个位置名称。
 * 名称只是一份约定；真正在哪一行崩溃，取决于业务代码把 `crashPoint(名称)` 放在哪里。
 */
export const CRASH_POINTS = [
  "after-submit", // 输入已被接收/提交后
  "during-tool", // 工具副作用完成，但结果尚未提交时
  "after-tool-result", // 工具结果已写入后
  "mid-generation", // 模型回答还在流式生成时
  "between-phases", // 一个 task phase 结束、下一个 phase 尚未开始时
] as const // as const 这个数组是【只读常量数组】，里面的值永远不会变，保留每一个元素的字面量类型

/**
 * `T[number]` 是【索引访问类型】：如果 `T` 是只读元组 / 数组类型，`T[number]` 代表：取出数组里所有元素的类型，合并成联合类型
 */
export type CrashPointName = (typeof CRASH_POINTS)[number]

/**
 * 配置的崩溃检查点
 */
export function configuredCrashPoint(env: NodeJS.ProcessEnv = process.env): CrashPointName | undefined {
  const value = env.PI_CRASH_POINT?.trim()
  if (value === undefined || value === "") return undefined
  const point = CRASH_POINTS.find(point => point === value)
  if (point === undefined) throw new Error(`未知 PI_CRASH_POINT：${value}`)
  return point
}

/**
 * 到达一个检查点时调用
 * 只有环境变量值与 `name` 完全相等才会杀进程
 */
export function crashPoint(name: CrashPointName): void {
  if (configuredCrashPoint() !== name) return
  // process.pid 是当前 Node 进程的编号；SIGKILL 不能被捕获或清理，进程立刻结束。
  process.kill(process.pid, "SIGKILL")
}
