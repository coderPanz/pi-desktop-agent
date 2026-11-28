/**
 * Electron 主进程入口
 * 三件事：创建窗口、配置 `DesktopRuntime`（存储 → Harness → IPC/推送）
 */
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Electron 主进程
 * - `app`：控制 electron 应用生命周期
 * - `BrowserWindow`：创建渲染进程和 electron 窗口
 * - `IpcMainInvokeEvent`：ipc 调用事件的工具和类型
 */
import { app, BrowserWindow, type IpcMainInvokeEvent } from "electron"
// 推送通信（通信的一种）
import type { PushChannel, PushMap } from "@pi/shared-types"

/** 把命令通道绑到 `ipcMain`：发送方校验 + 通道白名单  */
import { registerIpc } from "./ipc.ts"
/** 纯 Node 的运行时装配（存储 → Harness → 会话/帧/审批/路由）； */
import { DesktopRuntime } from "./runtime.ts"
import { loadDesktopEnv } from "./config.ts"

/** `file://` 协议 URL → 原生绝对路径。 */
const mainDir = path.dirname(fileURLToPath(import.meta.url))
if (!app.isPackaged) loadDesktopEnv(path.resolve(app.getAppPath(), "../../.env"))
const devServerUrl = process.env.PI_DEV_SERVER_URL

// 单例锁
const gotLock = app.requestSingleInstanceLock()

if (!gotLock) {
  app.quit()
} else {
  let mainWindow: BrowserWindow | undefined // 主窗口
  let runtime: DesktopRuntime | undefined // 桌面端 harness 运行时
  let unregisterIpc: (() => void) | undefined // 注销 IPC 回调
  //  停流程：「停推送 → 结算审批 → 停帧 → 关 Harness」
  let stopping: Promise<void> | undefined

  // 聚焦已有的窗口
  const focusExisting = (): void => {
    if (mainWindow === undefined || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }

  // 主进程 → 渲染进程：单向推送
  const publish = <K extends PushChannel>(
    channel: K, // 通道名
    payload: PushMap[K], // 通道载荷
  ): void => {
    if (mainWindow === undefined || mainWindow.isDestroyed()) return
    /**
     * webContents 相当于浏览器的 tab 页：负责加载 HTML、执行渲染进程的 JS
     * 将消息发送给渲染进程：渲染进程通过 ipcRenderer.on(channel, …) 监听并处理
     */
    mainWindow.webContents.send(channel, payload) // 【通道名，载荷】
  }

  /** 接受可信任窗口发过来的 IPC */
  const isTrustedSender = (event: IpcMainInvokeEvent): boolean =>
    mainWindow !== undefined &&
    !mainWindow.isDestroyed() &&
    event.sender.id === mainWindow.webContents.id

  /** 
   * 创建窗口
   * - new BrowserWindow(...) 创建的是「一个原生窗口 + 一个页面（webContents）」；
    - webPreferences 定该页面的权限
    - loadFile(...) → 让这个页面开始加载，此时才有渲染进程；ready-to-show 后 show() 才画到屏幕上
  */
  const createWindow = async (): Promise<BrowserWindow> => {
    const created = new BrowserWindow({
      width: 1100,
      height: 760,
      minWidth: 720,
      minHeight: 480,
      show: false, // 等 ready-to-show，避免白屏一闪
      title: "Pi Agent Desktop",
      backgroundColor: process.platform === "darwin" ? "#00000000" : "#ffffff",
      ...(process.platform === "darwin"
        ? {
            titleBarStyle: "hiddenInset" as const,
            trafficLightPosition: { x: 18, y: 24 },
            vibrancy: "sidebar" as const,
            visualEffectState: "followWindow" as const,
          }
        : {}),
      webPreferences: {
        preload: path.join(mainDir, "../preload/index.cjs"),
        contextIsolation: true, // 渲染进程与 preload 分处两个上下文，只能经 contextBridge 通信
        nodeIntegration: false, // 渲染进程拿不到 Node
        sandbox: true, // 渲染进程跑在 Chromium 沙箱里
        webSecurity: true, // 同源策略与 CORS 校验保持开启
      },
    })

    // loadFile/loadURL 期间页面就会调用 IPC，发送方校验必须已经认识这个窗口
    mainWindow = created
    created.once("ready-to-show", () => created.show())

    created.webContents.on("did-finish-load", () => {
      console.log(
        "[main] 渲染进程已加载",
        devServerUrl ?? "file://…/dist/renderer/index.html",
      )
    })
    created.webContents.on(
      "did-fail-load",
      (_event, code, description, url) => {
        console.error("[main] 渲染进程加载失败", { code, description, url })
      },
    )
    created.webContents.on("render-process-gone", (_event, details) => {
      console.error("[main] 渲染进程退出", details)
    })

    if (devServerUrl !== undefined) await created.loadURL(devServerUrl)
    else await created.loadFile(path.join(mainDir, "../renderer/index.html"))

    return created
  }

  /** 收尾：停推送 → 结算审批 → 停帧 → 关 Harness（连存储一起收）。顺序在 `DesktopRuntime.close()` 里。 */
  const shutdown = (): Promise<void> => {
    stopping ??= (async () => {
      console.log("[main] 开始收尾：停推送 → 结算审批 → 停帧 → 关 Harness")
      unregisterIpc?.() // 注销 IPC 回调，也就是注销 pi.invoke 的ipc监听
      unregisterIpc = undefined
      await runtime?.close()
      runtime = undefined
      console.log("[main] 收尾完成")
    })()
    return stopping
  }

  app.on("second-instance", focusExisting)

  app
    .whenReady()
    .then(async () => {
      console.log("[main] 启动", {
        electron: process.versions.electron,
        node: process.versions.node,
        chrome: process.versions.chrome,
      })

      // 主进程开始配置 desktop-harness-runtime
      runtime = await DesktopRuntime.open({
        dataDir: process.env.PI_DATA_DIR ?? app.getPath("userData"),
        publish,
        restart: () => {
          app.relaunch()
          // 先让 IPC 返回确认，再经 before-quit 的正常收尾路径退出。
          setTimeout(() => app.quit(), 100)
        },
        appVersion: app.getVersion(),
        platform: process.platform,
        versions: {
          electron: process.versions.electron,
          node: process.versions.node,
          chrome: process.versions.chrome,
        },
        log: (line, detail) => {
          if (process.env.PI_LOG_LEVEL === "debug")
            console.log("[core]", line, detail ?? "")
        },
      })

      unregisterIpc = registerIpc({ runtime, isTrustedSender })
      console.log("[main] 运行时就绪", { dataDir: runtime.info.dataDir })

      mainWindow = await createWindow()
    })
    .catch((error: unknown) => {
      console.error("启动失败：", error)
      app.exit(1)
    })

  /** 窗口已存在时聚焦，否则创建新窗口 */
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length > 0) {
      focusExisting()
      return
    }
    void createWindow().then(created => {
      mainWindow = created
    })
  })

  // 退出前先把 Harness 关干净
  app.on("before-quit", event => {
    if (stopping !== undefined) return
    event.preventDefault()
    void shutdown()
      .catch((error: unknown) => console.error("[main] 收尾失败", error))
      .finally(() => app.quit())
  })

  app.on("window-all-closed", () => {
    // macOS 上关窗不退出：后台任务该继续跑（Harness 还在主进程里）。
    if (process.platform !== "darwin") app.quit()
  })
}
