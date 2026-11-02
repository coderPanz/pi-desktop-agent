/**
 * 构建入口。三种模式：
 *
 *   tsx build/build.ts           构建全部（main + preload + renderer）
 *   tsx build/build.ts --dev     vite dev server + esbuild watch + 启动 Electron
 *   tsx build/build.ts --gate    只构建 main，并用 Electron 跑存储验证
 *
 * 产物格式是刻意的：
 *   main    → ESM（.mjs）   Electron ≥28 支持 ESM 主进程
 *   preload → CJS（.cjs）   sandbox: true 下 preload 不支持 ESM
 *   renderer→ Vite 产物
 * 
 *  Electron 对「主进程入口文件」没有「必须打包」的要求——它接受你给它的任意路径，能不能跑取决于 Node/Chromium 的模块加载器是否认识那个扩展名和语法【内置 node 环境】
 *  Preload 沙箱模式下的 preload 脚本，是以纯 JS 运行的，**没有 ESM 上下文**。【沙箱是 Electron 的安全机制，隔离 preload 和渲染进程。执行环境不是标准 Node，也不是浏览器页面环境，是 Electron 单独实现的一个受限 JS 虚拟机，**故意砍掉了 ESM 支持**，只提供简化版 `require`。】
 * Renderer 用 Chromium 的 ESM loader：拿不到 Node 内置模块、拿不到 node_modules。所以 import "react" / @tailwindcss/vite / JSX / CSS 必须由 Vite 打包。 
 这也是唯一必须走 bundler 的进程。
 */
import { spawn } from "node:child_process" // 创建子进程，数据以流的形式返回
import path from "node:path"
import { fileURLToPath } from "node:url" // 将 file URL 转为 path

/**
 * `electron` 包的默认导出值，**是一个字符串**，代表当前平台下 electron 可执行文件的绝对路径。
 * 在普通 Node 脚本里拿到 electron 程序路径，搭配 `spawn` 去拉起 electron 进程，等价于命令行跑 `electron`。
 */
import electronBinary from "electron" 
import { build as esbuild, context as esbuildContext, type Plugin } from "esbuild"
import { build as viteBuild, createServer } from "vite"

// 桌面应用根目录（apps/desktop）
const appRoot = fileURLToPath(new URL("..", import.meta.url)) 
// 构建产物输出目录：apps/desktop/dist
const outDir = path.join(appRoot, "dist")

/**
 * electron 可执行文件的绝对路径。运行时它就是字符串，仅用于 spawn 拉起 Electron。
 */
const electronExe = electronBinary as unknown as string

//  "dev":  "tsx build/build.ts --dev"   → isDev
const isDev = process.argv.includes("--dev")
const isGate = process.argv.includes("--gate")

/**
 * main / preload 两个 esbuild 目标的公共配置基线（renderer 不走 esbuild，而是 Vite）。
 * 各自用 `...shared` 浅合并继承；format、entryPoints、outdir/outfile、outExtension
 * 这些唯一差异项刻意留到子配置里写，不要往这里加。
 */
const shared = {
  /** 把 @pi/*、@earendil-works/* 等依赖全部内联进产物（runtime 不再解析 node_modules） */
  bundle: true,
  // 按 Node 的解析条件走
  platform: "node" as const,
  /** 输出语法降到 Node 22：Electron 45 内置的就是 Node 22.x */
  target: "node22",
  /** 生成 .map，让运行时栈追踪能映射回 .ts 源码行号 */
  sourcemap: true,
  /** 唯一不打包的模块：electron 由 Electron 运行时注入，单独打包会去找 CJS 原生绑定而失败 */
  external: ["electron"],
  /** 只输出 warning/error，摘要 */
  logLevel: "warning" as const,
}

/** 主进程：两个入口（正常启动 / 存储门禁）。 */
const mainOptions = {
  ...shared,
  /** 打包入口，每个 key 对应的文件单独执行打包和输出 */
  entryPoints: {
    index: path.join(appRoot, "src/main/index.ts"),
    gate: path.join(appRoot, "src/main/gate.ts"),
  },
  /** 打包出口 */
  outdir: path.join(outDir, "main"),
  /** 打包输出文件类型 */
  outExtension: { ".js": ".mjs" },
  /** Electron ≥28 主进程支持 ESM */
  format: "esm" as const,
}

/** preload：必须是 CJS。 */
const preloadOptions = {
  ...shared,
  entryPoints: [path.join(appRoot, "src/preload/index.ts")],
  /** 单入口用 outfile；扩展名显式 .cjs —— sandbox: true 下 preload 不支持 ESM */
  outfile: path.join(outDir, "preload/index.cjs"),
  format: "cjs" as const,
}

/** 一次性构建主进程 */
async function buildMain(): Promise<void> {
  await esbuild(mainOptions)
}

/** 一次性构建 preload */
async function buildPreload(): Promise<void> {
  await esbuild(preloadOptions)
}

/** 渲染进程交给 Vite 去构建 */
async function buildRenderer(): Promise<void> {
  await viteBuild({ configFile: path.join(appRoot, "vite.config.ts") })
}

