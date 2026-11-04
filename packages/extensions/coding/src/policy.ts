/**
 * 工具策略：`allow` / `ask` / `deny` 三档，纯函数
 */

/** 判定结果 */
export type Verdict = "allow" | "ask" | "deny" // 同意 / 询问 / 拒绝

/** 工具调用视图：工具名 + 已校验的参数 */
export type ToolCallView = {
  readonly name: string
  readonly arguments: Readonly<Record<string, unknown>>
}

export type PolicyOptions = {
  readonly home?: string
}

/** 只读、无副作用，直接放行的工具 */
const ALLOWED_TOOLS: ReadonlySet<string> = new Set(["read", "list_dir"])

/** 需 human-in-the-loop */
const ASKED_TOOLS: ReadonlySet<string> = new Set(["write", "edit"])

/** 危险命令-直接拒绝。 */
const ROOT_TARGETS: ReadonlySet<string> = new Set([
  "/",
  "/*",
  "~",
  "~/",
  "~/*",
  "$HOME",
  "$HOME/",
  "$HOME/*",
  "${HOME}",
  "${HOME}/*",
])

/** 根级目标集合：固定写法 + 家目录字面路径。 */
function rootTargets(home: string | undefined): ReadonlySet<string> {
  if (home === undefined || home === "") return ROOT_TARGETS
  const trimmed = home.replace(/\/+$/, "")
  return new Set([...ROOT_TARGETS, trimmed, `${trimmed}/*`])
}

/** 危险命令 */
const ROOT_DESTROYERS: ReadonlySet<string> = new Set([
  "rm",
  "rmdir",
  "shred",
  "truncate",
  "chmod",
  "chown",
  "chgrp",
  "dd",
  "mv",
  "ln",
  "find",
])

/** 直接写块设备/抹盘。 */
const DISK_TOOLS: ReadonlySet<string> = new Set(["newfs", "wipefs", "fdisk", "parted", "sgdisk", "diskutil"])

/** 关机会打断别人的工作，也让当前会话无法收尾。 */
const POWER_COMMANDS: ReadonlySet<string> = new Set(["shutdown", "reboot", "halt", "poweroff"])

/** 不需要人点头的只读命令。表越短越好：漏判只是多问一次，错判会让危险命令悄悄跑掉。 */
const SAFE_COMMANDS: ReadonlySet<string> = new Set([
  "ls",
  "cd",
  "pwd",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "rg",
  "file",
  "stat",
  "du",
  "df",
  "tree",
  "which",
  "whoami",
  "date",
  "uname",
  "echo",
  "printf",
  "sort",
  "uniq",
  "cut",
  "basename",
  "dirname",
  "realpath",
  "diff",
  "jq",
  "true",
  "test",
  "find",
  "sed",
  "git",
])

/** `git` 只放行只读子命令；`git clean` / `git push` 一类必须问。 */
const SAFE_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "remote",
  "rev-parse",
  "ls-files",
  "blame",
  "shortlog",
  "describe",
  "show-ref",
])

/** `find` 的删除/执行参数等同于任意副作用。 */
function findIsReadOnly(args: readonly string[]): boolean {
  return !args.some(
    (arg) => arg === "-delete" || arg === "-exec" || arg === "-execdir" || arg === "-ok" || arg === "-fprint",
  )
}

/** `sed` 不加 `-i` 只写 stdout；加了就是原地改文件。 */
function sedIsReadOnly(args: readonly string[]): boolean {
  return !args.some((arg) => arg.startsWith("-i") || arg.startsWith("--in-place"))
}

/** 只读的 `git` 子命令；`branch -D` 会删分支，单独拦。 */
function gitIsReadOnly(args: readonly string[]): boolean {
  const [subcommand] = args
  if (subcommand === undefined || !SAFE_GIT_SUBCOMMANDS.has(subcommand)) return false
  return !args.some((arg) => arg === "-d" || arg === "-D" || arg === "--delete" || arg === "--force")
}

/** 逐命令的额外参数规则：没列出的命令只看名字。 */
const SAFE_ARGUMENT_RULES: Readonly<Record<string, (args: readonly string[]) => boolean>> = {
  find: findIsReadOnly,
  sed: sedIsReadOnly,
  git: gitIsReadOnly,
}

/** 按 `;` `&&` `||` `|` 换行切成段：危险判断与安全判断都按段做，避免上一段的参数污染下一段。 */
function segments(command: string): readonly string[] {
  return command
    .split(/[;\n]|&&|\|\||\|/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "")
}

