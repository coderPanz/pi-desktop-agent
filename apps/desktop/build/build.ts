/**
 * 构建入口。三种模式：
 *   tsx build/build.ts           构建全部（main + preload + renderer）
 *   tsx build/build.ts --dev     vite dev server + esbuild watch + 启动 Electron
 *   tsx build/build.ts --gate    只构建 main，并用 Electron 跑存储验证
 */
import { spawn } from "node:child_process" // 创建子进程-跑程序
import path from "node:path"
import { fileURLToPath } from "node:url" // 将 file URL 转为标准 path

// 拿到 electron 可执行程序的【绝对路径】
import electronBinary from "electron" 
import { build as esbuild, context as esbuildContext, type Plugin } from "esbuild"
import { build as viteBuild, createServer } from "vite"

// 桌面应用根目录：/apps/desktop
const appRoot = fileURLToPath(new URL("..", import.meta.url)) 
// 构建产物输出目录：apps/desktop/dist
const outDir = path.join(appRoot, "dist")

const electronExe = electronBinary as unknown as string

const isDev = process.argv.includes("--dev")
const isGate = process.argv.includes("--gate")

// 共享配置【主进程、preload 层】
const shared = {
  bundle: true,
  platform: "node" as const, // node 平台规则
  target: "node22", // 目标版本：node22
  sourcemap: true, // 源码映射
  external: ["electron"], // 外部依赖-不进打包产物
  logLevel: "warning" as const, // 日志等级报告
}

// 外部依赖-不进打包产物
const harnessExternal = [
  "@earendil-works/*",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-durable",
  "@earendil-works/chord",
  "@earendil-works/pi-telemetry",
]

// 主进程打包配置
const mainOptions = {
  ...shared,
  external: ["electron", ...harnessExternal],
  // 打包入口
  entryPoints: {
    index: path.join(appRoot, "src/main/index.ts"),
    gate: path.join(appRoot, "src/main/gate.ts"),
  },
  // 打包出口
  outdir: path.join(outDir, "main"),
  outExtension: { ".js": ".mjs" },
  format: "esm" as const,
}

// preload 层打包配置
const preloadOptions = {
  ...shared,
  entryPoints: [path.join(appRoot, "src/preload/index.ts")],
  // eletron 的 preload 沙盒环境不支持 esm，因为沙盒环境下只做了 cjs 的适配，没有 esm 加载器。
  outfile: path.join(outDir, "preload/index.cjs"),
  format: "cjs" as const,
}

// 构建主进程
async function buildMain(): Promise<void> {
  await esbuild(mainOptions)
}

// 构建 preload 层
async function buildPreload(): Promise<void> {
  await esbuild(preloadOptions)
}

// 构建渲染进程
async function buildRenderer(): Promise<void> {
  await viteBuild({ configFile: path.join(appRoot, "vite.config.ts") })
}

/** 
 * 用 Electron 跑一个脚本路径（gate 模式）
 * 用 Node 脚本启动 Electron，把 `main/gate.mjs` 作为 Electron 的主进程入口文件
 */
function runGate(): void {
  const child = spawn(electronExe, [path.join(outDir, "main/gate.mjs")], {
    /**
     * electron 子进程的 stdout、stderr、stdin 直接复用你当前这个 Node 脚本的控制台
     * electron 里面 `console.log`、报错，会直接打印在当前终端，不用自己写 `stdout.on('data')` 监听流。调试非常省事
     */
    stdio: "inherit",
    env: process.env, // 透传环境变量
  })
  child.on("exit", code => {
    process.exit(code ?? 1)
  })
}

/**
 * 启动 Electron 主程序
 * @param devServerUrl 主进程 loadURL
 */
function spawnApp(devServerUrl?: string) {
  /**
   * 创建子进程-启动 electron 程序。
   * 用 electronExe 执行 appRoot 目录：Electron 会读该目录 package.json 的 main 字段，作为主进程入口文件启动
   */
  const child = spawn(electronExe, [appRoot], {
    stdio: "inherit",
    env: {
      ...process.env,
      //  dev 模式注入：electron 主进程通过 process.env.PI_DEV_SERVER_URL 访问
      ...(devServerUrl === undefined
        ? {}
        : { PI_DEV_SERVER_URL: devServerUrl }),
    },
  })
  if (devServerUrl === undefined) child.on("exit", code => process.exit(code ?? 0))
  return child // 返回子进程实例
}

/** dev 模式 */
async function runDev(): Promise<void> {
  await buildMain()
  await buildPreload()

  // 编程式启动 Vite dev server（复用同一份 vite.config.ts，renderer 改动走 HMR）
  const server = await createServer({
    configFile: path.join(appRoot, "vite.config.ts"),
  })
  await server.listen() // 启动并占用该端口，确保监听成功后才继续
  // server.resolvedUrls?.local[0]：http://localhost:5173/
  const url = server.resolvedUrls?.local[0] ?? "http://localhost:5173/"
  console.log(`[dev] renderer: ${url}`)
  let app = spawnApp(url)

  // 重启 Electron。
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
    setup: b => {
      b.onEnd(result => {
        if (result.errors.length === 0) restart()
      })
    },
  })

  // context() 复用一次性构建的配置，加上 watch 即为增量重建（对应 esbuild --watch 的 API 形态）
  const mainCtx = await esbuildContext({
    ...mainOptions,
    plugins: [restartPlugin()],
  })
  const preloadCtx = await esbuildContext({
    ...preloadOptions,
    plugins: [restartPlugin()],
  })
  await mainCtx.watch() // 启动主进程的 watch
  await preloadCtx.watch() // 启动 preload 层的 watch

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

if (isGate) {
  await buildMain()
  runGate()
} else if (isDev) {
  await runDev()
} else {
  // 默认：全量构建一次就结束，不 watch、不拉起 Electron
  await buildMain()
  await buildPreload()
  await buildRenderer()
  console.log("[build] 完成：dist/main、dist/preload、dist/renderer")
}
