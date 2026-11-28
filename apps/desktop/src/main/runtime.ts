/**
 * 桌面主进程的运行时配置：存储 → Harness → 会话/帧/审批/路由
 */
import path from "node:path"
import { clipboard, shell } from "electron"

import type { Context } from "@earendil-works/chord"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { createModels, type Models } from "@earendil-works/pi-ai"
import {
  ApprovalBroker,
  createNodeEnvFactory,
  createPiRegistry,
  createConversationPurge, // 删除会话记录
  createStorage,
  createTitleSummarizer, // 会话标题处理
  DEFAULT_APPROVAL_TIMEOUT_MS,
  ensureWorkspacePaths,
  FrameHub,
  HarnessHost,
  IpcRouter,
  materializeSubmission,
  ModelSettings,
  PROVIDER_ID,
  sandboxModeFromEnv,
  sandboxNetworkFromEnv,
  SessionManager,
  summarizeRegistry,
  workspacePaths,
  type WorkspacePaths,
} from "@pi/core"
import type { ApprovalContext, ApprovalRequest } from "@pi/ext-coding"
import { createCodingExtension } from "@pi/ext-coding"
import type { HostInfo, PushMap, PushChannel, ViewFrame } from "@pi/shared-types"

import { createSafeStorageSecret } from "./secret-store.ts"
import { SubappService } from "./subapps/service.ts"

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
  /** 平台层只安排应用重启，不在进程内重建 Harness。 */
  readonly restart?: () => void | Promise<void>
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
  /** 子应用生命周期服务；M1-4 将经 IPC 暴露给渲染进程。 */
  readonly subapps: SubappService
  readonly info: HostInfo // 宿主信息
  readonly #publish: DesktopRuntimeOptions["publish"] // 推送出口： 用于运行时想把某个状态告诉界面时
  readonly #stopSink: () => void // 停止帧 sink ：用于停止向接受者推送会话帧
  #closing: Promise<void> | undefined // 应用退出，持续关闭
  readonly #manager: SessionManager
  readonly #stopClose: () => void
  readonly #log: NonNullable<DesktopRuntimeOptions["log"]>
  #viewsClosing: Promise<void> | undefined

  private constructor(input: {
    options: DesktopRuntimeOptions // 运行时配置
    paths: WorkspacePaths // 工作区路径
    host: HarnessHost // Harness 主机
    hub: FrameHub // FrameHub（监听会话变更，统一进行发帧）
    approvals: ApprovalBroker // 审批
    router: IpcRouter // 路由处理
    subapps: SubappService
    info: HostInfo // 宿主信息
    stopSink: () => void // 停止帧 sink ：用于停止向接受者推送会话帧
    manager: SessionManager
  }) {
    this.paths = input.paths
    this.host = input.host
    this.hub = input.hub
    this.approvals = input.approvals
    this.router = input.router
    this.subapps = input.subapps
    this.info = input.info
    this.#publish = input.options.publish
    this.#stopSink = input.stopSink
    this.#manager = input.manager
    this.#log = input.options.log ?? (() => {})
    // close 通知在 Session 线上：只排微任务，不能在监听器里调用 Session API。
    this.#stopClose = this.host.harness.subscribeClose(() => {
      queueMicrotask(() => {
        if (this.#closing !== undefined) return
        this.approvals.closeAll()
        this.#stopSink()
        const status = this.host.unavailableStatus
        if (status !== undefined) this.publishStatus(status)
      })
    })
    void this.host.closed.then(end => {
      this.#stopClose()
      if (end.reason !== "failed") return
      this.#log("runtime failed", { error: String(end.error) })
      this.approvals.closeAll()
      this.#stopSink()
      this.publishStatus(this.host.unavailableStatus!)
      void this.#closeViews().catch(error => this.#log("view cleanup failed", { error: String(error) }))
    })
  }

  // 打开运行时： 初始化所有对象，并返回运行时实例
  static async open(options: DesktopRuntimeOptions): Promise<DesktopRuntime> {
    const log = options.log ?? (() => {})
    const publish: DesktopRuntimeOptions["publish"] = (channel, payload) => {
      try { options.publish(channel, payload) }
      catch (error) { log("push failed", { channel, error: String(error) }) }
    }
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

    // 模型设置：配置从 app.settings 读，密钥经 safeStorage 加密存文件。
    // Harness 的 models 先返回空集合，等 warm() 完成后再换成真实网关。
    const fallbackModels = createModels()
    const modelRef: { current?: ModelSettings } = {}
    const resolveModels = (): Models => modelRef.current?.current() ?? fallbackModels

    // 创建 Harness 主机： 整体 harness 流程
    const host = await HarnessHost.open({
      storage,
      registry,
      models: resolveModels,
      // 创建了 node 环境，用于执行 bash 命令
      env: createNodeEnvFactory({ workspace: paths.workspace }),
      settings: () => ({ progress: { partialIntervalMs: 100 } }),
      log,
    })

    // 读取 durable 记录并恢复已启用子应用；单个子应用损坏不会阻塞整个桌面运行时。
    const subapps = new SubappService({
      paths,
      harness: host.harness,
      registry,
      onChanged: change => publish("subapp.changed", change),
      onProposed: proposal => publish("subapp.proposed", proposal),
    })
    await subapps.restore().catch(error => log("subapp restore failed", { error: String(error) }))

    // 配置就绪后 Harness 才拿得到真实模型；没配置时仍可开窗，发消息会报 no_model。
    modelRef.current = new ModelSettings({
      harness: host.harness,
      secret: createSafeStorageSecret(path.join(paths.root, "model-key.bin")),
    })
    const active = await modelRef.current.warm(BACKGROUND_CONTEXT)

    // 创建会话管理器： 用于管理会话状态
    const manager = await SessionManager.open({
      harness: host.harness,
      storage,
      // 改动统计要用工作区所在的 git 仓库算基线
      workspace: paths.workspace,
      // 文件库才有物理删除；内存库（--memory）退回「从列表移除」
      purge: createConversationPurge(target),
      // 超过 10 字的第一条用户消息：后台问一次模型压成标题，生成好就推给界面
      summarizeTitle: createTitleSummarizer(resolveModels),
      onTitle: (conversationId, title) =>
        publish("conv.title", { conversationId, title }),
    })
    // 新会话跟随已生效的配置；旧版本空模型会话补一次默认模型（不覆盖已有选择）。
    manager.setDefaultModel(active === undefined ? undefined : { provider: PROVIDER_ID, modelId: active.modelId })
    await manager.backfillModel(BACKGROUND_CONTEXT)

    // 创建帧管理器： 用于管理会话帧
    const hub = new FrameHub(host.harness, {
      onError: error => log("frame sink 抛错", { message: String(error) }),
    })
    // 创建会话帧的接受者
    const stopFrames = hub.addSink((frame: ViewFrame) =>
      publish("view", frame),
    )
    // 停止提交
    const stopSubmissions = host.harness.subscribeCommits(publication => {
      for (const change of publication.changes) {
        if (change.type !== "submission") continue
        const view = materializeSubmission(change.value)
        if (view !== undefined) publish("submission", view)
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
        publish("approval", { conversationId, pending }),
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
      host,
      restart: options.restart,
      models: modelRef.current,
      workspace: paths.workspace,
      copyText: text => clipboard.writeText(text),
      subapps,
      openFile: async target => {
        // 空字符串表示成功；返回错误信息时抛出去，让界面看到原因。
        const error = await shell.openPath(target)
        if (error !== "") throw new Error(`无法打开文件：${error}`)
      },
    })

    log("registry", summarizeRegistry(registry.snapshot()))
    log("runtime ready", {
      conversationId: manager.conversationId,
      dataDir: paths.root,
      // 排障：命令被拦时先看这一行（PI_SANDBOX / PI_SANDBOX_NET）
      sandbox: `${sandboxModeFromEnv()}/${sandboxNetworkFromEnv()}`,
      model: active === undefined ? "none" : `${active.modelId}(${active.source})`,
    })

    return new DesktopRuntime({
      options: { ...options, publish },
      paths,
      host,
      hub,
      approvals: broker,
      router,
      subapps,
      info,
      stopSink,
      manager,
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
    this.publishStatus({
      scheduling: "closing",
      tasks: 0,
      running: 0,
      blocked: 0,
      submissions: 0,
    })
    this.#stopSink()
    this.approvals.closeAll()
    try {
      await this.#closeViews()
    } finally {
      await this.host.close(context)
      this.#stopClose()
    }
  }

  #closeViews(): Promise<void> {
    this.#viewsClosing ??= (async () => {
      const results = await Promise.allSettled([this.hub.closeAll(), this.#manager.closeWatches()])
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : [])
      if (errors.length > 0) throw new AggregateError(errors, "会话订阅清理失败。")
    })()
    return this.#viewsClosing
  }

  /** 推送一条宿主状态（给状态栏用）。 */
  publishStatus(status: PushMap["host.status"]): void {
    // 已失效的宿主不能被迟到的健康度查询或普通关机通知覆盖。
    this.#publish("host.status", this.host.unavailableStatus ?? status)
  }
}