/** 
 * 用 Electron 跑一个脚本路径（gate 模式），把退出码透传给调用方。
 * 用 Node 脚本启动 Electron，把 `main/gate.mjs` 作为 Electron 的主进程入口文件
 */
function runGate(): void {
  // 把 gate.mjs 作为 Electron 的应用入口传进去：等价于 `electron dist/main/gate.mjs`，
  const child = spawn(electronExe, [path.join(outDir, "main/gate.mjs")], {
    stdio: "inherit", // 直连父进程 stdio：gate 里的 ✓/✗ 输出直接打到终端
    env: process.env, // 透传环境变量
  })
  // gate 的成败靠退出码表达，这里原样转成本进程退出码（拿不到 code 时按失败处理）
  child.on("exit", (code) => {
    process.exit(code ?? 1)
  })
}

/**
 * 拉起 Electron 主程序。
 * @param devServerUrl 传入时表示 dev 模式：通过 PI_DEV_SERVER_URL 告诉主进程去 loadURL 这个
 *   Vite 地址，而不是加载 dist/renderer 里的静态文件。
 */
function spawnApp(devServerUrl?: string) {
  // 第一个参数给目录而非文件：Electron 会读 apps/desktop/package.json 的 main 字段
  // （./dist/main/index.mjs）作为主进程入口，与 `electron .` 等价。
  const child = spawn(electronExe, [appRoot], {
    stdio: "inherit",
    env: {
      ...process.env,
      // 只在 dev 模式注入，生产构建下不设该变量，主进程自然走本地文件加载分支
      ...(devServerUrl === undefined ? {} : { PI_DEV_SERVER_URL: devServerUrl }),
    },
  })
  // dev 模式下由 runDev 的 watch 负责重启，退出码不结束父进程；
  // 无 devUrl 时则跟随 Electron 的退出码退出。
  if (devServerUrl === undefined) {
    child.on("exit", (code) => process.exit(code ?? 0))
  }
  return child
}

/** dev 模式：先出 main/preload，再起 Vite dev server，最后拉起 Electron 并监听源码变化 */
async function runDev(): Promise<void> {
  // Electron 启动前必须已有 dist/main 与 dist/preload，否则 package.json 的 main 字段指向的文件不存在
  await buildMain()
  await buildPreload()

  // 编程式启动 Vite dev server（复用同一份 vite.config.ts，renderer 改动走 HMR）
  const server = await createServer({ configFile: path.join(appRoot, "vite.config.ts") })
  await server.listen()
  // resolvedUrls 极端情况下可能为空，兜底用 vite.config.ts 里写死的 5173（strictPort）
  const url = server.resolvedUrls?.local[0] ?? "http://localhost:5173/"
  console.log(`[dev] renderer: ${url}`)

  // app 需要可重新赋值：源码变更时会 kill 掉旧进程再拉起新进程
  let app = spawnApp(url)

  /**
   * 重启 Electron。
   * - 150ms 定时器做防抖：一次保存可能同时触发 main 与 preload 两次重建，避免连续 kill/spawn。
   * - `restarting` 是粗略互斥：定时器窗口期内到来的重建请求直接丢弃。
   * - 主进程/preload 无法热替换，只能整进程重启；renderer 走 Vite HMR，不经过这里。
   */
  let restarting = false
  const restart = () => {
    if (restarting) return
    restarting = true
    setTimeout(() => {
      restarting = false
      app.kill()
      app = spawnApp(url)
    }, 150)
  }

  /** esbuild 插件：每次重建结束回调，只有零错误才重启，避免语法错误时把还活着的窗口打断 */
  const restartPlugin = (): Plugin => ({
    name: "restart-on-build",
    setup: (b) => {
      b.onEnd((result) => {
        if (result.errors.length === 0) restart()
      })
    },
  })

  // context() 复用一次性构建的配置，加上 watch 即为增量重建（对应 esbuild --watch 的 API 形态）
  const mainCtx = await esbuildContext({ ...mainOptions, plugins: [restartPlugin()] })
  const preloadCtx = await esbuildContext({ ...preloadOptions, plugins: [restartPlugin()] })
  await mainCtx.watch()
  await preloadCtx.watch()

  // 统一收尾：释放两个 watch 上下文和 dev server，再杀掉 Electron，最后退出
  const shutdown = async () => {
    await mainCtx.dispose()
    await preloadCtx.dispose()
    await server.close()
    app.kill()
    process.exit(0)
  }
  // Ctrl+C / 被 kill 时也走同一套清理，否则会残留 Electron 子进程和占用的 5173 端口
  process.on("SIGINT", () => void shutdown())
  process.on("SIGTERM", () => void shutdown())
}

// 顶层 await 是合法的：package.json 里 type=module，本文件按 ESM 执行。
// 分支顺序上 gate 优先于 dev，但实际 scripts 里二者不会同时传入。
if (isGate) {
  // gate：只构建 main（gate.mjs 在 main 的入口里），然后交给 Electron 跑验证
  await buildMain()
  runGate()
} else if (isDev) {
  await runDev()
} else {
  // 默认：全量构建一次就结束，不 watch、不拉起 Electron（供 electron-builder 打包使用）
  await buildMain()
  await buildPreload()
  await buildRenderer()
  console.log("[build] 完成：dist/main、dist/preload、dist/renderer")
}
