/**
 * `app.settings`：应用级偏好。
 *
 * Session 作用域的单例——一个数据根只有一份，跟会话无关。
 * kind 一旦写入库就是契约，改名等于让旧数据读不出来。
 */
import { defineDoc } from "@earendil-works/pi-durable"

export type AppTheme = "system" | "light" | "dark"
export type AppLocale = "zh-CN" | "en"

export type AppSettings = {
  theme: AppTheme
  locale: AppLocale
  /** 用户显式选择的模型；缺省时沿用会话 agent 里的配置。 */
  model?: { provider: string; modelId: string }
  /** 每次生成都显示工具调用的完整输出，而不是折叠的分片。 */
  verboseTools: boolean
}

const DEFAULT_SETTINGS: AppSettings = {
  theme: "system",
  locale: "zh-CN",
  verboseTools: false,
}

export const AppSettingsDoc = defineDoc({
  kind: "app.settings",
  version: 1,
  scope: "session",
  initial: (): AppSettings => ({ ...DEFAULT_SETTINGS }),
  // 小文档：攒够一批增量再落一次整帧，避免每次改主题都写一份完整 base。
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 64,
})
