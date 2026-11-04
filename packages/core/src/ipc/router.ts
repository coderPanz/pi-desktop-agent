/**
 * IPC 路由：按命令名调用对应的方法，返回结果或错误码
 *
 * 渲染进程读不到数据库，也拿不到 Harness，它只能发一条 IPC 过来。发过来的就两样：
 * 命令名（如 `conv.submit`）和参数（如 `{ conversationId: 1, text: "hi" }`）。这个文件负责：
 *
 *   1. 检查参数：命令名认不认得、`conversationId` 是不是正整数、`text` 是不是非空字符串；
 *   2. 按命令名调用对应的方法（会话、帧、文档、审批）；
 *   3. 返回结果或错误码：`{ ok: true, value }` / `{ ok: false, error: { code, message } }`。
 *
 * 为什么返回错误码而不抛异常：异常跨进程会丢栈，还可能把本机路径带过去。
 *
 * 两条容易踩的事：
 *   - 每条命令都带 `conversationId`。桌面同时开多个会话，这里没有「当前会话」这种全局变量；
 *     `SessionManager` 里那个指针是 CLI REPL 用的，这里不用它。
 *   - 这里的「通道」指命令名，不是 Electron 的 IPC 通道名。Electron 那边只有一条 `pi:invoke`，
 *     命令名是作为参数传进来的。
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
  OpenedView,
  WhenBusy,
} from "@pi/shared-types"
import { IpcError, toIpcErrorPayload } from "@pi/shared-types"

import type { ApprovalBroker } from "../approvals/broker.ts"
import { inspectHarness } from "../diagnostics/inspect.ts"
import type { FrameHub } from "../frames/frame-hub.ts"
import type { SessionManager } from "../session/manager.ts"

export type IpcRouterOptions = {
  readonly harness: Harness
  readonly manager: SessionManager
  readonly hub: FrameHub
  readonly approvals: ApprovalBroker
  readonly info: HostInfo
}

/** 一次 IPC 请求的应答；调用方（Electron 的 ipcMain 或测试）只需转发。 */
export class IpcRouter {
  readonly #harness: Harness
  readonly #manager: SessionManager
  readonly #hub: FrameHub
  readonly #approvals: ApprovalBroker
  readonly #info: HostInfo

  constructor(options: IpcRouterOptions) {
    this.#harness = options.harness
    this.#manager = options.manager
    this.#hub = options.hub
    this.#approvals = options.approvals
    this.#info = options.info
  }

