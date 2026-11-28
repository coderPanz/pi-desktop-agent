/**
 * IPC 路由：命令转发
 *
 * 渲染进程读不到数据库，也拿不到 Harness，它只能发一条 IPC 过来。
 * 命令名（如 `conv.submit`）和参数（如 `{ conversationId: 1, text: "hi" }`）。
 * 这个文件负责：
 *   1. 检查参数
 *   2. 按命令名调用对应的方法
 *   3. 返回结果或错误码
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { Context } from "@earendil-works/chord"
import type { Conversation, ConversationId, EntryId, Harness } from "@earendil-works/pi-durable"
import { AppApprovalsDoc, AppSettingsDoc, AppWorkspaceDoc } from "@pi/shared-docs"
import type {
  ConversationSummary,
  HostInfo,
  HostStatus,
  IpcChannel,
  IpcRequest,
  IpcResponse,
  IpcResult,
  JsonObject,
  ModelSettingsView,
  OpenedView,
  WhenBusy,
} from "@pi/shared-types"
import { IpcError, toIpcErrorPayload } from "@pi/shared-types"

import type { ApprovalBroker } from "../approvals/broker.ts"
import { inspectHarness } from "../diagnostics/inspect.ts"
import type { FrameHub } from "../frames/frame-hub.ts"
import type { SessionManager } from "../session/manager.ts"
import type { HarnessHost } from "../harness/host.ts"
import type { ModelSettings } from "../agent/model-settings.ts"

// 路由配置选项
export type IpcRouterOptions = {
  readonly harness: Harness // harness 主机
  readonly manager: SessionManager // 会话管理器
  readonly hub: FrameHub // 会话帧管理器
  readonly approvals: ApprovalBroker // 审批管理器
  readonly info: HostInfo // 宿主信息
  readonly host: HarnessHost
  readonly restart?: () => void | Promise<void>
  /** 模型配置服务；没传则 model.* 通道直接报不支持。 */
  readonly models?: ModelSettings
  /** 工作区绝对路径；`file.open` 用它做边界校验。 */
  readonly workspace?: string
  /** 打开文件的实际动作（Electron 里是 `shell.openPath`）。core 不依赖 electron。 */
  readonly openFile?: (path: string) => Promise<void>
  /** 写剪贴板的实际动作（Electron 里是 `clipboard.writeText`）。 */
  readonly copyText?: (text: string) => void
}

export class IpcRouter {
  readonly #harness: Harness
  readonly #manager: SessionManager
  readonly #hub: FrameHub
  readonly #approvals: ApprovalBroker
  readonly #info: HostInfo
  readonly #host: HarnessHost
  readonly #restart: IpcRouterOptions["restart"]
  readonly #models: ModelSettings | undefined
  readonly #workspace: string | undefined
  readonly #openFile: IpcRouterOptions["openFile"]
  readonly #copyText: IpcRouterOptions["copyText"]
  #restarting: Promise<void> | undefined

  constructor(options: IpcRouterOptions) {
    this.#harness = options.harness
    this.#manager = options.manager
    this.#hub = options.hub
    this.#approvals = options.approvals
    this.#info = options.info
    this.#host = options.host
    this.#restart = options.restart
    this.#models = options.models
    this.#workspace = options.workspace
    this.#openFile = options.openFile
    this.#copyText = options.copyText
  }

