/**
 * Electron 主进程入口（骨架）。
 *
 * 现在只做三件事：单实例锁、创建窗口、处理 macOS 生命周期。
 * 阶段 5 会在这里加上：存储门禁 → HarnessHost → IpcRouter → WatchHub，
 * 以及 before-quit 里「先停推送、再 await host.close()」的退出顺序。
 */
import path from "node:path"
// `file://` 协议的 URL 对象 / 字符串，转换为操作系统原生的绝对文件路径: file://xxx/xxx/xxx.js -> /xxx/xxx/xxx.js
import { fileURLToPath } from "node:url"
// Electron 主进程基础的导入语句, app: Electron 为应用实例，BrowserWindow：创建桌面窗口（本质上是套了 Chromium 渲染页面）
import { app, BrowserWindow } from "electron"

/**
 * import.meta.url ESModule：内置元属性，返回当前模块文件的 `file://` 绝对 URL 字符串
 * path.dirname：获取当前文件所在的目录路径，/a/b/c.js -> /a/b
 * mainDir：主进程目录路径
 */
const mainDir = path.dirname(fileURLToPath(import.meta.url))
// 开发服务器 URL
const devServerUrl = process.env.PI_DEV_SERVER_URL

// Electron 主进程 api，用来实现单实例应用并锁定，避免多个实例同时运行应用多开，触发时机在应用创建前处理。
const gotLock = app.requestSingleInstanceLock()

if (!gotLock) {
  app.quit()
} else {
  // 声明主窗口变量
  let mainWindow: BrowserWindow | undefined

  // 窗口聚焦
  const focusExisting = (): void => {
    // APP 刚启动，`mainWindow` 还没赋值 → `undefined` → return
    // 用户已经关掉主窗口，`mainWindow` 变量还在，但窗口销毁 → `isDestroyed() = true` → return【isDestroyed：窗口底层原生资源是否已经销毁】
    if (mainWindow === undefined || mainWindow.isDestroyed()) return
    // isMinimized：查询窗口是否处于最小化状态 ；如果是则进行 restore：恢复窗口到正常状态
    if (mainWindow.isMinimized()) mainWindow.restore()
    // focus：将窗口聚焦到最前端，并确保其处于活动状态，确保不被其他窗口遮挡让用户可见
    mainWindow.focus()
  }

  // 创建窗口
  const createWindow = async (): Promise<BrowserWindow> => {
    // new BrowserWindow：ectron 主进程 API，用来创建一个桌面窗口实例（Chromium 渲染窗口）
    const created = new BrowserWindow({
      width: 1100,
      height: 760,
      minWidth: 720,
      minHeight: 480,
      show: false, // 窗口初始状态为隐藏，直到 ready-to-show（页面加载完成-渲染就绪） 事件触发后才显示
      title: "Pi Agent Desktop",
      // 渲染进程沙箱安全组配置
      webPreferences: {
        preload: path.join(mainDir, "../preload/index.cjs"), // 预加载脚本的路径：脚本在渲染页面加载之前运行，作为主进程和渲染进程 IPC 的桥梁
        contextIsolation: true, // 是否隔离上下文，默认 true，隔离上下文可以防止渲染进程访问主进程的 API，提高安全性【contextBridge 依赖这个！】
        nodeIntegration: false, // 是否禁用 Node.js 集成，默认 false，禁用 Node.js 集成可以防止渲染进程访问主进程的 Node.js  API，提高安全性
        sandbox: true, // Chromium 沙箱模式，渲染进程跑在操作系统沙箱里，权限被严格锁住。
        webSecurity: true, // 开启 Chromium 同源策略、CORS 安全校验。
      },
    })

    /**
     * once 只监听一次该事件，触发之后自动解绑
     * ready-to-show：页面加载完成-渲染就绪【首帧渲染完成，DOM 已经可以画出来了，资源可能还没全部加载完。】
     * show：显示窗口
     */
    created.once("ready-to-show", () => created.show())

    /**
     * BrowserWindow.webContents: 窗口里 Chromium 渲染实例 页面加载、导航、console、IPC、页面事件都挂在它上面，是主进程和渲染页打交道的核心对象。
     * did-finish-load：页面主文档 + 所有子资源（js、css、图片、iframe 等）全部加载完成后触发，比 ready-to-show 更晚触发。
     * 调试打印：方便排查渲染进程加载失败的问题。
     */
    created.webContents.on("did-finish-load", () => {
      console.log(
        "[main] 渲染进程已加载",
        devServerUrl ?? "file://…/dist/renderer/index.html",
      )
    })

    /**
     * did-fail-load：页面加载失败时触发
     * 加载失败回调
     */
    created.webContents.on(
      "did-fail-load",
      (_event, code, description, url) => {
        console.error("[main] 渲染进程加载失败", { code, description, url })
      },
    )

    /**
     * render-process-gone：渲染进程意外退出时触发
     */
    created.webContents.on("render-process-gone", (_event, details) => {
      console.error("[main] 渲染进程退出", details)
    })

    /**
     * loadURL：加载一个远程 URL，也支持 `file://`
     * loadFile：专门加载本地静态 HTML 文件，内部自动帮你转成 `file://` 协议 URL，**自动处理平台路径分隔符**
     * 作用：开始加载渲染进程中的页面
     */
    if (devServerUrl !== undefined) await created.loadURL(devServerUrl)
    else await created.loadFile(path.join(mainDir, "../renderer/index.html"))

    return created
  }

  // 当Electron 实例已经存在并运行时，用户点击应用图标时，让已经开着的那个实例把窗口还原并置顶，而不是让第二个进程悄悄跑起来
  app.on("second-instance", focusExisting)

  /**
   * whenReady：Electron 主进程异步api，表示在 Electron 应用初始化完成、准备好创建窗口的时候 resolve。
   * 作用：确保应用在所有平台都准备好后才执行后续操作
   */
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

  /**
   * macOS：关窗不退出（后台任务应继续），从 Dock 回来时重建窗口。
   * 作用：当用户从 Dock 栏点击应用图标时，让已经开着的那个实例把窗口还原并置顶，而不是让第二个进程悄悄跑起来
   */
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length > 0) return
    void createWindow().then(created => {
      mainWindow = created
    })
  })

  /**
   * window-all-closed：所有窗口都被关闭时触发
   * 作用：当用户关闭所有窗口时，退出应用
   */
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit()
  })
}
