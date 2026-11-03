/**
 * 命令行参数解析
 */

export type CliMode = "repl" | "once" | "help"

export type CliArgs = {
  readonly mode: CliMode
  /** 用内存库：验收与排障用，不落库 */
  readonly memory: boolean
  /** 数据根目录；`--memory` 时仍会算，不创建任何文件 */
  readonly dataDir: string
  /** 起始会话；缺省是 root 会话 */
  readonly conversationId: number | undefined
  /** 流式提交间隔；越小越平滑，越大越省写入 */
  readonly partialIntervalMs: number | undefined
  /** `once` 模式下要提交的内容 */
  readonly prompt: string | undefined
}

export const DEFAULT_DATA_DIR = ".data"
export const DEFAULT_PARTIAL_INTERVAL_MS = 100 // 流式提交间隔毫秒

/** 
 * 参数不合法：调用方 据此以退出码 2 结束
 * Error：内置全局构造器
 */
export class UsageError extends Error {
  constructor(message: string) {
    // 调用父类构造器，等价于： new Error(message)
    super(message)
    this.name = "UsageError"
  }
}

// cli 打印的帮助文本
export const HELP_TEXT = `pi-agent-desktop CLI —— 不启动 Electron 的终端入口

用法
  pnpm cli [选项]
  pnpm cli -p "你好"            一次性提问，打印回答后退出

选项
  -p, --prompt <text>            一次性提交并等待回答，然后退出
      --data-dir <path>          数据根目录（默认 ${DEFAULT_DATA_DIR}），其中存放 session.sqlite / workspace / tools / logs
      --memory                   使用内存库，不落盘；用于验收与排障
      --conv <id>                指定起始会话 id（默认 root 会话）
      --partial-interval-ms <n>  流式提交间隔毫秒（默认 ${DEFAULT_PARTIAL_INTERVAL_MS}）
  -h, --help                     打印本帮助

交互命令（REPL 内）
  /new            新建会话          /list           列出会话
  /switch <id>    切换会话          /fork           从最新条目分叉
  /abort          中断当前回答      /reset [说明]   清空上下文
  /compact [说明] 压缩上下文        /inspect        打印诊断摘要
  /help           帮助             /quit           退出（Ctrl+D 同效）

环境变量
  ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / ANTHROPIC_MODEL  模型网关
  PI_LOG_LEVEL                                              debug | info | warn | error
`

/** 
 * 解析参数
 * 未知参数或缺失取值一律抛 `UsageError`
 */
export function parseArgs(argv: readonly string[]): CliArgs {
  let memory = false
  let dataDir = DEFAULT_DATA_DIR
  let dataDirGiven = false
  let conversationId: number | undefined
  let partialIntervalMs: number | undefined
  let prompt: string | undefined
  let help = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === undefined) break

    switch (arg) {
      case "-h":
      case "--help":
        help = true
        break
      case "--memory":
        memory = true
        break
      case "--data-dir":
        dataDir = requireValue(argv, (index += 1), arg)
        dataDirGiven = true
        break
      case "--conv":
        conversationId = parsePositiveInt(requireValue(argv, (index += 1), arg), arg)
        break
      case "--partial-interval-ms":
        partialIntervalMs = parsePositiveInt(requireValue(argv, (index += 1), arg), arg)
        break
      case "-p":
      case "--prompt":
        prompt = requireValue(argv, (index += 1), arg)
        break
      default:
        throw new UsageError(`未知参数：${arg}`)
    }
  }

  if (memory && dataDirGiven) throw new UsageError("--memory 与 --data-dir 互斥：前者不落盘，后者要落盘")

  const mode: CliMode = help ? "help" : prompt === undefined ? "repl" : "once"
  return { mode, memory, dataDir, conversationId, partialIntervalMs, prompt }
}

/** 取下一个参数作为取值；缺了就报错，不回落成空串 */
function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index]
  if (value === undefined || value.startsWith("-")) {
    throw new UsageError(`${flag} 缺少取值`)
  }
  return value
}

function parsePositiveInt(raw: string, flag: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new UsageError(`${flag} 需要一个正整数，收到：${raw}`)
  }
  return value
}
