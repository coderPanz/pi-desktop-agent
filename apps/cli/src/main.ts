/**
 * 无 Electron 的终端入口
 *
 * 定位不是面向普通用户的界面，而是开发、验收与排障用的第一条主线
 * 和桌面主进程复用同一套 `@pi/core`
 * 「不启动 Electron 也能复现排队、中断、分叉、恢复」是它存在的理由
 *
 */

// 内置的 readline 模块的 Promise 版本，用来和终端（stdin/stdout）做交互式问答，返回 promise
import { createInterface } from "node:readline/promises"
import path from "node:path"

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { AgentChange, ConversationId } from "@earendil-works/pi-durable"

import {
  ConfigError,
  createModelRegistry,
  createNodeEnvFactory,
  createPiRegistry,
  createStorage,
  ensureWorkspacePaths,
  FrameHub,
  gatewayConfigFromEnv,
  HarnessHost,
  inspectHarness,
  PROVIDER_ID,
  SessionManager,
  UserError,
  workspacePaths,
} from "@pi/core"

import { DEFAULT_PARTIAL_INTERVAL_MS, HELP_TEXT, parseArgs, UsageError } from "./args.ts"
import { COMMAND_HELP, CommandError, parseCommand } from "./commands.ts"
import { ConversationRenderer } from "./render.ts"

const CONTEXT = BACKGROUND_CONTEXT
const PROMPT = "› "

/** 把命令行解析出的普通数字收窄成类型层的 `ConversationId`：这是 CLI 唯一的 id 类型转换边界 */
function conversationIdFromInput(value: number): ConversationId {
  return value as ConversationId
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv)
  if (args.mode === "help") {
    /**
     * 向标准输出（stdout）写入内容，属于可写流（Writable Stream）：`process.stdout` 是流对象
     * 场景：适合在终端流式渲染内容
    */
    process.stdout.write(HELP_TEXT)
    return 0
  }

  const paths = workspacePaths(path.resolve(args.dataDir))
  if (!args.memory) await ensureWorkspacePaths(paths)

  const storage = await createStorage(
    args.memory ? { kind: "memory" } : { kind: "file", file: paths.db },
  )
  const registry = createPiRegistry()

  let models: ReturnType<typeof createModelRegistry> | undefined
  const resolveModels = () => (models ??= createModelRegistry())

  // root 会话首次创建时把模型写进 agent 配置；之后不再重复写。
  const initialAgent = readInitialAgent()

  // 打开 HarnessHost：初始化存储、模型注册表、环境配置、进度设置、初始化代理配置、日志记录
  const host = await HarnessHost.open({
    storage,
    registry,
    models: resolveModels,
    env: createNodeEnvFactory({ workspace: paths.workspace }),
    settings: () => ({
      progress: { partialIntervalMs: args.partialIntervalMs ?? DEFAULT_PARTIAL_INTERVAL_MS },
    }),
    ...(initialAgent === undefined ? {} : { agent: initialAgent }),
    log: (line, detail) => logDebug(line, detail),
  })

  // 打开 SessionManager：初始化会话管理器
  const manager = await SessionManager.open({
    harness: host.harness,
    storage,
    ...(args.conversationId === undefined
      ? {}
      : { conversationId: conversationIdFromInput(args.conversationId) }),
  })

  // 打开 FrameHub：初始化帧管理器
  const hub = new FrameHub(host.harness, {
    onError: (error) => {
      process.stderr.write(`[frame] ${errorText(error)}\n`)
    },
  })

  // 初始化渲染器：把帧渲染到终端
  let renderedId = manager.conversationId
  let renderer = new ConversationRenderer({ out: process.stdout })

  // 添加帧的接收方【这里是终端渲染器】：把帧渲染到终端
  hub.addSink((frame) => {
    if (frame.convId === renderedId) renderer.apply(frame)
  })

  /** 切到某个会话：换一份副本与渲染器，旧副本作废。 */
  const openConversation = async (id: ConversationId): Promise<void> => {
    const opened = await hub.open(id, CONTEXT)
    renderer = new ConversationRenderer({ out: process.stdout })
    renderedId = id
    renderer.open(opened)
  }

  try {
    await openConversation(renderedId)
    return args.mode === "once"
      ? await runOnce(manager, args.prompt ?? "")
      : await runRepl({ manager, host, openConversation })
  } finally {
    // 收口顺序固定：先停帧，再关会话订阅，最后关 Harness（它会连存储一起收）。
    await hub.closeAll()
    await manager.closeWatches()
    await host.close()
  }
}