/** 段内的词：括号与重定向符当分隔符，去掉包裹的引号。 */
function words(segment: string): readonly string[] {
  return segment
    .split(/[\s()<>]+/)
    .map((word) => word.replace(/^['"`]+/, "").replace(/['"`]+$/, ""))
    .filter((word) => word !== "")
}

/** 命令名：`/bin/rm`、`./x.sh` 都取最后一段。 */
function programName(word: string): string {
  const parts = word.split(/[\\/]/)
  return parts[parts.length - 1] ?? word
}

/** 段里有没有直接写块设备的重定向。 */
function writesBlockDevice(segment: string, tokens: readonly string[]): boolean {
  if (!segment.includes(">")) return false
  return tokens.some((token) => /^\/dev\/(sd|disk|rdisk|nvme|hd)/.test(token))
}

/**
 * 找出「明确灾难性」的写法，返回一句原因；没有就返回 `undefined`。
 *
 * 判据只在段内看：`rm -rf ./build && ls /` 里的 `/` 不是 `rm` 的目标。
 */
export function findDangerousReason(command: string, options: PolicyOptions = {}): string | undefined {
  // fork 炸弹：`|` 与 `;` 会被切成段，所以先对整条命令判。
  if (/:\s*\(\s*\)\s*\{[^}]*\|[^}]*&[^}]*\}\s*;/.test(command)) return "拒绝执行 fork 炸弹"

  const targets = rootTargets(options.home)

  for (const segment of segments(command)) {
    const tokens = words(segment)
    const names = tokens.map(programName)

    for (const [index, name] of names.entries()) {
      if (POWER_COMMANDS.has(name)) return `拒绝执行关机/重启类命令：${name}`

      if (name.startsWith("mkfs") || DISK_TOOLS.has(name)) {
        const args = names.slice(index + 1)
        const erases =
          name.startsWith("mkfs") ||
          name === "newfs" ||
          name === "wipefs" ||
          args.some((arg) => arg === "eraseDisk" || arg === "eraseVolume" || arg === "reformat")
        if (erases) return `拒绝执行抹盘/格式化命令：${name}`
      }

      if (tokens.some((token) => /^of=\/dev\//.test(token))) return "拒绝把数据写到块设备：of=/dev/…"
      if (writesBlockDevice(segment, tokens)) return "拒绝把输出重定向到块设备"

      // `rm -rf /`：危险命令后面跟着根级目标。
      if (ROOT_DESTROYERS.has(name)) {
        const rest = tokens.slice(index + 1)
        const target = rest.find((token) => targets.has(token))
        if (target !== undefined) return `拒绝在根级路径上执行 ${name}：${target}`
      }
    }
  }
  return undefined
}

/** 一段是否只读且无副作用（重定向与命令替换由调用方先挡掉）。 */
function isSafeSegment(segment: string): boolean {
  const tokens = words(segment)
  let index = 0
  // `FOO=bar cmd` 形式的前缀赋值不改变命令本身。
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")) index += 1
  const head = tokens[index]
  if (head === undefined) return true
  const name = programName(head)
  if (!SAFE_COMMANDS.has(name)) return false
  const rule = SAFE_ARGUMENT_RULES[name]
  return rule === undefined ? true : rule(tokens.slice(index + 1))
}

/**
 * `bash` 工具的三档判定：
 *
 * - `deny`：灾难性写法（抹盘、关机、根级删除、fork 炸弹）；
 * - `allow`：整条命令每一段都是只读命令，没有重定向、没有命令替换；
 * - `ask`：其余一切。
 */
export function classifyBash(command: string, options: PolicyOptions = {}): Verdict {
  if (findDangerousReason(command, options) !== undefined) return "deny"
  // 命令替换里可以是任何东西，静态看不出，只能问人。
  if (/[`]|\$\(|\$\{/.test(command)) return "ask"
  const parts = segments(command)
  if (parts.length === 0) return "ask"
  for (const segment of parts) {
    // 重定向会写文件，`> /etc/hosts` 与 `> ./note.md` 对这里没有区别。
    if (segment.includes(">")) return "ask"
    if (!isSafeSegment(segment)) return "ask"
  }
  return "allow"
}

/** 一次工具调用的结论。不认识的工具不归这里管：别的扩展自己决定要不要问。 */
export function classify(call: ToolCallView, options: PolicyOptions = {}): Verdict {
  if (ALLOWED_TOOLS.has(call.name)) return "allow"
  if (ASKED_TOOLS.has(call.name)) return "ask"
  if (call.name === "bash") {
    const command = call.arguments["command"]
    return classifyBash(typeof command === "string" ? command : "", options)
  }
  return "allow"
}

/** 取一个字符串参数；类型不对就当没有。 */
function stringArgument(call: ToolCallView, key: string): string | undefined {
  const value = call.arguments[key]
  return typeof value === "string" ? value : undefined
}

const SUMMARY_LIMIT = 200

/** 一行摘要，给审批提示与「已拒绝」的说明用；长文本截断，避免把整段文件内容刷到终端。 */
export function describeCall(call: ToolCallView): string {
  const detail =
    call.name === "bash"
      ? (stringArgument(call, "command") ?? "")
      : (stringArgument(call, "path") ?? "")
  const compact = detail.replace(/\s+/g, " ").trim()
  const shown = compact.length > SUMMARY_LIMIT ? `${compact.slice(0, SUMMARY_LIMIT)}…` : compact
  return shown === "" ? call.name : `${call.name}: ${shown}`
}
