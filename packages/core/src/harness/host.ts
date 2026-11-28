/**
 * HarnessHost：持有 Harness / root / storage，并保证 `close()` 幂等
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { Context } from "@earendil-works/chord"
import type {
  Conversation,
  Harness,
  HarnessInspection,
  SessionEnd,
  Storage,
  TaskGraph,
} from "@earendil-works/pi-durable"
// chord 里的一种“只发布”的复制状态：不负责计算，只把外部数据源每次提交产生的新版本原样发布出去；读者可只读观测其最新版本，并按顺序收到变化通知。
import type { AttachedReplicatedState } from "@earendil-works/chord"

import { IpcError } from "@pi/shared-types"
import type { HostStatus } from "@pi/shared-types"

import { openHarness, type OpenHarnessOptions } from "./open-harness.ts"

export type HarnessHostOptions = OpenHarnessOptions & {
  readonly storage: Storage
}

export class HarnessHost {
  readonly harness: Harness // readonly： 外部可读，不可修改
  // 会话对象，会话 id 和操作会话的方法：`configure`（修改会话配置，如模型、工具等）、`submit`（提交用户输入）、`reset`（重置上下文）、`compact`（压缩上下文）、`commit`（提交会话）、`context`（获取会话上下文）
  readonly root: Conversation
  // 存储对下，包括存储 id 以及操作存储的方法
  readonly storage: Storage
  // 关闭 Harness 主机，是一个异步动作，返回值为 promsie
  readonly closed: Promise<SessionEnd>

  // 用 `#` 而非 `readonly`：外部不该读到也不该改写它。
  #closing: Promise<void> | undefined
  #available = true
  #end: SessionEnd | undefined

  private constructor(
    input: HarnessHostOptions, // HarnessHost 配置
    opened: {
      harness: Harness // Harness 实例
      root: Conversation // 会话对象
      closed: Promise<SessionEnd> // 关闭 Harness
    },
  ) {
    this.storage = input.storage
    this.harness = opened.harness
    this.root = opened.root
    // closed 要等存储与运行中的调用收尾；先同步封住入口，不能等它结算后才禁止写入。
    const stop = opened.harness.subscribeClose(() => { this.#available = false })
    this.closed = opened.closed.then(end => {
      this.#available = false
      this.#end = end
      stop()
      return end
    })
  }

  // 创建 harness 主机
  static async open(
    input: HarnessHostOptions,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<HarnessHost> {
    // opened：{ harness, root, closed }
    const opened = await openHarness(input.storage, input, context)
    return new HarnessHost(input, opened)
  }

  /** 不依赖已失效的存储，窗口重载后也能取得终态。 */
  get unavailableStatus(): HostStatus | undefined {
    if (this.#available) return undefined
    return {
      scheduling: this.#end?.reason === "failed" ? "failed" : "closing",
      tasks: 0, running: 0, blocked: 0, submissions: 0,
      ...(this.#end?.reason === "failed" ? {
        error: { code: "SESSION_FAILED" as const, message: "存储失败，运行时已停止。请重启应用以重新打开存储；不要重复执行状态不明的工具。" },
      } : {}),
    }
  }

  assertAvailable(): void {
    if (this.#available) return
    throw new IpcError("SESSION_FAILED", this.unavailableStatus?.error?.message ?? "运行时正在关闭，不能继续操作。")
  }

  close(context: Context = BACKGROUND_CONTEXT): Promise<void> {
    this.#closing ??= this.harness.close(context)
    return this.#closing
  }

  /**
   * 检查当前 Harness 的状态
   * 返回三样东西：
   * - `scheduling`：`running` / `paused` / `closing`——调度器当前是否在推进。
   * - `tasks`：正在进行的任务列表
   * - `submissions`：所有提交的任务列表
   */
  inspect(context: Context = BACKGROUND_CONTEXT): Promise<HarnessInspection> {
    return this.harness.inspect(context)
  }

  /**
   * 查当前有哪些任务活着：返回一张任务表的活视图，表变了可以订阅
   * 活着的定义：state.status !== terminal
   * pending    │ 可被调度，还没被领走                                 │ ✅   │
    ├────────────┼──────────────────────────────────────────────────┼ ✅   ┤等
    │ running    │ 已被一个任务调用占住，正在跑
   */
  taskGraph(
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<AttachedReplicatedState<TaskGraph>> {
    return this.harness.taskGraph(context)
  }
}
