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

import { openHarness, type OpenHarnessOptions } from "./open-harness.ts"

export type HarnessHostOptions = OpenHarnessOptions & {
  readonly storage: Storage
}

export class HarnessHost {
  readonly harness: Harness // readonly： 外部可读，不可修改
  readonly root: Conversation
  readonly storage: Storage
  readonly closed: Promise<SessionEnd>

  /**
   * 关闭状态机：`undefined` = 还没人关过；一旦赋值就是“那一次关闭”的 promise。
   * 用 `#` 而非 `readonly`：外部不该读到也不该改写它，否则幂等假不了。
   */
  #closing: Promise<void> | undefined

  private constructor(
    input: HarnessHostOptions,
    opened: {
      harness: Harness
      root: Conversation
      closed: Promise<SessionEnd>
    },
  ) {
    this.storage = input.storage
    this.harness = opened.harness
    this.root = opened.root
    this.closed = opened.closed
  }

  static async open(
    input: HarnessHostOptions,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<HarnessHost> {
    const opened = await openHarness(input.storage, input, context)
    return new HarnessHost(input, opened)
  }

  /**
   * 幂等关闭：**多次调用 = 调用一次**。关闭开始后，`finally`、`SIGINT`、重复的 `close()` 拿到的都是
   * **同一个 promise**（引用相等，可以放心多处 `await`）
   *
   * `this.#closing ??= …` 是「逻辑空值赋值」，等价于：
   *
   * ```ts
   * if (this.#closing === undefined || this.#closing === null) {
   *   this.#closing = this.harness.close(context)
   * }
   * return this.#closing
   * ```
   */
  close(context: Context = BACKGROUND_CONTEXT): Promise<void> {
    this.#closing ??= this.harness.close(context)
    return this.#closing
  }

  /**
   * 一次性快照：问一句“现在系统到底什么状态、有没有卡住”，拿一份普通 JSON 就走。
   * 返回三样东西：
   *
   * - `scheduling`：`running` / `paused` / `closing`——调度器当前是否在推进。
   * - `tasks`：每个**未完成**任务一条
   *
   * 真实输出（提交一句“hi”、任务刚建立时）：
   *
   * ```jsonc
   * {
   *   "scheduling": "running",
   *   "tasks": [{
   *     "record": {
   *       "id": 9, "conversationId": 1, "kind": "pi.generation", "version": 1,
   *       "input": {}, "background": false, "abortRequested": false,
   *       "state": { "status": "pending", "checkpoint": { "phase": "prepare", "attempt": 1 } },
   *     },
   *     "state": { "kind": "ready", "migrates": false }, // 调度视角：排队中，下一轮就跑
   *   }],
   *   "submissions": [
   *     { "id": 8, "conversationId": 1, "type": "input", "status": "placed", "entry": 7 },
   *   ]
   * }
   * ```
   *
   * 和 `taskGraph()` 的区别：
   *
   * | | `inspect()` | `taskGraph()` |
   * |---|---|---|
   * | 形态 | 一次性快照，不能订阅 | 活视图，可 `.subscribe()` |
   * | 适用 | 启动自检、卡住排障、健康检查 | 实时任务面板 |
   * | 独有 | 调度判断 `state.kind`、排队中的 `submissions`、`restarts` | 能持续跟变化；用完必须 `.dispose()` |
   *
   * 注意：`record` 里带 `input` 与 `checkpoint`，**可能有内容**（如工具参数），要给人看或写日志请先挑字段——
   * 本项目就是这么做的：`diagnostics/inspect.ts` 的 `inspectHarness()` 把它投影成脱敏摘要（不带 input、参数、模型消息）。
   *
   * 只读：不写库、不跑任务代码、不改任何状态。
   */
  inspect(context: Context = BACKGROUND_CONTEXT): Promise<HarnessInspection> {
    return this.harness.inspect(context)
  }

  /**
   * 查当前有哪些任务活着：返回一张任务表的活视图，表变了可以订阅
   *
   * 这里的“任务”指会暂停/恢复/有中间状态的活，本项目里只有三种：`pi.generation`（一轮请求模型并收回答）、
   * `pi.tool`（一次工具调用）、`pi.compaction`（压缩历史）。它们的生命周期存在库里，所以进程崩了能接着干。
   *
   * 表长这样（真实输出）：
   *
   * ```jsonc
   * { "tasks": {
   *   "9": {
   *     "id": 9,
   *     "kind": "pi.generation",    // 什么活
   *     "conversationId": 1,         // 属于哪个对话
   *     "background": false,         // 后台活，不挡用户
   *     "abortRequested": false,     // 用户点了停止
   *     "state": { "status": "pending", "phase": "prepare" },
   *     "conversations": [],         // 它自己开的子对话
   *   },
   * } }
   * ```
   */
  taskGraph(
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<AttachedReplicatedState<TaskGraph>> {
    return this.harness.taskGraph(context)
  }
}
