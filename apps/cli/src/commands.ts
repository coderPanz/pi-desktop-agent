/**
 * REPL（读取 → 求值 → 打印 → 循环 指命令行交互
 * 作用场景：判断是否是命令，如果不是，就当作文本提交给模型
 */

export type Command =
  | { readonly kind: "send"; readonly text: string }
  | { readonly kind: "new" }
  | { readonly kind: "list" }
  | { readonly kind: "switch"; readonly id: number }
  | { readonly kind: "fork" }
  | { readonly kind: "abort" }
  | { readonly kind: "reset"; readonly handoff: string | undefined }
  | { readonly kind: "compact"; readonly instructions: string | undefined }
  | { readonly kind: "inspect" }
  | { readonly kind: "help" }
  | { readonly kind: "quit" }

/** 命令拼错或参数不对：直接回给用户，不消费输入。 */
export class CommandError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CommandError"
  }
}

export const COMMAND_HELP = `命令
  /new             新建空会话并切过去
  /list            列出全部会话（* 为当前会话，busy 表示正在跑）
  /switch <id>     切换会话
  /fork            从当前最新条目分叉出新会话并切过去
  /abort           中断正在进行的回答（保留已产出的部分）
  /reset [说明]     清空上下文，可给一句交接说明
  /compact [说明]   压缩上下文，等压缩结束再返回
  /inspect         打印诊断摘要（不含消息内容）
  /help            打印本帮助
  /quit            退出（Ctrl+D 同效）

其他输入一律作为消息提交给模型。`

/**
 * 解析一行输入
 *
 * - 空行 / 纯空白 → `undefined`（调用方跳过）
 * - `/` 开头 → 命令；拼错抛 `CommandError`
 * - 其他 → `send` for model
 */
export function parseCommand(line: string): Command | undefined {
  const trimmed = line.trim()
  if (trimmed === "") return undefined
  if (!trimmed.startsWith("/")) return { kind: "send", text: trimmed }

  const [head = "", ...rest] = trimmed.slice(1).split(/\s+/)
  const name = head.toLowerCase()
  const argument = rest.join(" ").trim()

  switch (name) {
    case "new":
      rejectArgument(argument, "/new")
      return { kind: "new" }
    case "list":
      rejectArgument(argument, "/list")
      return { kind: "list" }
    case "switch":
    case "conv": {
      if (argument === "") throw new CommandError("/switch 需要一个会话 id")
      const id = Number(argument)
      if (!Number.isInteger(id) || id <= 0) {
        throw new CommandError(`/switch 收到非法会话 id：${argument}`)
      }
      return { kind: "switch", id }
    }
    case "fork":
      rejectArgument(argument, "/fork")
      return { kind: "fork" }
    case "abort":
      rejectArgument(argument, "/abort")
      return { kind: "abort" }
    case "reset":
      return { kind: "reset", handoff: argument === "" ? undefined : argument }
    case "compact":
      return { kind: "compact", instructions: argument === "" ? undefined : argument }
    case "inspect":
      rejectArgument(argument, "/inspect")
      return { kind: "inspect" }
    case "help":
    case "?":
      return { kind: "help" }
    case "quit":
    case "exit":
    case "q":
      return { kind: "quit" }
    default:
      throw new CommandError(`未知命令：/${name}（/help 看全部命令）`)
  }
}

function rejectArgument(argument: string, command: string): void {
  if (argument !== "") throw new CommandError(`${command} 不接受参数：${argument}`)
}
