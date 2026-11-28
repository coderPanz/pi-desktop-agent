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
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { Context } from "@earendil-works/chord"
import type { ExecutionEnv } from "@earendil-works/pi-durable/env"
import type { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node"
/** Apple 自带的沙箱启动器 */
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec"
const CREDENTIAL_DIRECTORIES = [
  ".ssh", ".aws", ".gnupg", ".azure", ".kube", ".config/gcloud", ".config/gh",
] as const
export type SandboxMode = "seatbelt" | "off"
export type SandboxNetwork = "deny" | "allow"

export type SandboxOptions = {
  /** 允许写入的根（工作区真实路径） */
  readonly workspace: string
  readonly network?: SandboxNetwork
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
    fs.accessSync(SANDBOX_EXEC, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 生成沙箱策略文件
 * `file-write*` 是**通配别名**，代表一整套文件写入类权限集合，等价于一次性开启下面全部子权限：

- `file-write-data`：写入文件内容
- `file-write-create`：新建文件
- `file-write-unlink`：删除文件（rm、unlink）
- `file-write-mode`：chmod 修改权限
- `file-write-xattr`：读写扩展属性
- `file-link` / `file-clone`：硬链接、克隆文件等

>
> 一句话：**只要是修改文件系统的操作，都归 file-write* 管；读文件不归它管**
 */
export function seatbeltProfile(network: SandboxNetwork): string {
  const rules = [
    "(version 1)",
    "(allow default)", // 【重要】默认先放开所有权限
    "",
    "; 写：默认拒绝，只放开工作区、临时目录与几个必须的设备节点",
    "(deny file-write*)", // 覆盖：单独禁止所有文件写入
    "(allow file-write*", // 修改文件的系统操作
    '  (subpath (param "WS"))', // 允许写入 WS 对应的整个工作目录（子路径全部放行）
    '  (subpath (param "TMP"))', // 允许写入 TMP 对应的临时目录
    '  (subpath "/private/var/folders")', // 这个路径以及它下面所有子目录都生效 `file-write*` 整套写入权限
    '  (literal "/dev/null")', // `literal` = 精确匹配这个路径本身
    '  (literal "/dev/stdout")',
    '  (literal "/dev/stderr"))',
    "",
    "; 策略材料不能被受限命令改写，避免同一环境后续 exec 加载被放宽的策略",
    '(deny file-write* (subpath (param "PROFILE_DIR"))',
    '  (regex #"/pi-sandbox-[^/]+(/|$)"))',
    "",
    "; 只屏蔽常见凭证位置，不宣称全局读取隔离；dotenv 示例文件除外",
    "(deny file-read*",
    ...CREDENTIAL_DIRECTORIES.flatMap((directory, index) => [
      `  (subpath (string-append (param "HOME_DIR") "/${directory}"))`,
      `  (subpath (param "CREDENTIAL_${index}"))`,
    ]),
    '  (require-all (regex #"/[.]env([.][^/]+)?$")',
    '    (require-not (regex #"/[.]env[.]example$"))))',
  ]
  if (network === "deny") {
    rules.push("", "; 网络：出站/入站一律拒绝，防止把读到的东西传出去", "(deny network*)")
  }
  return `${rules.join("\n")}\n`
}

/** 一个已经准备好的沙箱：profile 文件 + 启动参数前缀。 */
export type PreparedSandbox = {
  /** 参数化的 sandbox-exec 启动前缀，后面接 shell 或目标程序。 */
  readonly prefix: readonly string[]
  /** 删掉临时 profile 文件。 */
  readonly dispose: () => void
}

/**
 * 归一化成真实路径：Seatbelt 按内核解析后的路径匹配，
 * 传 `/var/folders/...`（软链）进去会匹配不上 `/private/var/folders/...`，工作区反而写不了。
 */
function realDirectory(target: string): string {
  try {
    const real = fs.realpathSync(target)
    if (!fs.statSync(real).isDirectory()) throw new Error("路径不是目录")
    return real
  } catch (cause) {
    throw new Error(`无法确认沙箱目录的真实路径：${target}，拒绝启用沙箱。`, { cause })
  }
}

function credentialPath(target: string): string {
  let current = target
  try {
    while (true) {
      try {
        return path.join(fs.realpathSync(current), path.relative(current, target))
      } catch (cause) {
        if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause
        // 只为尚未创建的路径找祖先；断链、权限错误和解析异常都拒绝。
        try {
          fs.lstatSync(current)
          throw new Error("凭证路径存在但无法解析")
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
        }
        const parent = path.dirname(current)
        if (parent === current) throw cause
        current = parent
      }
    }
  } catch (cause) {
    throw new Error(`无法确认凭证目录的真实路径：${target}，拒绝启用沙箱。`, { cause })
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
  const workspace = realDirectory(options.workspace)
  if (path.dirname(workspace) === workspace) {
    throw new Error("不能把文件系统根目录作为沙箱工作区。")
  }
  const temporary = realDirectory(os.tmpdir())
  const home = realDirectory(os.homedir())
  const credentials = CREDENTIAL_DIRECTORIES.flatMap((relative, index) => [
    "-D", `CREDENTIAL_${index}=${credentialPath(path.join(home, relative))}`,
  ])
  const directory = fs.mkdtempSync(path.join(temporary, "pi-sandbox-"))
  /**
   * profile 在这里指沙箱策略文件——具体说是一个 .sb 文件，内容是「允许什么、拒绝什么」的策略文本，由 sandbox-exec -f 读取后交给内核。
   * 拼接策略文件路径， 每个 env 一份：WS / TMP / 网络策略都可能不同
   */
  const profile = path.join(directory, "profile.sb")
  // 写入沙箱策略文件
  try {
    fs.writeFileSync(profile, seatbeltProfile(options.network ?? "deny"), { mode: 0o600 })
  } catch (cause) {
    try {
      fs.rmSync(directory, { recursive: true, force: true })
    } catch (cleanupError) {
      throw new AggregateError([cause, cleanupError], "沙箱策略创建与清理均失败。")
    }
    throw cause
  }

  return {
    /**
     * -D / -f 是 sandbox-exec 的命令行选项；WS / TMP 是我们自己起的参数名
     * -f 从文件读策略：告诉 sandbox-exec「策略文本在文件里，需要从文件读，而不是内联方式因为策略文本过长，所以放在了文件中」
     * -D key=value = 给策略传一个参数，可以给多个（所以我们连着写了两个 -D），例如： (subpath (param "WS"))      ← 取出 -D 传进来的 WS 的值
     *
     */
    prefix: [
      SANDBOX_EXEC,
      "-D", // -D 标记，下一项为一个参数
      `WS=${workspace}`, // 参数一：工作空间路径
      "-D",
      `TMP=${temporary}`,
      "-D",
      `HOME_DIR=${home}`,
      "-D",
      `PROFILE_DIR=${directory}`,
      ...credentials,
      "-f",
      // 本次 env 专属的策略文件（0600），由 mkdtempSync 建的目录包着
      profile,
    ],
    /** 删除整个临时目录（profile + 目录）。`force` 让重复调用不报错（cleanup 可能被调不止一次）。 */
    dispose: () => {
      fs.rmSync(directory, { recursive: true, force: true })
    },
  }
}

/** 把命令包成沙箱内执行；`shell` 用来跑字符串命令（argv 形式直接前置前缀）。 */
export function sandboxCommand(
  sandbox: PreparedSandbox,
  command: string | readonly string[],
  shell: string,
): readonly string[] {
  // 不运行登录配置；zsh -f 还跳过用户 .zshenv，防止把凭证重新注入命令环境。
  return typeof command === "string"
    ? [...sandbox.prefix, shell, ...(path.basename(shell) === "zsh" ? ["-f"] : []), "-c", command]
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
     * 1. 「在 sandbox-exec 下跑的命令」产出新的 argv，字符串命令会走 shell 解析，而数组就是 argv——内核 execve 直接执行，不经 shell
     * 输出 case：假设 bash 工具传 "pnpm build"
     * inner.exec([
          "/usr/bin/sandbox-exec", "-D",
          "WS=…", "-D", "TMP=…", "-f", "…/profile.sb",
          "/bin/zsh", "-f", "-c", "pnpm build",
        ], options, context)
     * 2. 内核侧的两次系统调用 execve
        spawn(program, args)                      # libuv → posix_spawnp → 内核
        └─ execve("/usr/bin/sandbox-exec", ["-D","WS=…",…,"/bin/zsh","-f","-c","pnpm build"], env)
              ↓ sandbox-exec 自己先跑起来（此时还没沙箱）
              ↓ 读 -f 的 profile.sb、把 -D 标记的参数的 WS/TMP 代入、编译 → 给自己打上沙箱标签
        └─ execve("/bin/zsh", ["-f","-c","pnpm build"], env)      # 标签随进程继承
              └─ zsh fork/exec pnpm → node → esbuild ……        # 每一层都带着同一个标签
     * - 第一次 execve 是内核正常的可执行文件加载， 沙箱是"贴在进程上的内核标签"
       - 第二次系统调用才是真正的执行，执行前需要按照策略文件规则决定是否调用
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
    // 先终止受管理的进程，再删策略；任一清理失败都不能跳过另一项。
    cleanup: async (context: Context) => {
      const errors: unknown[] = []
      try {
        await inner.cleanup(context)
      } catch (error) {
        errors.push(error)
      }
      try {
        sandbox.dispose()
      } catch (error) {
        errors.push(error)
      }
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) throw new AggregateError(errors, "沙箱环境清理失败。")
    },
  }
}
