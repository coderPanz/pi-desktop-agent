/**
 * 构建入口。三种模式：
 *
 *   tsx build/build.ts           构建全部（main + preload + renderer）
 *   tsx build/build.ts --dev     vite dev server + esbuild watch + 启动 Electron
 *   tsx build/build.ts --gate    只构建 main，并用 Electron 跑存储门禁（G2）
 *
 * 产物格式是刻意的：
 *   main    → ESM（.mjs）   Electron ≥28 支持 ESM 主进程
 *   preload → CJS（.cjs）   sandbox: true 下 preload 不支持 ESM
 *   renderer→ Vite 产物
 */
import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

import electronBinary from "electron"
import { build as esbuild, context as esbuildContext, type Plugin } from "esbuild"
import { build as viteBuild, createServer } from "vite"

const appRoot = fileURLToPath(new URL("..", import.meta.url))
const outDir = path.join(appRoot, "dist")
const electronExe = electronBinary as unknown as string

const isDev = process.argv.includes("--dev")
const isGate = process.argv.includes("--gate")

const shared = {
  bundle: true,
  platform: "node" as const,
  target: "node22",
  sourcemap: true,
  external: ["electron"],
  logLevel: "warning" as const,
}

/** 主进程：两个入口（正常启动 / 存储门禁）。 */
const mainOptions = {
  ...shared,
  entryPoints: {
    index: path.join(appRoot, "src/main/index.ts"),
    gate: path.join(appRoot, "src/main/gate.ts"),
  },
  outdir: path.join(outDir, "main"),
  outExtension: { ".js": ".mjs" },
  format: "esm" as const,
}

/** preload：必须是 CJS。 */
const preloadOptions = {
  ...shared,
  entryPoints: [path.join(appRoot, "src/preload/index.ts")],
  outfile: path.join(outDir, "preload/index.cjs"),
  format: "cjs" as const,
}

async function buildMain(): Promise<void> {
  await esbuild(mainOptions)
}

async function buildPreload(): Promise<void> {
  await esbuild(preloadOptions)
}

async function buildRenderer(): Promise<void> {
  await viteBuild({ configFile: path.join(appRoot, "vite.config.ts") })
}

/** 用 Electron 跑一个脚本路径（gate 模式），把退出码透传给调用方。 */
function runGate(): void {
  const child = spawn(electronExe, [path.join(outDir, "main/gate.mjs")], {
    stdio: "inherit",
    env: process.env,
  })
  child.on("exit", (code) => {
    process.exit(code ?? 1)
  })
}

function spawnApp(devServerUrl?: string) {
  const child = spawn(electronExe, [appRoot], {
    stdio: "inherit",
    env: {
      ...process.env,
      ...(devServerUrl === undefined ? {} : { PI_DEV_SERVER_URL: devServerUrl }),
    },
  })
  if (devServerUrl === undefined) {
    child.on("exit", (code) => process.exit(code ?? 0))
  }
  return child
}

async function runDev(): Promise<void> {
  await buildMain()
  await buildPreload()

  const server = await createServer({ configFile: path.join(appRoot, "vite.config.ts") })
  await server.listen()
  const url = server.resolvedUrls?.local[0] ?? "http://localhost:5173/"
  console.log(`[dev] renderer: ${url}`)

  let app = spawnApp(url)

  // 主进程或 preload 变化：重建后重启 Electron（preload 变更只能靠重开窗口生效）。
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

  // 主进程或 preload 变化：重建后重启 Electron（preload 变更只能靠重开窗口生效）。
  const restartPlugin = (): Plugin => ({
    name: "restart-on-build",
    setup: (b) => {
      b.onEnd((result) => {
        if (result.errors.length === 0) restart()
      })
    },
  })

  const mainCtx = await esbuildContext({ ...mainOptions, plugins: [restartPlugin()] })
  const preloadCtx = await esbuildContext({ ...preloadOptions, plugins: [restartPlugin()] })
  await mainCtx.watch()
  await preloadCtx.watch()

  const shutdown = async () => {
    await mainCtx.dispose()
    await preloadCtx.dispose()
    await server.close()
    app.kill()
    process.exit(0)
  }
  process.on("SIGINT", () => void shutdown())
  process.on("SIGTERM", () => void shutdown())
}

if (isGate) {
  await buildMain()
  runGate()
} else if (isDev) {
  await runDev()
} else {
  await buildMain()
  await buildPreload()
  await buildRenderer()
  console.log("[build] 完成：dist/main、dist/preload、dist/renderer")
}
