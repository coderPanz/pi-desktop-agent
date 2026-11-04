/**
 * 终端审批
 * 
 * 用户在审批时，在终端里输入 `y` 会同时被当成 REPL 命令。所以只有**一个**消费者（REPL 循环），
 * 审批请求和用户输入排进同一个队列，谁先到谁先处理。
 */
import type { ApprovalRequest, Approver } from "@pi/ext-coding"

/** 一个正在等人回答的审批。 */
export type PendingApproval = {
  readonly request: ApprovalRequest
  /**
   * 放行或拒绝；`false` 表示这次审批已经结束（被取消、已超时或被另一次答复结算），本次输入无效。
   * 返回布尔而不是 void：REPL 要靠它决定该不该打「已批准/已拒绝」，不然会把一次无效输入说成一次真实的拒绝。
   */
  readonly settle: (approved: boolean) => boolean
}

/** 
 * 终端交互： 收到的事件：一行输入，或一个待批请求
 * 要么是一行用户输入，要么是一个等人答复的审批请求。两种东西走同一个队列，是因为终端只有一条 stdin、只能有一个消费者
 */
export type CliEvent =
  | { readonly kind: "line"; readonly line: string }
  | ({ readonly kind: "approval" } & PendingApproval)

/**
 * 单消费者的事件队列。
 *
 * `close()` 会把所有还在等的审批结算成拒绝：输入都断了，没人能再回答它。
 * 不结算的后果是确定的：关闭时 `Scheduler.join()` 会 `abort()` 每个 invocation 再 `await invocation.done`
 * （abort 只是信号，不会强制返回），卡在钩子里的那次审批会让 `host.close()` 一直等到审批超时
 * （默认 120s）；那个没 `unref()` 的超时计时器同时还会把进程撑着。
 */
export class CliEventQueue {
  readonly #buffer: CliEvent[] = []
  // 等待者
  readonly #waiters: ((event: CliEvent | undefined) => void)[] = []
  readonly #approvals = new Set<(approved: boolean) => void>()
  #closed = false

  /** 收到一行输入（来自 readline 的 `line` 事件）。 */
  pushLine(line: string): void {
    this.#push({ kind: "line", line })
  }

  /** 登记一次审批：排进队列，等 REPL 把下一行当答复。输入已关闭时直接拒绝。 */
  requestApproval(request: ApprovalRequest): Promise<boolean> {
    if (this.#closed) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      const settle = (approved: boolean): boolean => {
        // 从集合里删掉才算“第一次答复”：删不掉说明已经结束，本次输入无效。
        if (!this.#approvals.delete(settle)) return false
        resolve(approved)
        return true
      }
      this.#approvals.add(settle)
      this.#push({ kind: "approval", request, settle })
    })
  }

  /** 取下一个事件；队列空则等到有事件；输入关闭且队列已空时返回 `undefined`。 */
  take(): Promise<CliEvent | undefined> {
    const buffered = this.#buffer.shift()
    if (buffered !== undefined) return Promise.resolve(buffered)
    if (this.#closed) return Promise.resolve(undefined)
    return new Promise<CliEvent | undefined>((resolve) => this.#waiters.push(resolve))
  }

  /** 输入结束（EOF / Ctrl+D / `rl.close()`）：未答复的审批一律拒绝，等在 `take()` 上的调用方被唤醒。 */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const settle of [...this.#approvals]) settle(false)
    this.#approvals.clear()
    for (const waiter of this.#waiters.splice(0)) waiter(undefined)
  }

  #push(event: CliEvent): void {
    const waiter = this.#waiters.shift()
    if (waiter !== undefined) {
      waiter(event)
      return
    }
    this.#buffer.push(event)
  }
}

/**
 * 造终端审批通道。
 *
 * 非交互（管道输入、`-p` 一次性模式、`pnpm smoke`）**一律拒绝**：
 * 没人能回答的问题不该假装有人回答，脚本才可能无人值守复现。
 */
export function createTerminalApprover(options: {
  readonly queue: CliEventQueue
  readonly interactive: boolean
}): Approver {
  return async (request) => {
    if (!options.interactive) return false
    return options.queue.requestApproval(request)
  }
}

/** 审批答复只认明确的肯定；空回车、`n`、其它任何输入都算拒绝。 */
export function parseApprovalAnswer(line: string): boolean {
  const answer = line.trim().toLowerCase()
  return answer === "y" || answer === "yes" || answer === "是"
}

/** 打到终端上的审批提示：一行摘要 + 一道问句。 */
export function formatApprovalPrompt(request: ApprovalRequest): string {
  return `审批请求：${request.summary}\n允许这一次执行吗？[y/N] `
}
