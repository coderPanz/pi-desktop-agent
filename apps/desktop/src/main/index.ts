/**
 * Electron 主进程入口（骨架）。
 *
 * 现在只做三件事：单实例锁、创建窗口、处理 macOS 生命周期。
 * 阶段 5 会在这里加上：存储门禁 → HarnessHost → IpcRouter → WatchHub，
 * 以及 before-quit 里「先停推送、再 await host.close()」的退出顺序。
 */
import path from "node:path"
// `file://` 协议的 URL 对象 / 字符串，转换为操作系统原生的绝对文件路径
import { fileURLToPath } from "node:url"

import { app, BrowserWindow } from "electron"

const mainDir = path.dirname(fileURLToPath(import.meta.url))
const devServerUrl = process.env.PI_DEV_SERVER_URL

// 单实例锁必须在 whenReady 之前：两个进程打开同一个 SQLite 会变成两份真相。
const gotLock = app.requestSingleInstanceLock()

if (!gotLock) {
  app.quit()
} else {
  let mainWindow: BrowserWindow | undefined

  const focusExisting = (): void => {
    if (mainWindow === undefined || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }

  const createWindow = async (): Promise<BrowserWindow> => {
    const created = new BrowserWindow({
      width: 1100,
      height: 760,
      minWidth: 720,
      minHeight: 480,
      show: false,
      title: "Pi Agent Desktop",
      webPreferences: {
        // preload 必须是 CJS 产物：sandbox: true 下不支持 ESM preload。
        preload: path.join(mainDir, "../preload/index.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    })

    // show: false + ready-to-show：避免白屏闪一下。
    created.once("ready-to-show", () => created.show())

    // 最小可观测性：出问题时能区分「没加载」「加载失败」「渲染进程崩了」。
    created.webContents.on("did-finish-load", () => {
      console.log("[main] 渲染进程已加载", devServerUrl ?? "file://…/dist/renderer/index.html")
    })
    created.webContents.on("did-fail-load", (_event, code, description, url) => {
      console.error("[main] 渲染进程加载失败", { code, description, url })
    })
    created.webContents.on("render-process-gone", (_event, details) => {
      console.error("[main] 渲染进程退出", details)
    })

    if (devServerUrl !== undefined) await created.loadURL(devServerUrl)
    else await created.loadFile(path.join(mainDir, "../renderer/index.html"))

    return created
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
      mainWindow = await createWindow()
    })
    .catch((error: unknown) => {
      console.error("启动失败：", error)
      app.exit(1)
    })

  // macOS：关窗不退出（后台任务应继续），从 Dock 回来时重建窗口。
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length > 0) return
    void createWindow().then((created) => {
      mainWindow = created
    })
  })

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit()
  })
}
