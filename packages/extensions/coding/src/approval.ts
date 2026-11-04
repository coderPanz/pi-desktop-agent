/**
 * 审批：策略说 `ask` 时，问用户
 *
 * 这里只管「怎么问」和「等多久」，不管问谁——终端、Electron、测试各有各的答复通道
 * 关键是**必须有超时**：Hook 里无限等待会把会话永久卡在 busy，用户点不到、也停不下来
 */

/**
 * 审批请求
 * 一条待批的调用：给人看的一句话摘要
*/
export type ApprovalRequest = {
  /** 工具名，如 `bash`。 */
  readonly tool: string
  /** 工具摘要 */
  readonly summary: string
}

/** 答复通道：返回 `true` 才执行。抛错视同拒绝。 */
export type Approver = (request: ApprovalRequest) => boolean | Promise<boolean>

/** 默认超时：120s 超时拒绝 */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000

/** 审批选项 */
export type ApprovalOptions = {
  /** 超时，默认 120s。 */
  readonly timeoutMs?: number
  /** 取消信号：会话关闭或用户中断时立刻返回拒绝，不必等到超时 */
  readonly signal?: AbortSignal | undefined
}

/**
 * 问一次用户
 * - 没有答复通道 → 拒绝（默认拒绝，不是默认放行）；
 * - 答复抛错 → 拒绝；
 * - 超时 → 拒绝；
 * - 调用被取消 → 拒绝。
 */
export async function requestApproval(
  request: ApprovalRequest,
  approver: Approver | undefined,
  options: ApprovalOptions = {},
): Promise<boolean> {
  if (approver === undefined) return false

  const signal = options.signal
  // 取消信号触发直接拒绝
  if (signal?.aborted === true) return false

  // 超时拒绝
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS)
  })

  // 取消信号触发直接拒绝
  let onAbort: (() => void) | undefined
  const cancelled = new Promise<boolean>((resolve) => {
    if (signal === undefined) return
    onAbort = () => resolve(false)
    signal.addEventListener("abort", onAbort, { once: true })
  })

  // 调用批准者
  const answered = Promise.resolve()
    .then(() => approver(request))
    .then(
      (value) => value === true, // 成功回调
      () => false, // 失败回调
    )

  try {
    return await Promise.race([answered, timedOut, cancelled])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (signal !== undefined && onAbort !== undefined) signal.removeEventListener("abort", onAbort)
  }
}
