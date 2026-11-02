/**
 * 诊断摘要：把 `harness.inspect()` 的结果，压成「能给人看、能写日志」的小 JSON。
 */
import type { Context } from "@earendil-works/chord"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type {
  Harness,
  HarnessInspection,
  SubmissionRecord,
  TaskInspection,
} from "@earendil-works/pi-durable"

/** 一条未完成任务的摘要（已结束的任务不会出现在这里）。 */
export type TaskSummary = {
  readonly id: number
  readonly kind: string
  readonly conversationId: number
  /** 任务自己记的状态：pending / running / waiting / sleeping / completing / terminal。 */
  readonly status: TaskInspection["record"]["state"]["status"]
  /** 调度器打算怎么处理它：running（在跑）/ ready（排队，下一轮就轮到）/ waiting（等别的任务）/ sleeping（睡觉）/ completing（等子活收尾）/ blocked（跑不了）。 */
  readonly scheduling: TaskInspection["state"]["kind"]
  /** 后台任务：不挡用户，关窗口也照跑。 */
  readonly background: boolean
  /** 连续被崩溃/重启打断过几次（到上限就会被停靠，可用 `retryTask()` 再踢一脚）。 */
  readonly restarts: number
  /** 只有 `scheduling` 为 `blocked` 时才出现，说明为什么不动了。 */
  readonly blockedReason?: string
}

/** 一条还没结算的提交（队列里排着的输入之类）。 */
export type SubmissionSummary = {
  readonly id: number
  readonly conversationId: number
  readonly type: SubmissionRecord["type"]
  /** `queued` 已收下、还没进记录；`placed` 已进记录、正被某次运行处理。 */
  readonly status: SubmissionRecord["status"]
}

/** 一份诊断摘要。 */
export type InspectionSummary = {
  /** 调度器状态：running（在推进）/ paused（停了）/ closing（正在关）。 */
  readonly scheduling: HarnessInspection["scheduling"]
  readonly counts: {
    /** 未完成任务总数。 */
    readonly tasks: number
    readonly running: number
    readonly blocked: number
    /** 未结算提交数。 */
    readonly submissions: number
  }
  readonly tasks: readonly TaskSummary[]
  readonly submissions: readonly SubmissionSummary[]
}

/**
 * 取一份诊断摘要。
 *
 * 只读：不写库、不跑任务代码。看到 `counts.blocked > 0` 或 `tasks[].blockedReason` 就是有活卡住了。
 */
export async function inspectHarness(
  harness: Harness,
  context: Context = BACKGROUND_CONTEXT,
): Promise<InspectionSummary> {
  /**
   * 向 Harness 要一份 "当前状态快照"
   * {
      scheduling: "running" | "paused" | "closing",  // 调度器在不在推进
      tasks:       [...],// 每个未完成任务
      submissions: [...],// 还没结算的提交
    }
   */
  const inspection = await harness.inspect(context)
  const tasks = inspection.tasks.map(summarizeTask)

  return {
    scheduling: inspection.scheduling,
    counts: {
      tasks: tasks.length,
      running: tasks.filter(task => task.scheduling === "running").length,
      blocked: tasks.filter(task => task.scheduling === "blocked").length,
      submissions: inspection.submissions.length,
    },
    tasks,
    submissions: inspection.submissions.map(summarizeSubmission),
  }
}

/** 任务 → 只留定位用的字段；原因只在真卡住时才带上。 */
function summarizeTask(inspection: TaskInspection): TaskSummary {
  const { record, state } = inspection
  return {
    id: record.id,
    kind: record.kind,
    conversationId: record.conversationId,
    status: record.state.status,
    scheduling: state.kind,
    background: record.background,
    restarts: record.restarts ?? 0,
    ...(state.kind === "blocked" ? { blockedReason: state.reason } : {}),
  }
}

/** 提交 → 只留 id、归属、类型、状态，不带任何内容。 */
function summarizeSubmission(record: SubmissionRecord): SubmissionSummary {
  return {
    id: record.id,
    conversationId: record.conversationId,
    type: record.type,
    status: record.status,
  }
}
