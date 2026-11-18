/**
 * 桌面主进程的运行时配置：存储 → Harness → 会话/帧/审批/路由
 */
import path from "node:path"

import type { Context } from "@earendil-works/chord"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { AgentChange } from "@earendil-works/pi-durable"
import type { Models } from "@earendil-works/pi-ai"
import {
  ApprovalBroker,
  createModelRegistry,
  createNodeEnvFactory,
  createPiRegistry,
  createConversationPurge, // 删除会话记录
  createStorage,
  createTitleSummarizer, // 会话标题处理
  DEFAULT_APPROVAL_TIMEOUT_MS,
  ensureWorkspacePaths,
  FrameHub,
  gatewayConfigFromEnv,
  HarnessHost,
  IpcRouter,
  materializeSubmission,
  PROVIDER_ID,
  SessionManager,
  summarizeRegistry,
  workspacePaths,
  type WorkspacePaths,
} from "@pi/core"
import type { ApprovalContext, ApprovalRequest } from "@pi/ext-coding"
import { createCodingExtension } from "@pi/ext-coding"
import type { HostInfo, PushMap, PushChannel, ViewFrame } from "@pi/shared-types"

// 桌面端运行时配置
export type DesktopRuntimeOptions = {
  /** 数据根： 桌面端所有 durable 状态都在 dataRoot/session.sqlite； 工作区 dataRoot/workspace/*（包括模型产出的文件、工具执行的痕迹）；  自定义工具 dataRoot/tools */
  readonly dataDir: string
  /** 推送通信 ：Electron 里是 `webContents.send` */
  readonly publish: <K extends PushChannel>(
    channel: K,
    payload: PushMap[K],
  ) => void
  readonly appVersion: string
  readonly platform: string
  readonly versions: {
    readonly electron: string | undefined
    readonly node: string
    readonly chrome: string | undefined
  }
  /** 是否写文件；`false` 用内存库（排障用） */
  readonly memory?: boolean
  readonly log?: (line: string, detail?: Record<string, unknown>) => void
}

/** 
 * 配置好的桌面运行时
 * 谁能拿到 Harness？
 ```
   主进程（唯一）
     DesktopRuntime          ← apps/desktop/src/main/runtime.ts
      ├─ host.harness        HarnessHost → Harness → Storage(SQLite)
      ├─ hub                 FrameHub（watch 会话，发帧）
      ├─ approvals           ApprovalBroker
      └─ router              IpcRouter（认知这些对象）

   渲染进程（只有副本）
     window.pi.invoke / subscribe
      └─ ViewSnapshot（纯 JSON：条目 + 内置文档）
 ```
 */
export class DesktopRuntime {
  readonly paths: WorkspacePaths // 工作区路径
  readonly host: HarnessHost // Harness 主机，包括 Harness-根会话-storeage 以及初始化和关闭 Harness 的方法
  readonly hub: FrameHub // FrameHub（监听会话变更，统一进行发帧）
  readonly approvals: ApprovalBroker // 审批
  readonly router: IpcRouter // 路由处理
  readonly info: HostInfo // 宿主信息
  readonly #publish: DesktopRuntimeOptions["publish"] // 推送出口： 用于运行时想把某个状态告诉界面时
  readonly #stopSink: () => void // 停止帧 sink ：用于停止向接受者推送会话帧
  #closing: Promise<void> | undefined // 应用退出，持续关闭

  private constructor(input: {
    options: DesktopRuntimeOptions // 运行时配置
    paths: WorkspacePaths // 工作区路径
    host: HarnessHost // Harness 主机
    hub: FrameHub // FrameHub（监听会话变更，统一进行发帧）
    approvals: ApprovalBroker // 审批
    router: IpcRouter // 路由处理
    info: HostInfo // 宿主信息
    stopSink: () => void // 停止帧 sink ：用于停止向接受者推送会话帧
  }) {
    this.paths = input.paths
    this.host = input.host
    this.hub = input.hub
    this.approvals = input.approvals
    this.router = input.router
    this.info = input.info
    this.#publish = input.options.publish
    this.#stopSink = input.stopSink
  }

