/** 模型设置的界面侧状态：读取、保存、清除密钥。 */
import { useCallback, useEffect, useState } from "react"
import type { ModelSettingsView } from "@pi/shared-types"

import { invoke } from "../ipc.ts"

export type ModelSettingsHandle = {
  readonly view: ModelSettingsView | undefined
  readonly refresh: () => Promise<void>
  readonly save: (input: { modelId: string; baseUrl?: string; apiKey?: string }) => Promise<void>
  readonly clearKey: () => Promise<void>
}

export function useModelSettings(loaded: boolean): ModelSettingsHandle {
  const [view, setView] = useState<ModelSettingsView | undefined>(undefined)

  const refresh = useCallback(async () => {
    setView(await invoke("model.get", {}))
  }, [])

  useEffect(() => {
    if (!loaded) return
    void refresh().catch(() => {})
  }, [loaded, refresh])

  const save = useCallback(async (input: { modelId: string; baseUrl?: string; apiKey?: string }) => {
    setView(await invoke("model.save", input))
  }, [])

  const clearKey = useCallback(async () => {
    setView(await invoke("model.clearKey", {}))
  }, [])

  return { view, refresh, save, clearKey }
}