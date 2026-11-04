/// <reference types="vite/client" />

import type { PiBridge } from "@pi/shared-types"

export {}

/**
 * preload 通过 `contextBridge` 暴露的 API。
 *
 * 类型来自 `@pi/shared-types` 的 `PiBridge`（同一个定义三处共用），
 * 这里只补一个 `debug.ping` 用于探活，不再手写第二份契约。
 */
declare global {
  interface Window {
    pi?: PiBridge & {
      debug: {
        ping(): string
      }
    }
  }
}
