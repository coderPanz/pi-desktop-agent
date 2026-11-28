/**
 * 子应用安装状态机。
 *
 * 文件系统、registry 与 durable 文档没有共同事务；installer 必须按这个状态机推进，并在
 * `compensating` 阶段恢复旧 extension / 目录 / durable 记录。这里只定义无副作用的转移规则。
 */
export type SubappInstallPhase =
  | "draft"
  | "checked"
  | "smoke-passed"
  | "smoke-failed"
  | "confirmed"
  | "staged"
  | "version-written"
  | "registry-switched"
  | "durable-committed"
  | "ready"
  | "compensating"
  | "failed"

export type SubappInstallState = {
  readonly phase: SubappInstallPhase
  readonly slug: string
  readonly version?: number
  readonly previousVersion?: number
  readonly error?: string
}

const TRANSITIONS: Readonly<Record<SubappInstallPhase, readonly SubappInstallPhase[]>> = {
  draft: ["checked", "failed"],
  checked: ["smoke-passed", "smoke-failed", "failed"],
  "smoke-passed": ["confirmed", "failed"],
  "smoke-failed": ["confirmed", "failed"],
  confirmed: ["staged", "failed"],
  staged: ["version-written", "compensating", "failed"],
  "version-written": ["registry-switched", "compensating", "failed"],
  "registry-switched": ["durable-committed", "compensating", "failed"],
  "durable-committed": ["ready", "compensating", "failed"],
  ready: [],
  compensating: ["ready", "failed"],
  failed: [],
}

/** 返回下一不可变状态；非法跳转立即失败，防止 installer 漏过补偿步骤。 */
export function transitionSubappInstall(
  current: SubappInstallState,
  next: SubappInstallPhase,
  detail: Omit<SubappInstallState, "phase" | "slug"> = {},
): SubappInstallState {
  if (!TRANSITIONS[current.phase].includes(next)) {
    throw new Error(`子应用安装状态不能从 ${current.phase} 转移到 ${next}。`)
  }
  return {
    slug: current.slug,
    ...(current.version === undefined ? {} : { version: current.version }),
    ...(current.previousVersion === undefined ? {} : { previousVersion: current.previousVersion }),
    ...detail,
    phase: next,
  }
}
