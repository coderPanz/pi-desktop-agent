/**
 * 打开 Harness 的固定顺序：storage → open → resume → root
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { Context } from "@earendil-works/chord"
import { Harness } from "@earendil-works/pi-durable"
import type {
  AgentChange,
  Conversation,
  EnvTarget,
  HarnessOptions,
  HarnessSettings,
  RegistryReader,
  ReportInfo,
  SessionEnd,
  SetTimer,
  Storage,
  ToolRegistration,
  Wake,
} from "@earendil-works/pi-durable"
import type { ExecutionEnv } from "@earendil-works/pi-durable/env"
import type { Models } from "@earendil-works/pi-ai"

export type OpenHarnessOptions = {
  /** pi-ai 的模型访问入口 */
  readonly models: Models | (() => Models)
  /** 工具注册表读取器；会话解析 agent 时按快照取工具定义与扩展。 */
  readonly registry: RegistryReader<ToolRegistration>
  /** 每次使用时按目标（会话 id、cwd、文档读取器）构建执行环境；*/
  readonly env?: (target: EnvTarget, context: Context) => ExecutionEnv | undefined | Promise<ExecutionEnv | undefined>
  /** 全局运行策略（扩展、流式、重试、压缩、队列模式、内存保留、重启上限…）；*/
  readonly settings?: HarnessSettings | (() => HarnessSettings | undefined)
  /** Harness 时钟 */
  readonly now?: () => number
  /** 自定义计时器 */
  readonly setTimer?: SetTimer
  /** 用宿主自己的唤醒机制（如 Durable Object alarm）代替计时器唤醒进程：`wake()` 变化后回调，宿主到点后自行调 `resume()`。 */
  readonly onWake?: (wake: Wake) => void
  /** 接收不导致操作失败的异常 `info.type` 区分具体来源。 */
  readonly onReport?: (error: unknown, info: ReportInfo) => void
  /** 建会话/分叉时写入文档初值 */
  readonly conversationCreated?: HarnessOptions["conversationCreated"]
  /** 建 root 会话时应用的 agent 配置 只在 root 首次创建时生效。 */
  readonly agent?: AgentChange
  /** 启动过程日志（一行一条）；不传则不打印。 */
  readonly log?: (line: string, detail?: Record<string, unknown>) => void
}

export type OpenedHarness = {
  readonly harness: Harness
  readonly root: Conversation
  /** Session 结束原因：`closed`，或 `failed` + 存储错误（必须重建，不能继续用）。 */
  readonly closed: Promise<SessionEnd>
}

/** 打开并进入可运行状态 */
export async function openHarness(
  storage: Storage,
  options: OpenHarnessOptions,
  context: Context = BACKGROUND_CONTEXT,
): Promise<OpenedHarness> {
  const log = options.log ?? (() => {})

  log("harness opening")
  const harness = await Harness.open(
    storage,
    {
      models: options.models,
      registry: options.registry,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.settings === undefined ? {} : { settings: options.settings }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.setTimer === undefined ? {} : { setTimer: options.setTimer }),
      ...(options.onWake === undefined ? {} : { onWake: options.onWake }),
      ...(options.onReport === undefined ? {} : { onReport: options.onReport }),
      ...(options.conversationCreated === undefined
        ? {}
        : { conversationCreated: options.conversationCreated }),
    },
    context,
  )

  harness.resume()
  log("harness resumed")

  const root = await harness.root(
    context,
    options.agent === undefined ? undefined : { agent: options.agent },
  )
  log("root conversation ready", { conversationId: root.id })

  return { harness, root, closed: harness.closed }
}
