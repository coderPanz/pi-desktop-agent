/**
 * 桌面主进程的运行时配置：存储 → Harness → 会话/帧/审批/路由
 */
import path from "node:path"

import type { Context } from "@earendil-works/chord"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
/**
 * 它是 SDK 里「对 pi.agent 文档的一次修改」的形状
 * export type AgentChange = {
     model?: ModelRef | null                       // 用哪个模型
     thinkingLevel?: ModelThinkingLevel | null      // 思考强度
     extensions?: Extension[] | { add?; remove? } | null   // 选中哪些扩展
     tools?: ToolRegistration[] | { remove } | null        // 启用哪些工具
     modelTools?: ToolRegistration[] | { remove?; add? } | null  // 模型能看见哪些工具
     instructions?: string | null                  // 追加的指令段
     cwd?: string | null                           // 会话的工作目录
   }
 */
import type { AgentChange } from "@earendil-works/pi-durable"
import type { Models } from "@earendil-works/pi-ai"
import {
  ApprovalBroker,
  createModelRegistry,
  createNodeEnvFactory,
  createPiRegistry,
  createStorage,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  ensureWorkspacePaths,
  FrameHub,
  gatewayConfigFromEnv,
  HarnessHost,
  IpcRouter,
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
  /** 数据根：桌面传 `app.getPath("userData")` */
  readonly dataDir: string
  /** 推送出口：Electron 里是 `webContents.send` */
  readonly publish: <K extends PushChannel>(channel: K, payload: PushMap[K]) => void
  readonly appVersion: string
  readonly platform: string
  readonly versions: { readonly electron: string | undefined; readonly node: string; readonly chrome: string | undefined }
  /** 是否写文件；`false` 用内存库（排障用） */
  readonly memory?: boolean
  readonly log?: (line: string, detail?: Record<string, unknown>) => void
}

/** 
 * 配置好的桌面运行时：一个进程一份，Harness 只有一个
 * 谁能拿到 Harness
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
  readonly host: HarnessHost // HarnessHost → Harness → Storage(SQLite)
  readonly hub: FrameHub // FrameHub（watch 会话，发帧）
  readonly approvals: ApprovalBroker // 审批
  readonly router: IpcRouter // 路由处理
  readonly info: HostInfo // 宿主信息
  readonly #publish: DesktopRuntimeOptions["publish"] // 推送出口
  readonly #stopSink: () => void // 停止帧 sink
  #closing: Promise<void> | undefined

  private constructor(input: {
    options: DesktopRuntimeOptions
    paths: WorkspacePaths
    host: HarnessHost
    hub: FrameHub
    approvals: ApprovalBroker
    router: IpcRouter
    info: HostInfo
    stopSink: () => void
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

  static async open(options: DesktopRuntimeOptions): Promise<DesktopRuntime> {
    const log = options.log ?? (() => {})
    const paths = workspacePaths(path.resolve(options.dataDir))
    if (options.memory !== true) await ensureWorkspacePaths(paths)

    const storage = await createStorage(
      options.memory === true ? { kind: "memory" } : { kind: "file", file: paths.db },
    )

    /**
     * 审批中枢要在 Harness 之后建，而扩展要在 Harness 之前装进注册表——
     * 用一层转发把这个环打开：真正触发审批时 broker 早已就绪。
     */
    const approvalsRef: { current?: ApprovalBroker } = {}
    const registry = createPiRegistry({
      extensions: [
        createCodingExtension({
          workspace: paths.workspace,
          approve: (request: ApprovalRequest, context: ApprovalContext) =>
            approvalsRef.current?.request(request, context) ?? false,
        }),
      ],
    })

    // 模型按需创建：没配凭证也能开窗，只是发消息时才报 ConfigError。
    let models: Models | undefined
    const resolveModels = (): Models => (models ??= createModelRegistry())

    const host = await HarnessHost.open({
      storage,
      registry,
      models: resolveModels,
      env: createNodeEnvFactory({ workspace: paths.workspace }),
      settings: () => ({ progress: { partialIntervalMs: 100 } }),
      ...initialAgent(),
      log,
    })

    const manager = await SessionManager.open({ harness: host.harness, storage })

    const hub = new FrameHub(host.harness, {
      onError: (error) => log("frame sink 抛错", { message: String(error) }),
    })
    const stopSink = hub.addSink((frame: ViewFrame) => options.publish("view", frame))

    const broker = new ApprovalBroker({
      harness: host.harness,
      onChange: (conversationId, pending) =>
        options.publish("approval", { conversationId, pending }),
      timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
    })
    approvalsRef.current = broker

    const config = readGatewayConfig()
    const info: HostInfo = {
      appVersion: options.appVersion,
      electron: options.versions.electron,
      node: options.versions.node,
      chrome: options.versions.chrome,
      platform: options.platform,
      dataDir: paths.root,
      rootConversationId: manager.conversationId,
      model: config === undefined ? undefined : { provider: PROVIDER_ID, modelId: config },
    }

    const router = new IpcRouter({
      harness: host.harness,
      manager,
      hub,
      approvals: broker,
      info,
    })

    log("registry", summarizeRegistry(registry.snapshot()))
    log("runtime ready", { conversationId: manager.conversationId, dataDir: paths.root })

    return new DesktopRuntime({ options, paths, host, hub, approvals: broker, router, info, stopSink })
  }

  /** 幂等关闭：先停推送，再结算审批，然后停帧，最后关 Harness（连存储一起收）。 */
  close(context: Context = BACKGROUND_CONTEXT): Promise<void> {
    this.#closing ??= this.#close(context)
    return this.#closing
  }

  async #close(context: Context): Promise<void> {
    // 先告诉界面「要关了」，再停推送：反过来的话这条状态发不出去。
    this.#publish("host.status", { scheduling: "closing", tasks: 0, running: 0, blocked: 0, submissions: 0 })
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