/** 一次性提问：提交、等它结算、退出。退出码反映是否拿到了回答。 */
async function runOnce(manager: SessionManager, prompt: string): Promise<number> {
  const submission = await manager.submit(prompt, CONTEXT)
  const settled = await submission.wait(CONTEXT)
  process.stdout.write("\n")
  if (settled.status !== "done") {
    process.stderr.write(`提交未被回答（status=${settled.status}）\n`)
    return 1
  }
  return 0
}

type ReplInput = {
  readonly manager: SessionManager
  readonly host: HarnessHost
  readonly openConversation: (id: ConversationId) => Promise<void>
}

/** 运行 REPL：交互式命令行 */
async function runRepl({ manager, host, openConversation }: ReplInput): Promise<number> {
  // 检查是否是交互式终端（TTY）：如果是，则启用行编辑功能（Ctrl+C 中断当前回答，不退出进程）
  const interactive = process.stdin.isTTY === true
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: interactive,
  })

  /**
   * Ctrl+C 只中断当前回答，不退出进程——退出到底是不是想要的，用户自己再按一次 /quit。
   * 中断是 durable 操作：重启后也能看见「已请求取消」。
   */
  let interrupting = false
  rl.on("SIGINT", () => {
    if (interrupting) return
    interrupting = true
    void manager
      .abort(CONTEXT)
      .then(() => process.stdout.write("\n已请求中断\n"))
      .catch((error: unknown) => process.stderr.write(`中断失败：${errorText(error)}\n`))
      .finally(() => {
        interrupting = false
      })
  })

  let code = 0

  // 创建异步迭代器：管道输入或 Ctrl+D 时读流会结束，`question()` 在 EOF 上永远不 resolve，整个进程会挂在未决的 await 上。
  const lines = rl[Symbol.asyncIterator]()
  try {
    for (;;) {
      if (interactive) process.stdout.write(PROMPT)
      const next = await lines.next()
      if (next.done === true) break // Ctrl+D 或输入结束

      try {
        // 解析也在 try 里：命令拼错是用户输入问题，不是进程启动失败。
        const command = parseCommand(next.value)
        if (command === undefined) continue
        if (command.kind === "quit") break

        const stop = await runCommand(command, { manager, host, openConversation })
        if (stop) break
      } catch (error) {
        // 命令拼错、状态不满足前提：说一句就继续，不算进程失败。
        if (error instanceof CommandError || error instanceof UserError) {
          process.stdout.write(`${error.message}\n`)
          continue
        }
        // 存储失败意味着 Harness 不可用，只能重建，不能假装还能继续用。
        if (isSessionFailure(error)) {
          process.stderr.write(`存储失败，会话不可继续：${errorText(error)}\n`)
          return 1
        }
        process.stderr.write(`失败：${errorText(error)}\n`)
        code = 1
      }
    }
  } finally {
    rl.close()
  }
  return code
}

