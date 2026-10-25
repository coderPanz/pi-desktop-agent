export {}

/**
 * preload 通过 contextBridge 暴露的 API。
 *
 * 这份声明与 preload 的实现是两份文件（渲染进程不能 import preload），
 * 所以阶段 5 接入 IPC 后，PiApi 要从 @pi/shared-types 的 IpcMap 推导，
 * 而不是在这里手写第二份。
 */
declare global {
  interface Window {
    pi?: {
      debug: {
        ping(): string
      }
    }
  }
}
