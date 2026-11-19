/**
 * 沙箱：用 macOS 原生的 Seatbelt（`/usr/bin/sandbox-exec`）把**每个 shell 子进程**关进策略里。
 *
 * 为什么只包 `exec`：文件工具（read/write/edit）跑在主进程内，边界由 `@pi/ext-coding` 的
 * `paths.ts + guard.ts` 负责；主进程自身要联网调模型、要写数据目录，没法整体进沙箱。
 * 沙箱要挡的是「权限无上限」的那个入口——`bash` 及其所有子进程
 *
 * 1. 默认拒绝写，只放开工作区 + 临时目录；网络按配置默认拒绝；
 * 2. 进程树继承：`sandbox-exec` 先把策略套到自己身上再 exec shell，之后 fork 出来的所有进程同在策略下，子进程只能更严不能更宽；
 * 3. 失败即拒绝：`sandbox-exec` 缺失或 profile 写不出来时，`exec` 直接报错，**不降级成无沙箱执行**。
 */
import {
  accessSync,
  constants,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"

import type { Context } from "@earendil-works/chord"
import type { ExecutionEnv } from "@earendil-works/pi-durable/env"
import type { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node" 
/** Apple 自带的沙箱启动器 */
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec"
export type SandboxMode = "seatbelt" | "off"
export type SandboxNetwork = "deny" | "allow"

export type SandboxOptions = {
  /** 允许写入的根（工作区真实路径） */
  readonly workspace: string
  readonly network?: SandboxNetwork
  /** 用来跑命令的 shell */
  readonly shell?: string
}

/** 从环境变量读模式：项目里其它开关都是 `PI_*` 风格。缺省在 macOS 上开，其它平台关。 */
export function sandboxModeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): SandboxMode {
  const raw = env["PI_SANDBOX"]?.trim()
  if (raw === "off") return "off"
  if (raw === "seatbelt") return "seatbelt"
  if (raw !== undefined && raw !== "") {
    throw new Error(`PI_SANDBOX 只接受 "seatbelt" 或 "off"：${raw}`)
  }
  // 缺省：macOS 用 Seatbelt
  return platform === "darwin" ? "seatbelt" : "off"
}

export function sandboxNetworkFromEnv(env: NodeJS.ProcessEnv = process.env): SandboxNetwork {
  return env["PI_SANDBOX_NET"] === "allow" ? "allow" : "deny"
}

/** `sandbox-exec` 在不在；只在创建环境时探一次。 */
export function seatbeltAvailable(): boolean {
  try {
    accessSync(SANDBOX_EXEC, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 生成沙箱策略文件
 */
export function seatbeltProfile(network: SandboxNetwork): string {
  const rules = [
    "(version 1)",
    "(allow default)",
    "",
    "; 写：默认拒绝，只放开工作区、临时目录与几个必须的设备节点",
    "(deny file-write*)",
    "(allow file-write*",
    '  (subpath (param "WS"))',
    '  (subpath (param "TMP"))',
    '  (subpath "/private/var/folders")',
    '  (literal "/dev/null")',
    '  (literal "/dev/stdout")',
    '  (literal "/dev/stderr"))',
  ]
  if (network === "deny") {
    rules.push("", "; 网络：出站/入站一律拒绝，防止把读到的东西传出去", "(deny network*)")
  }
  return `${rules.join("\n")}\n`
}

/** 一个已经准备好的沙箱：profile 文件 + 启动参数前缀。 */
export type PreparedSandbox = {
  /** `sandbox-exec -D WS=… -D TMP=… -f profile`，后面再接 shell 与命令。 */
  readonly prefix: readonly string[]
  /** 删掉临时 profile 文件。 */
  readonly dispose: () => void
}

/**
 * 归一化成真实路径：Seatbelt 按内核解析后的路径匹配，
 * 传 `/var/folders/...`（软链）进去会匹配不上 `/private/var/folders/...`，工作区反而写不了。
 */
function realPath(target: string): string {
  try {
    return realpathSync(target)
  } catch {
    return path.resolve(target)
  }
}

/** 准备沙箱；工作区还没创建等异常情况直接抛错（调用方据此 fail closed）。 */
export function prepareSandbox(options: SandboxOptions): PreparedSandbox {
  if (!seatbeltAvailable()) {
    throw new Error(
      `找不到 ${SANDBOX_EXEC}，无法启用沙箱。要临时关掉请设置 PI_SANDBOX=off（不推荐）。`,
    )
  }
  // 获取真实路径
  const workspace = realPath(options.workspace)
  // mkdtempSync(prefix)：在 prefix 后接 6 位随机后缀、建一个新目录（已存在则重试），权限 0700，返回路径
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-sandbox-"))
  /**
   * profile 在这里指沙箱策略文件——具体说是一个 .sb 文件，内容是「允许什么、拒绝什么」的策略文本，由 sandbox-exec -f 读取后交给内核。
   * 拼接策略文件路径， 每个 env 一份：WS / TMP / 网络策略都可能不同
   */
  const profile = path.join(directory, "profile.sb")
  // 写入沙箱策略文件
  writeFileSync(profile, seatbeltProfile(options.network ?? "deny"), {
    mode: 0o600, // 文件权限
  })

  return {
    /**
     * -D / -f 是 sandbox-exec 的命令行选项；WS / TMP 是我们自己起的参数名
     * -f 从文件读策略：告诉 sandbox-exec「策略文本在文件里，需要从文件都，而不是内联方式因为策略文本过长，所以放在了文件中」
     * -D key=value = 给策略传一个参数，可以给多个（所以我们连着写了两个 -D），例如： (subpath (param "WS"))      ← 取出 -D 传进来的 WS 的值
     *
     */
    prefix: [
      SANDBOX_EXEC,
      "-D",
      // 工作区：必须是 realpath（内核按解析后的路径匹配），profile 里对应 `(subpath (param "WS"))`
      `WS=${workspace}`, // 参数一
      "-D",
      // 临时目录：profile 里对应 `(subpath (param "TMP"))`；
      `TMP=${realPath(os.tmpdir())}`, // 参数二 
      "-f",
      // 本次 env 专属的策略文件（0600），由 mkdtempSync 建的目录包着
      profile,
    ],
    /** 删除整个临时目录（profile + 目录）。`force` 让重复调用不报错（cleanup 可能被调不止一次）。 */
    dispose: () => {
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

/** 把命令包成沙箱内执行；`shell` 用来跑字符串命令（argv 形式直接前置前缀）。 */
export function sandboxCommand(
  sandbox: PreparedSandbox,
  command: string | readonly string[],
  shell: string,
): readonly string[] {
  // `-lc`：登录 shell，保证 PATH 与交互式一致（工具命令习惯这样写）
  return typeof command === "string"
    ? [...sandbox.prefix, shell, "-lc", command]
    : [...sandbox.prefix, ...command]
}

/**
 * 装饰器：只重写 `exec`（加沙箱前缀）与 `cleanup`（删 profile），其余方法原样转发
 */
export function withSandbox(inner: NodeExecutionEnv, sandbox: PreparedSandbox, shell: string): ExecutionEnv {
  return {
    // 获取本地环境 id
    get id() {
      return inner.id
    },
    // 获取当期目录
    get cwd() {
      return inner.cwd
    },
    // 更新当前目录
    set cwd(value: string) {
      inner.cwd = value
    },
    // targets 监听目标； onChange 变化会调； contex 取消信号，用于监听文件的变化
    watch: (targets, onChange, context) =>
      inner.watch(targets, onChange, context),
    // 绝对路径计算
    absolutePath: (target, context) => inner.absolutePath(target, context),
    // 路径拼接
    joinPath: (parts, context) => inner.joinPath(parts, context),

    /**
     * bash 操作沙箱保护机制
     * 把原命令包装成「在 sandbox-exec 下跑的命令」
     * 1. 「在 sandbox-exec 下跑的命令」产出新的 argv，内核只能执行 argv 格式的命令，字符串类型的命令也需要转化为 argv 格式
     * 输出 case：假设 bash 工具传 "pnpm test"
     * inner.exec([
          "/usr/bin/sandbox-exec", "-D", "WS=…", "-D", "TMP=…", "-f", "…/profile.sb",
          "/bin/zsh", "-lc", "pnpm test",
        ], options, context)
     * 2. 
     *
     */
    exec: (command, options, context) =>
      inner.exec(
        [...sandboxCommand(sandbox, command, shell)],
        options,
        context,
      ),
    // 打开文本行读取器（流式逐行读，不整文件载入）
    openTextLineReader: (target, context) =>
      inner.openTextLineReader(target, context),
    // 读取整个文本文件
    readTextFile: (target, context) => inner.readTextFile(target, context),
    // 读文本的行，可限制最多读多少行（maxLines）
    readTextLines: (target, options, context) =>
      inner.readTextLines(target, options, context),
    // 读取整个二进制文件（Uint8Array）
    readBinaryFile: (target, context) => inner.readBinaryFile(target, context),
    // 打开二进制读取器（可按偏移/字节读，不整文件载入）
    openBinaryReader: (target, options, context) =>
      inner.openBinaryReader(target, options, context),
    // 写入文件（覆盖）
    writeFile: (target, content, context) =>
      inner.writeFile(target, content, context),
    // 追加到文件末尾
    appendFile: (target, content, context) =>
      inner.appendFile(target, content, context),
    // 把文件截断到指定字节数
    truncateFile: (target, size, context) =>
      inner.truncateFile(target, size, context),
    // 把文件内容刷到磁盘（fsync）
    flushFile: (target, context) => inner.flushFile(target, context),
    // 重命名/移动文件
    renameFile: (source, destination, context) =>
      inner.renameFile(source, destination, context),
    // 查文件信息（类型、大小、mtime）
    fileInfo: (target, context) => inner.fileInfo(target, context),
    // 列出目录下的条目
    listDir: (target, context) => inner.listDir(target, context),
    // 打开目录读取器（分批遍历，不一次性列出）
    openDirReader: (target, context) => inner.openDirReader(target, context),
    // 求真实路径（把软链解到底）
    canonicalPath: (target, context) => inner.canonicalPath(target, context),
    // 判断路径是否存在
    exists: (target, context) => inner.exists(target, context),
    // 创建目录（可递归）
    createDir: (target, options, context) =>
      inner.createDir(target, options, context),
    // 删除文件或目录（可递归/忽略不存在）
    remove: (target, options, context) =>
      inner.remove(target, options, context),
    // 在临时目录下建一个临时目录
    createTempDir: (prefix, context) => inner.createTempDir(prefix, context),
    // 在临时目录下建一个临时文件
    createTempFile: (options, context) =>
      inner.createTempFile(options, context),
    // 收尾：先删 profile 目录，再让内层杀子进程/关 watcher
    cleanup: async (context: Context) => {
      sandbox.dispose()
      await inner.cleanup(context)
    },
  }
}