  // 打开运行时： 初始化所有对象，并返回运行时实例
  static async open(options: DesktopRuntimeOptions): Promise<DesktopRuntime> {
    const log = options.log ?? (() => {})
    const paths = workspacePaths(path.resolve(options.dataDir))
    if (options.memory !== true) await ensureWorkspacePaths(paths)

    // 创建存储： 用于存储会话状态
    const target =
      options.memory === true
        ? ({ kind: "memory" } as const)
        : ({ kind: "file", file: paths.db } as const)
    const storage = await createStorage(target)

    // 创建审批管理
    const approvalsRef: { current?: ApprovalBroker } = {}
    // 创建注册表： 用于存储扩展
    const registry = createPiRegistry({
      extensions: [
        // 创建 coding 扩展
        createCodingExtension({
          workspace: paths.workspace, // 工作目录
          approve: (request: ApprovalRequest, context: ApprovalContext) => // 审批
            approvalsRef.current?.request(request, context) ?? false,
        }),
      ],
    })

    // 模型按需创建：没配凭证也能开窗，只是发消息时才报 ConfigError。
    let models: Models | undefined
    const resolveModels = (): Models => (models ??= createModelRegistry())

    // 创建 Harness 主机： 整体 harness 流程
    const host = await HarnessHost.open({
      storage,
      registry,
      models: resolveModels,
      env: createNodeEnvFactory({ workspace: paths.workspace }),
      settings: () => ({ progress: { partialIntervalMs: 100 } }),
      ...initialAgent(),
      log,
    })

    // 创建会话管理器： 用于管理会话状态
    const manager = await SessionManager.open({
      harness: host.harness,
      storage,
      // 文件库才有物理删除；内存库（--memory）退回「从列表移除」
      purge: createConversationPurge(target),
      // 超过 10 字的第一条用户消息：后台问一次模型压成标题，生成好就推给界面
      summarizeTitle: createTitleSummarizer(resolveModels),
      onTitle: (conversationId, title) =>
        options.publish("conv.title", { conversationId, title }),
    })

    // 创建帧管理器： 用于管理会话帧
    const hub = new FrameHub(host.harness, {
      onError: error => log("frame sink 抛错", { message: String(error) }),
    })
    // 创建会话帧的接受者
    const stopFrames = hub.addSink((frame: ViewFrame) =>
      options.publish("view", frame),
    )
    // 停止提交
    const stopSubmissions = host.harness.subscribeCommits(publication => {
      for (const change of publication.changes) {
        if (change.type !== "submission") continue
        const view = materializeSubmission(change.value)
        if (view !== undefined) options.publish("submission", view)
      }
    })
    // 停止向接收方发帧
    const stopSink = (): void => {
      stopFrames()
      stopSubmissions()
    }

    // 创建审批管理器： 用于管理审批状态
    const broker = new ApprovalBroker({
      harness: host.harness,
      onChange: (conversationId, pending) =>
        options.publish("approval", { conversationId, pending }),
      timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
    })
    approvalsRef.current = broker

    // 创建根会话 Agent 配置
    const rootAgent = await host.root.agent(BACKGROUND_CONTEXT)
    // 创建宿主信息： 用于存储宿主信息
    const info: HostInfo = {
      appVersion: options.appVersion,
      electron: options.versions.electron,
      node: options.versions.node,
      chrome: options.versions.chrome,
      platform: options.platform,
      dataDir: paths.root,
      rootConversationId: manager.conversationId,
      model: rootAgent.model,
    }

    // 创建路由处理： 用于处理 IPC 请求
    const router = new IpcRouter({
      harness: host.harness,
      manager,
      hub,
      approvals: broker,
      info,
    })

    log("registry", summarizeRegistry(registry.snapshot()))
    log("runtime ready", {
      conversationId: manager.conversationId,
      dataDir: paths.root,
    })

    return new DesktopRuntime({
      options,
      paths,
      host,
      hub,
      approvals: broker,
      router,
      info,
      stopSink,
    })
  }

  /** 幂等关闭：先停推送，再结算审批，然后停帧，最后关 Harness（连存储一起收）。 */
  close(context: Context = BACKGROUND_CONTEXT): Promise<void> {
    this.#closing ??= this.#close(context)
    return this.#closing
  }

  // 关闭运行时
  async #close(context: Context): Promise<void> {
    // 先告诉界面「要关了」，再停推送：反过来的话这条状态发不出去。
    this.#publish("host.status", {
      scheduling: "closing",
      tasks: 0,
      running: 0,
      blocked: 0,
      submissions: 0,
    })
    this.#stopSink()
    this.approvals.closeAll()
    await this.hub.closeAll()
    await this.host.close(context)
  }

  /** 推送一条宿主状态（给状态栏用）。 */
  publishStatus(status: PushMap["host.status"]): void {
    this.#publish("host.status", status)
  }
}

/** 从环境读模型配置；缺变量就返回 undefined，不拦启动。 */
function initialAgent(): { agent?: AgentChange } {
  const modelId = readGatewayConfig()
  return modelId === undefined ? {} : { agent: { model: { provider: PROVIDER_ID, modelId } } }
}

function readGatewayConfig(): string | undefined {
  try {
    return gatewayConfigFromEnv().modelId
  } catch {
    return undefined
  }
}
