/**
 * Electron 主进程入口。
 *
 * 三件事：创建窗口、配置 `DesktopRuntime`（存储 → Harness → IPC/推送）、固定顺序
 */
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Electron 主进程里的三样东西：
 * - `app`：应用生命周期（单实例锁、whenReady、before-quit）与 `userData` 路径；
 * - `BrowserWindow`：窗口（渲染进程的宿主），也是推送的出口 `webContents.send`；
 * - `IpcMainInvokeEvent`：只要类型，用来判断「这条 IPC 是不是自己窗口发来的」。
 */
import { app, BrowserWindow, type IpcMainInvokeEvent } from "electron"

/** 只借类型不借代码：`PushChannel` 是通道名、`PushMap` 是各通道的载荷，`publish` 靠这一对把「通道名 → 载荷」绑死，编译后本行消失。 */
import type { PushChannel, PushMap } from "@pi/shared-types"

/** 把命令通道绑到 `ipcMain`：发送方校验 + 通道白名单，业务全在 runtime 的 router 里 */
import { registerIpc } from "./ipc.ts"
/** 纯 Node 的运行时装配（存储 → Harness → 会话/帧/审批/路由）；不 import electron，因此可单测。 */
import { DesktopRuntime } from "./runtime.ts"

/** `file://` 协议 URL → 原生绝对路径。 */
const mainDir = path.dirname(fileURLToPath(import.meta.url))
/** 开发期由 build 脚本注入的 Vite 地址；生产构建没有它，走本地文件。 */
const devServerUrl = process.env.PI_DEV_SERVER_URL

// 请求单实例锁，确保只有一个实例运行
const gotLock = app.requestSingleInstanceLock()

if (!gotLock) {
  app.quit()
} else {
  let mainWindow: BrowserWindow | undefined // 主窗口
  let runtime: DesktopRuntime | undefined // 运行时
  let unregisterIpc: (() => void) | undefined // 注销 IPC 回调
  //  停流程：「停推送 → 结算审批 → 停帧 → 关 Harness」
  let stopping: Promise<void> | undefined

  // 聚焦已有的窗口
  const focusExisting = (): void => {
    if (mainWindow === undefined || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }

  /** 
   * 只做主进程 → 渲染进程单向推送
   * type PushMap = {
      view: ViewFrame
      "host.status": HostStatus
      approval: ApprovalPush
    }
   *  */
  const publish = <K extends PushChannel>(
    channel: K,
    payload: PushMap[K],
  ): void => {
    if (mainWindow === undefined || mainWindow.isDestroyed()) return
    /**
     * webContents 相当于浏览器的 tab 页：负责加载 HTML、执行渲染进程的 JS
     * 作用：("view", payload) 序列化（结构化克隆）后送到该页面的【渲染进程】
     * 【渲染进程】里所有 ipcRenderer.on("view", handler) 监听收到后调用 handle
     * 
     * 推送链路
     *  Harness 提交了一次变化
          → FrameHub 发帧
          → runtime: options.publish("view", frame)
          → index.ts: mainWindow.webContents.send("view", frame)
          → preload: ipcRenderer.on("view", …)
          → 渲染进程: useConversation 里 applyFrame(...)
     */
    mainWindow.webContents.send(channel, payload) // 【通道名，载荷】
  }

  /** 接受可信任窗口发过来的 IPC。 */
  const isTrustedSender = (event: IpcMainInvokeEvent): boolean =>
    mainWindow !== undefined &&
    !mainWindow.isDestroyed() &&
    event.sender.id === mainWindow.webContents.id

  /** 
   * 创建窗口
   * - new BrowserWindow(...) 创建的是**「一个原生窗口 + 一个页面（webContents）」；渲染进程本身是页面开始加载（loadFile /       
     loadURL）时才由 Chromium 拉起来的
    - webPreferences： 定该页面的权限
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
      webPreferences: {
        preload: path.join(mainDir, "../preload/index.cjs"),
        contextIsolation: true, // 渲染进程与 preload 分处两个上下文，只能经 contextBridge 通信
        nodeIntegration: false, // 渲染进程拿不到 Node
        sandbox: true, // 渲染进程跑在 Chromium 沙箱里
        webSecurity: true, // 同源策略与 CORS 校验保持开启
      },
    })

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
      unregisterIpc?.()
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

      // 先装配再开窗：窗口一出现渲染进程就会调 `app.info`，
      // 那时 handler 必须已经就位（否则报 `No handler registered for 'pi:invoke'`）。
      runtime = await DesktopRuntime.open({
        // 排障与自测用：指向临时数据根，不碰真实 userData。
        dataDir: process.env.PI_DATA_DIR ?? app.getPath("userData"),
        publish,
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

  /**
   * 退出前先把 Harness 关干净：任务状态要写入库、存储要 close。
   * `preventDefault()` 之后自己再 `quit()`，否则异步收尾还没完成进程就没了。
   */
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