  /** 处理渲染进程发过来的命令 */
  async handle<K extends IpcChannel>(
    channel: K, // 命令名
    request: unknown, // 请求参数
    context: Context = BACKGROUND_CONTEXT, // 中断信号上下文
  ): Promise<IpcResult<K>> {
    try {
      return { ok: true, value: await this.#dispatch(channel, request, context) }
    } catch (error) {
      const unavailable = this.#host.unavailableStatus
      if (channel === "app.status" && unavailable !== undefined) {
        return { ok: true, value: unavailable as IpcResponse<K> }
      }
      // 导致 Session 失败的那一次调用可能抛出原始 Storage 错误，而非 SessionFailed。
      if (channel !== "app.restart" && unavailable !== undefined) {
        return { ok: false, error: { code: "SESSION_FAILED", message: unavailable.error?.message ?? "运行时已停止，不能继续操作。" } }
      }
      return { ok: false, error: toIpcErrorPayload(error) }
    }
  }

  // 分发命令
  async #dispatch<K extends IpcChannel>(
    channel: K,
    request: unknown,
    context: Context,
  ): Promise<IpcResponse<K>> {
    const input = asObject(request)
    // 连只读查询也不能再访问已关闭的库；保留的历史来自渲染进程已有副本。
    if (channel !== "app.info" && channel !== "app.status" && channel !== "app.restart") {
      this.#host?.assertAvailable()
    }
    switch (channel) {
      // 获取宿主信息
      case "app.info":
        return this.#info as IpcResponse<K>

      // 获取宿主状态
      case "app.status": {
        const unavailable = this.#host?.unavailableStatus
        if (unavailable !== undefined) return unavailable as IpcResponse<K>
        const summary = await inspectHarness(this.#harness, context) // 获取Harness摘要
        const status: HostStatus = {
          scheduling: summary.scheduling,
          tasks: summary.counts.tasks,
          running: summary.counts.running,
          blocked: summary.counts.blocked,
          submissions: summary.counts.submissions,
        }
        return (this.#host?.unavailableStatus ?? status) as IpcResponse<K>
      }

      case "app.restart": {
        if (this.#host?.unavailableStatus?.scheduling !== "failed") {
          throw new IpcError("BUSY", "只有失效的运行时可以请求重启应用。")
        }
        if (this.#restart === undefined) throw new IpcError("UNKNOWN", "当前宿主不支持应用重启。")
        this.#restarting ??= Promise.resolve().then(this.#restart).catch(error => {
          this.#restarting = undefined
          throw error
        })
        await this.#restarting
        return {} as IpcResponse<K>
      }

      // 打开工作区里的文件：先按真实路径校验边界，再交给系统
      case "file.open": {
        const requested = requiredText(input, "path")
        const openFile = this.#openFile
        if (openFile === undefined) throw new IpcError("UNKNOWN", "当前宿主不支持打开文件。")
        await openFile(await this.#workspaceFile(requested))
        return {} as IpcResponse<K>
      }

      // 写剪贴板
      case "clipboard.copy": {
        const text = requiredText(input, "text")
        const copyText = this.#copyText
        if (copyText === undefined) throw new IpcError("UNKNOWN", "当前宿主不支持剪贴板写入。")
        copyText(text)
        return {} as IpcResponse<K>
      }

      // 获取模型配置
      case "model.get": {
        return (await this.#modelView()) as IpcResponse<K>
      }

      // 保存模型配置：先写文档与密钥，再换模型集合；只影响新会话
      case "model.save": {
        const models = this.#requireModels()
        const modelId = requiredText(input, "modelId")
        const baseUrl = optionalText(input, "baseUrl")
        const apiKey = optionalText(input, "apiKey")
        const saved = await models.save({ modelId, baseUrl, apiKey }, context)
        const model = saved?.source === "settings"
          ? { provider: "gateway", modelId: saved.modelId }
          : undefined
        this.#manager.setDefaultModel(model)
        // 空模型的旧会话（含根会话）补一次默认模型；已有模型一律不动。
        await this.#manager.backfillModel(context)
        return (await this.#modelView()) as IpcResponse<K>
      }

      // 清除应用内保存的密钥
      case "model.clearKey": {
        await this.#requireModels().clearKey(context)
        return (await this.#modelView()) as IpcResponse<K>
      }

      // 获取会话列表
      case "conv.list": {
        // 整数-范围校验
        const limit = optionalInteger(input, "limit", 1, 200) ?? 50
        const conversations: readonly ConversationSummary[] =
          await this.#manager.list(context, limit)
        return conversations as IpcResponse<K>
      }

      // 监听会话
      case "conv.open": {
        const id = conversationIdOf(input)
        if ((await this.#harness.conversation(id, context)) === undefined) {
          throw new IpcError("NOT_FOUND", `会话不存在：${String(id)}`)
        }
        // 监听会话：返回当前会话id-副本-起始帧号
        const opened: OpenedView = await this.#hub.open(id, context)
        return opened as IpcResponse<K>
      }

      // 获取最新提交的会话
      case "conv.submission": {
        const id = conversationIdOf(input)
        await this.#conversation(id, context)
        return (await this.#manager.latestSubmission(
          id,
          context,
        )) as IpcResponse<K>
      }

      // 创建会话
      case "conv.create": {
        const conversation = await this.#manager.create(context)
        return { conversationId: conversation.id } as IpcResponse<K>
      }

      // 提交用户输入
      case "conv.submit": {
        const id = conversationIdOf(input)
        const text = requiredText(input, "text")
        const whenBusy = optionalWhenBusy(input) // 忙时等待策略
        const requestId = optionalText(input, "requestId") // 请求 id
        const conversation = await this.#conversation(id, context) // 获取会话实例
        const submission = await conversation.submit(
          // 提交用户输入
          {
            type: "input",
            content: text,
            whenBusy: whenBusy ?? "followUp", // 忙时等待策略
            ...(requestId === undefined ? {} : { requestId }),
          },
          context,
        )
        // 一提交就算「开始」：侧栏据此把这个会话从草稿带进「最近」，并按活跃时间排在前面
        await this.#manager.touch(id, context)
        return { submissionId: submission.id } as IpcResponse<K>
      }

      // 中断会话
      case "conv.abort": {
        const conversation = await this.#conversation(
          conversationIdOf(input),
          context,
        )
        await conversation.abort(context)
        return {} as IpcResponse<K>
      }

      // 分叉会话
      case "conv.fork": {
        const id = conversationIdOf(input)
        const at = optionalInteger(input, "at", 1) as EntryId | undefined
        const conversation = await this.#conversation(id, context)
        const entryId = at ?? (await this.#lastEntryId(conversation, context)) // 获取最新的条目 id ，也就是分叉的起点
        const forked = await conversation.fork(
          entryId,
          { ownership: { kind: "ownerless" } },
          context,
        ) // 开始分叉
        // 新会话继承父会话的时间节点，这里改写成「现在」：分叉出来就是一条新近的会话
        await this.#manager.touch(forked.id, context)
        return { conversationId: forked.id } as IpcResponse<K> // 返回分叉会话 id
      }

      // 重命名：写会话标题（`app.title`），界面重拉列表后看到新名字
      case "conv.rename": {
        const id = conversationIdOf(input)
        const title = requiredText(input, "title")
        const renamed = await this.#manager.rename(id, title, context)
        return { title: renamed } as IpcResponse<K>
      }

      // 置顶 / 取消置顶：只改「最近」的排序偏好
      case "conv.pin": {
        const id = conversationIdOf(input)
        const pinned = requiredBoolean(input, "pinned")
        await this.#manager.pin(id, pinned, context)
        return {} as IpcResponse<K>
      }

      // 重置会话
      // 删除会话：只从列表移除，条目与任务仍留在库里
      case "conv.delete": {
        const id = conversationIdOf(input)
        await this.#manager.delete(id, context)
        // 会话已经不在库里，帧没人要了：停掉 watch，别再为一个已删除的会话推帧
        await this.#hub.close(id)
        return {} as IpcResponse<K>
      }

      case "conv.reset": {
        const id = conversationIdOf(input)
        /**
         * handoff：重置时给新上下文的「交接说明」
         * pi-durable 的思想，例如 fork/reset 都是基于在条目 到 pi.reset ; pi.xxx, 系统会基于断点进行相应处理。
         * 例如 reset 时。 会在该条会话对应的条目 entry 写入 pi.reset，在 pi.reset 之前的内容就不进模型上下文，不发给模型。
         * 就相当于 reset 的效果。
         */

        /**
         * SDK 里的实现（harness.js:46-52）：
        ```js
          async reset(handoff, context) {
            const model = handoff === undefined
              ? {}
              : { model: [{ role: "user", content: handoff, timestamp: now() }] }
            const entry = { kind: ResetEntry.kind, head: "self", ...model }   // kind = "pi.reset"
            await this.#host.submissions.submit(this.id, { type: "write", entry }, context) // write 类型，不触发模型调用
          }
        ``` 
        - head: "self" → 从这里开始算新上下文
        - handoff不为空 → 则这条新条目的起点带一个 [UserMessage]，用户消息作为新上下文的起点。
        例如 /reset "刚才在重构 a.ts，已完成一半" 
        新条目起点：
       【user】：刚才在重构 a.ts，已完成一半
        这就是它的用处：清空上下文但别丢掉「我们刚做到哪」这件事，省得用户重新解释一遍背景
        */
        const handoff = optionalText(input, "handoff") // 重置时给新上下文的「交接说明」
        const conversation = await this.#conversation(id, context)
        await conversation.reset(handoff, context) //
        return {} as IpcResponse<K>
      }

      case "conv.compact": {
        const id = conversationIdOf(input)
        // 拿到指令 text
        const instructions = optionalText(input, "instructions")
        const conversation = await this.#conversation(id, context)
        // 传入指令【压缩指令】和中断信号的上下文
        const taskId = await conversation.compact(instructions, context)
        // 等待压缩任务完成
        const settled = await this.#harness.waitForTask(taskId, context)
        // 获取压缩任务结果
        const outcome = settled.state.outcome // 任务结果
        // 如果任务完成，则返回新条目 id， 新的上下文从该条目开始
        const entryId =
          outcome.status === "completed" ? outcome.result.entryId : undefined
        return { entryId } as IpcResponse<K>
      }

      // 获取文档
      case "doc.get": {
        const id = conversationIdOf(input)
        const kind = requiredText(input, "kind")
        const value = await readDoc(this.#harness, kind, id, context)
        return value as IpcResponse<K>
      }

      // 获取该会话的：待批请求
      case "approval.list": {
        const id = conversationIdOf(input)
        return (await this.#approvals.list(id)) as IpcResponse<K>
      }

      // 审批决定：是否放行工具等调用请求
      case "approval.respond": {
        const id = requiredText(input, "id")
        const approved = requiredBoolean(input, "approved")
        return {
          // 执行审批
          decision: this.#approvals.respond(id, approved),
        } as IpcResponse<K>
      }

      default: {
        // 命令表里加了名字但这里没实现：明确报错，不要静默返回 undefined。
        const exhaustive: never = channel
        throw new IpcError("UNKNOWN", `未实现的通道：${String(exhaustive)}`)
      }
    }
  }

  /** 按 id 取会话句柄；不存在就是 NOT_FOUND，而不是笼统的「参数错误」。 */
  /** 把请求路径解析成工作区内真实路径；越界/不存在一律拒绝，不把可疑路径交给系统。 */
  async #workspaceFile(requested: string): Promise<string> {
    const workspace = this.#workspace
    if (workspace === undefined) throw new IpcError("UNKNOWN", "当前宿主没有配置工作区。")
    if (requested.trim() === "") throw new IpcError("INVALID_ARGUMENT", "路径不能为空。")
    const { realpath } = await import("node:fs/promises")
    const path = await import("node:path")
    const root = await realpath(workspace).catch(() => undefined)
    if (root === undefined) throw new IpcError("UNKNOWN", "工作区不存在。")
    const absolute = path.resolve(root, requested)
    const real = await realpath(absolute).catch(() => undefined)
    if (real === undefined) throw new IpcError("NOT_FOUND", `文件不存在：${requested}`)
    const relative = path.relative(root, real)
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return real
    throw new IpcError("INVALID_ARGUMENT", `只能打开工作区内的文件：${requested}`)
  }

  #requireModels(): ModelSettings {
    if (this.#models === undefined) throw new IpcError("UNKNOWN", "当前宿主未配置模型设置服务。")
    return this.#models
  }

  /** 给界面的视图：密钥只说有无，不回传值；env 生效时锁定编辑。 */
  async #modelView(): Promise<ModelSettingsView> {
    const models = this.#models
    if (models === undefined) {
      return { modelId: undefined, baseUrl: undefined, source: "none", key: { stored: false, env: false }, locked: false }
    }
    const snapshot = models.snapshot()
    const key = await models.keyState()
    return {
      modelId: snapshot?.modelId,
      baseUrl: snapshot?.baseUrl,
      source: snapshot?.source ?? "none",
      key,
      locked: snapshot?.source === "env",
    }
  }

  async #conversation(id: ConversationId, context: Context): Promise<Conversation> {
    const conversation = await this.#harness.conversation(id, context)
    if (conversation === undefined) throw new IpcError("NOT_FOUND", `会话不存在：${String(id)}`)
    return conversation
  }

  /** 获取该会话最新的条目 id，作为 fork 的起点 */
  async #lastEntryId(conversation: Conversation, context: Context): Promise<EntryId> {
    const page = await conversation.entries({ order: "descending" }, 1, undefined, context)
    const entry = page.items[0]
    if (entry === undefined) throw new IpcError("INVALID_ARGUMENT", "当前会话没有可 fork 的条目。")
    return entry.id
  }
}

/** 
 * 读文档
 * harness.snapshot： 是 读一份「已提交的文档」的当前值
 *  读的是「已提交」状态，不是内存里的中间态所以 api 命名为“快照”
 */
async function readDoc(
  harness: Harness,
  kind: string,
  conversationId: ConversationId,
  context: Context,
): Promise<JsonObject | undefined> {
  switch (kind) {
    /**
     * AppSettingsDoc = defineDoc({
        kind: "app.settings",
        version: 1,
        scope: "session",
        initial: (): AppSettings => ({ ...DEFAULT_SETTINGS }),
        // 小文档：攒够一批增量再落一次整帧，避免每次改主题都写一份完整 base。
        checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 64,
      })
     */
    case "app.settings":
      return (await harness.snapshot(AppSettingsDoc, context)) as
        | JsonObject
        | undefined
    case "app.workspace":
      return (await harness.snapshot(
        AppWorkspaceDoc,
        conversationId,
        context,
      )) as JsonObject | undefined
    case "app.approvals":
      return (await harness.snapshot(
        AppApprovalsDoc,
        conversationId,
        context,
      )) as JsonObject | undefined
    default:
      throw new IpcError("INVALID_ARGUMENT", `未知文档 kind：${kind}`)
  }
}

/** 入参校验 */
function asObject(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new IpcError("INVALID_ARGUMENT", "请求体必须是对象。")
  }
  return value as Readonly<Record<string, unknown>>
}

function requiredText(input: Readonly<Record<string, unknown>>, key: string): string {
  const value = input[key]
  if (typeof value !== "string" || value.trim() === "") {
    throw new IpcError("INVALID_ARGUMENT", `${key} 必须是非空字符串。`)
  }
  return value
}

function optionalText(input: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new IpcError("INVALID_ARGUMENT", `${key} 必须是字符串。`)
  return value
}

function requiredBoolean(input: Readonly<Record<string, unknown>>, key: string): boolean {
  const value = input[key]
  if (typeof value !== "boolean") throw new IpcError("INVALID_ARGUMENT", `${key} 必须是布尔值。`)
  return value
}

/** 整数并校验范围；`undefined` 表示没传（Optional 语义）。 */
function optionalInteger(
  input: Readonly<Record<string, unknown>>,
  key: string,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new IpcError("INVALID_ARGUMENT", `${key} 必须是 ${String(min)}..${String(max)} 的整数。`)
  }
  return value
}

/** 获取会话 id */
function conversationIdOf(input: Readonly<Record<string, unknown>>): ConversationId {
  const value = optionalInteger(input, "conversationId", 1)
  if (value === undefined) throw new IpcError("INVALID_ARGUMENT", "缺少 conversationId。")
  return value as ConversationId
}

// 忙时策略
const WHEN_BUSY: ReadonlySet<WhenBusy> = new Set(["steer", "followUp", "reject"])

function optionalWhenBusy(input: Readonly<Record<string, unknown>>): WhenBusy | undefined {
  const value = input["whenBusy"]
  if (value === undefined) return undefined
  if (typeof value !== "string" || !WHEN_BUSY.has(value as WhenBusy)) {
    throw new IpcError("INVALID_ARGUMENT", "whenBusy 只能是 steer / followUp / reject。")
  }
  return value as WhenBusy
}

/** 供宿主做类型收窄：路由的请求类型来自 `IpcMap`。 */
export type RouterRequest<K extends IpcChannel> = IpcRequest<K>
