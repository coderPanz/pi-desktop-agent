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
  /**
   * coding 场景默认信任工作区：`write` / `edit` 不再逐个弹审批，改完由用户 review。
   *
   * 放宽的只是「问不问人」，不是边界：路径仍由 `withPathGuard` 在真正执行前按工作区校验，
   * 工作区外的写入照样被拒。真正需要事前确认的是 `bash`——它能跑任意命令，没有等价的内核保证。
   * 想恢复逐个确认，传 `false`。
   */
  readonly trustWorkspaceWrites?: boolean
  /**
   * coding 场景默认信任命令：除了「明确灾难性」的命令（抹盘/关机/根目录删除/提权）之外一律放行。
   *
   * 敢这么放的前提是影响范围已经被限制住：bash 跑在内核沙箱里，
   * 写只到工作区与临时目录、网络默认拒绝、凭证目录读取被屏蔽。
   * 剩下会留下的破坏（工作区内 `git reset --hard`、`rm -rf src`）由「本轮改动」卡片 + 撤销兜。
   * 想要逐个确认就传 `false`（回到只读命令白名单）。
   */
  readonly trustBash?: boolean
  /**
   * 工作区是否在 git 仓库里。`false` 时不放行递归删除——非 git 工作区没有基线，
   * 「本轮改动」卡片也救不回来，值得多问一次。
   */
  readonly workspaceIsGit?: boolean
}

/** 只读、无副作用，直接放行的工具 */
const ALLOWED_TOOLS: ReadonlySet<string> = new Set(["read", "list_dir", "grep", "glob"])

/** 需 human-in-the-loop */
const ASKED_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "apply_patch"])

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

/** 提权会绕开整份沙箱策略，直接拒绝。 */
const PRIVILEGE_COMMANDS: ReadonlySet<string> = new Set(["sudo", "doas", "su", "visudo"])

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
  // 包管理器与语言工具链：只放行「测试 / 构建 / 检查」这类子命令，参数另由规则收窄
  "pnpm",
  "npm",
  "yarn",
  "bun",
  "cargo",
  "go",
  "make",
  "tsc",
  "vitest",
  "jest",
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

/** 项目脚本类子命令：跑测试/构建/检查，不改变项目定义。`add` / `publish` / `run` 任意脚本一律不算。 */
const PROJECT_SCRIPT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "test", "build", "lint", "typecheck", "check", "ci",
])

/** `pnpm run x` / `npm run x` / `yarn x`：只认上面那几个脚本名。 */
function packageManagerIsSafe(args: readonly string[]): boolean {
  const [first, second] = args
  if (first === undefined) return false
  // `run <script>`：脚本名必须在白名单里（`run postinstall` 之类就不放行）
  if (first === "run") return second !== undefined && PROJECT_SCRIPT_SUBCOMMANDS.has(second)
  // `pnpm test` / `npm run build` 之外的子命令（add/publish/exec/dl x…）都要问
  return PROJECT_SCRIPT_SUBCOMMANDS.has(first)
}

/** `cargo test|build|check|clippy`：`cargo run` 会执行任意程序，不放行。 */
function cargoIsSafe(args: readonly string[]): boolean {
  const [first] = args
  return first !== undefined && ["test", "build", "check", "clippy"].includes(first)
}

/** `go test|build|vet`：`go run` 会执行任意代码，不放行。 */
function goIsSafe(args: readonly string[]): boolean {
  const [first] = args
  return first !== undefined && ["test", "build", "vet"].includes(first)
}

/** `make`：无参数会跑默认目标（内容未知），只放行明确的目标名。 */
function makeIsSafe(args: readonly string[]): boolean {
  const [first] = args
  return first !== undefined && PROJECT_SCRIPT_SUBCOMMANDS.has(first)
}

/** 逐命令的额外参数规则：没列出的命令只看名字。 */
const SAFE_ARGUMENT_RULES: Readonly<Record<string, (args: readonly string[]) => boolean>> = {
  find: findIsReadOnly,
  sed: sedIsReadOnly,
  git: gitIsReadOnly,
  pnpm: packageManagerIsSafe,
  npm: packageManagerIsSafe,
  yarn: packageManagerIsSafe,
  bun: packageManagerIsSafe,
  cargo: cargoIsSafe,
  go: goIsSafe,
  make: makeIsSafe,
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

/**
 * 工作区内的递归删除：`rm -r` / `rm -rf` / `rm --recursive`，以及 `git clean -f`。
 * 只用于「非 git 工作区多问一次」这一条提示，不参与其他判定。
 */
function destructiveDelete(command: string): boolean {
  for (const segment of segments(command)) {
    const tokens = words(segment)
    const names = tokens.map(programName)
    if (names.includes("rm")) {
      const recursive = tokens.some((token, index) =>
        names[index] === "rm" ? false : /^-[a-zA-Z]*[rR]/.test(token) || token === "--recursive")
      if (recursive) return true
    }
    if (names.includes("git") && tokens.some(token => token === "clean") &&
        tokens.some(token => /^-[a-zA-Z]*[fdx]/.test(token))) return true
  }
  return false
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
      if (PRIVILEGE_COMMANDS.has(name)) return `拒绝执行提权命令：${name}`

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
  // 信任模式：灾难性命令照旧拒绝，其余直接放行。
  // 唯一例外：工作区不在 git 里时，工作区内的递归删除没有「撤销」兜底，仍问一次。
  if (options.trustBash !== false) {
    if (findDangerousReason(command, options) !== undefined) return "deny"
    if (options.workspaceIsGit === false && destructiveDelete(command)) return "ask"
    return "allow"
  }

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
  if (ASKED_TOOLS.has(call.name)) return options.trustWorkspaceWrites === false ? "ask" : "allow"
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
