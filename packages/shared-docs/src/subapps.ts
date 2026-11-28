/**
 * `app.subapps`：本机已安装子应用的清单。
 *
 * Session 作用域：子应用属于这台机器上的应用能力，不随某个会话分叉；版本目
 * 录由主进程
 * loader 管理，本文件仅记录哪个版本应当被加载及其可展示状态。
 */
import { defineDoc } from "@earendil-works/pi-durable"
import type { AppSubapps } from "@pi/shared-types"

const INITIAL_SUBAPPS: AppSubapps = { items: [] }

export const AppSubappsDoc = defineDoc({
  kind: "app.subapps",
  version: 1,
  scope: "session",
  initial: (): AppSubapps => ({ items: [...INITIAL_SUBAPPS.items] }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 16,
})