  /** 处理一条命令。永不抛错：失败也走 `{ ok: false }`。 */
  async handle<K extends IpcChannel>(
    channel: K,
    request: unknown,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<IpcResult<K>> {
    try {
      return { ok: true, value: await this.#dispatch(channel, request, context) }
    } catch (error) {
      return { ok: false, error: toIpcErrorPayload(error) }
    }
  }

  async #dispatch<K extends IpcChannel>(
    channel: K,
    request: unknown,
    context: Context,
  ): Promise<IpcResponse<K>> {
    const input = asObject(request)
    switch (channel) {
      case "app.info":
        return this.#info as IpcResponse<K>

      case "app.status": {
        const summary = await inspectHarness(this.#harness, context)
        const status: HostStatus = {
          scheduling: summary.scheduling,
          tasks: summary.counts.tasks,
          running: summary.counts.running,
          blocked: summary.counts.blocked,
          submissions: summary.counts.submissions,
        }
        return status as IpcResponse<K>
      }

      case "conv.list": {
        const limit = optionalInteger(input, "limit", 1, 200) ?? 50
        const conversations: readonly ConversationSummary[] = await this.#manager.list(context, limit)
        return conversations as IpcResponse<K>
      }

      case "conv.open": {
        const id = conversationIdOf(input)
        // 先确认存在：帧站对不存在的会话只报「用户错误」，界面需要区分「没有这个会话」。
        if ((await this.#harness.conversation(id, context)) === undefined) {
          throw new IpcError("NOT_FOUND", `会话不存在：${String(id)}`)
        }
        const opened: OpenedView = await this.#hub.open(id, context)
        return opened as IpcResponse<K>
      }

      case "conv.create": {
        const conversation = await this.#manager.create(context)
        return { conversationId: conversation.id } as IpcResponse<K>
      }

      case "conv.submit": {
        const id = conversationIdOf(input)
        const text = requiredText(input, "text")
        const whenBusy = optionalWhenBusy(input)
        const requestId = optionalText(input, "requestId")
        const conversation = await this.#conversation(id, context)
        const submission = await conversation.submit(
          {
            type: "input",
            content: text,
            whenBusy: whenBusy ?? "followUp",
            ...(requestId === undefined ? {} : { requestId }),
          },
          context,
        )
        return { submissionId: submission.id } as IpcResponse<K>
      }

      case "conv.abort": {
        const conversation = await this.#conversation(conversationIdOf(input), context)
        await conversation.abort(context)
        return {} as IpcResponse<K>
      }

      case "conv.fork": {
        const id = conversationIdOf(input)
        const at = optionalInteger(input, "at", 1) as EntryId | undefined
        const conversation = await this.#conversation(id, context)
        const entryId = at ?? (await this.#lastEntryId(conversation, context))
        const forked = await conversation.fork(entryId, { ownership: { kind: "ownerless" } }, context)
        return { conversationId: forked.id } as IpcResponse<K>
      }

      case "conv.reset": {
        const id = conversationIdOf(input)
        const handoff = optionalText(input, "handoff")
        const conversation = await this.#conversation(id, context)
        await conversation.reset(handoff, context)
        return {} as IpcResponse<K>
      }

      case "conv.compact": {
        const id = conversationIdOf(input)
        const instructions = optionalText(input, "instructions")
        const conversation = await this.#conversation(id, context)
        const taskId = await conversation.compact(instructions, context)
        const settled = await this.#harness.waitForTask(taskId, context)
        const outcome = settled.state.outcome
        const entryId = outcome.status === "completed" ? outcome.result.entryId : undefined
        return { entryId } as IpcResponse<K>
      }

      case "doc.get": {
        const id = conversationIdOf(input)
        const kind = requiredText(input, "kind")
        const value = await readDoc(this.#harness, kind, id, context)
        return value as IpcResponse<K>
      }

      case "approval.list": {
        const id = conversationIdOf(input)
        return (await this.#approvals.list(id)) as IpcResponse<K>
      }

      case "approval.respond": {
        const id = requiredText(input, "id")
        const approved = requiredBoolean(input, "approved")
        return { decision: this.#approvals.respond(id, approved) } as IpcResponse<K>
      }

      default: {
        // 命令表里加了名字但这里没实现：明确报错，不要静默返回 undefined。
        const exhaustive: never = channel
        throw new IpcError("UNKNOWN", `未实现的通道：${String(exhaustive)}`)
      }
    }
  }

  /** 按 id 取会话句柄；不存在就是 NOT_FOUND，而不是笼统的「参数错误」。 */
  async #conversation(id: ConversationId, context: Context): Promise<Conversation> {
    const conversation = await this.#harness.conversation(id, context)
    if (conversation === undefined) throw new IpcError("NOT_FOUND", `会话不存在：${String(id)}`)
    return conversation
  }

  /** 分叉点缺省取最新可见条目。 */
  async #lastEntryId(conversation: Conversation, context: Context): Promise<EntryId> {
    const page = await conversation.entries({ order: "descending" }, 1, undefined, context)
    const entry = page.items[0]
    if (entry === undefined) throw new IpcError("INVALID_ARGUMENT", "当前会话没有可 fork 的条目。")
    return entry.id
  }
}

/** 已知的 `app.*` 文档：kind → 读法（会话作用域要带 id，session 作用域不带）。 */
async function readDoc(
  harness: Harness,
  kind: string,
  conversationId: ConversationId,
  context: Context,
): Promise<JsonObject | undefined> {
  switch (kind) {
    case "app.settings":
      return (await harness.snapshot(AppSettingsDoc, context)) as JsonObject | undefined
    case "app.workspace":
      return (await harness.snapshot(AppWorkspaceDoc, conversationId, context)) as
        | JsonObject
        | undefined
    case "app.approvals":
      return (await harness.snapshot(AppApprovalsDoc, conversationId, context)) as
        | JsonObject
        | undefined
    default:
      throw new IpcError("INVALID_ARGUMENT", `未知文档 kind：${kind}`)
  }
}

/** 入参一律当不可信：先确认是普通对象。 */
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

/** 会话 id：线上是普通数字，进 core 才收窄成品牌类型。 */
function conversationIdOf(input: Readonly<Record<string, unknown>>): ConversationId {
  const value = optionalInteger(input, "conversationId", 1)
  if (value === undefined) throw new IpcError("INVALID_ARGUMENT", "缺少 conversationId。")
  return value as ConversationId
}

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
