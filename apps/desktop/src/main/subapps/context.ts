/** 已安装子应用能力的独立 system prompt 小节。 */
import type { PromptSection, RegistryReader, ToolRegistration } from "@earendil-works/pi-durable"
import { AppSubappsDoc } from "@pi/shared-docs"

/**
 * 只列 durable 记录与当前 registry snapshot 同时确认存在的工具。
 * 这样安装失败、停用或热卸载后，模型不会被提示词诱导去调用不存在的工具。
 */
export function subappsContextSection(
  registry: RegistryReader<ToolRegistration>,
): PromptSection<ToolRegistration> {
  let cacheKey: string | undefined
  let cacheValue: string | undefined
  return {
    key: "subapps",
    async render(input, context) {
      const document = await input.read.snapshot(AppSubappsDoc, context)
      if (document === undefined) return undefined
      const snapshot = registry.snapshot()
      const available = new Set(snapshot.tools().map(({ tool }) => tool.name))
      const items = document.items
        .filter(item => item.enabled && item.status === "ready")
        .map(item => ({
          title: item.title,
          tools: item.requestedCapabilities.tools.filter(tool => available.has(tool)),
        }))
        .filter(item => item.tools.length > 0)
      const key = JSON.stringify({ items, tools: [...available].sort() })
      if (key === cacheKey) return cacheValue
      cacheKey = key
      cacheValue = items.length === 0
        ? undefined
        : [
            "已安装能力：",
            ...items.flatMap(item => item.tools.map(tool => `- ${tool}（${item.title}）`)),
            "用法：按工具说明直接调用；工具参数 schema 已在工具列表中提供。",
          ].join("\n")
      return cacheValue
    },
  }
}