/** 返回 true 表示要退出 REPL。 */
async function runCommand(
  command: NonNullable<ReturnType<typeof parseCommand>>,
  { manager, host, openConversation }: ReplInput,
): Promise<boolean> {
  switch (command.kind) {
    case "send": {
      const submission = await manager.submit(command.text, CONTEXT)
      process.stdout.write(`\n[submission ${String(submission.id)} 已受理]\n`)
      return false
    }
    case "new": {
      const conversation = await manager.create(CONTEXT)
      await manager.select(conversation.id, CONTEXT)
      await openConversation(conversation.id)
      process.stdout.write(`已新建并切到会话 #${String(conversation.id)}\n`)
      return false
    }
    case "list": {
      const conversations = await manager.list(CONTEXT)
      for (const item of conversations) {
        const current = item.id === manager.conversationId ? "*" : " "
        const flags = [item.busy ? "busy" : "", item.queued > 0 ? `queued=${String(item.queued)}` : ""]
          .filter((flag) => flag !== "")
          .join(" ")
        process.stdout.write(
          `${current} #${String(item.id)}${flags === "" ? "" : `  ${flags}`}\n`,
        )
      }
      return false
    }
    case "switch": {
      const id = conversationIdFromInput(command.id)
      await manager.select(id, CONTEXT)
      await openConversation(id)
      return false
    }
    case "fork": {
      const conversation = await manager.fork(CONTEXT)
      await manager.select(conversation.id, CONTEXT)
      await openConversation(conversation.id)
      process.stdout.write(`已从当前条目分叉到会话 #${String(conversation.id)}\n`)
      return false
    }
    case "abort": {
      await manager.abort(CONTEXT)
      process.stdout.write("已请求中断\n")
      return false
    }
    case "reset": {
      await manager.reset(CONTEXT, command.handoff)
      process.stdout.write("上下文已重置\n")
      return false
    }
    case "compact": {
      process.stdout.write("压缩中…\n")
      const settled = await manager.compact(CONTEXT, command.instructions)
      const outcome = settled.state.outcome
      if (outcome.status !== "completed") {
        process.stdout.write(`压缩未完成：${outcome.status}\n`)
        return false
      }
      const entryId = outcome.result.entryId
      process.stdout.write(
        entryId === undefined ? "没有可压缩的内容\n" : `已压缩，摘要条目 #${String(entryId)}\n`,
      )
      return false
    }
    case "inspect": {
      const summary = await inspectHarness(host.harness, CONTEXT)
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
      return false
    }
    case "help": {
      process.stdout.write(`${COMMAND_HELP}\n`)
      return false
    }
    case "quit":
      return true
  }
}

/** 从环境变量读模型配置；缺变量就返回 undefined，不拦启动。 */
function readInitialAgent(): AgentChange | undefined {
  try {
    const config = gatewayConfigFromEnv()
    return { model: { provider: PROVIDER_ID, modelId: config.modelId } }
  } catch {
    return undefined
  }
}

/** `PI_LOG_LEVEL=debug` 时把启动链路打到 stderr，stdout 只留对话输出。 */
function logDebug(line: string, detail?: Record<string, unknown>): void {
  if (process.env.PI_LOG_LEVEL !== "debug") return
  const suffix = detail === undefined ? "" : ` ${JSON.stringify(detail)}`
  process.stderr.write(`[core] ${line}${suffix}\n`)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `SessionFailed` 由 pi-durable 抛出：仓储层失败，Harness 已不可用。 */
function isSessionFailure(error: unknown): boolean {
  return error instanceof Error && error.name === "SessionFailed"
}

/** 顶层入口：把异常翻译成退出码，栈不直接泼给用户（`PI_LOG_LEVEL=debug` 时才打）。 */
async function run(argv: readonly string[]): Promise<void> {
  try {
    process.exitCode = await main(argv)
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${HELP_TEXT}`)
      process.exitCode = 2
      return
    }
    const prefix = error instanceof ConfigError ? "配置缺失" : "启动失败"
    process.stderr.write(`${prefix}：${errorText(error)}\n`)
    if (process.env.PI_LOG_LEVEL === "debug" && error instanceof Error && error.stack !== undefined) {
      process.stderr.write(`${error.stack}\n`)
    }
    process.exitCode = 1
  }
}

// 顶层入口：把异常翻译成退出码，栈不直接泼给用户（`PI_LOG_LEVEL=debug` 时才打）。
await run(process.argv.slice(2))
