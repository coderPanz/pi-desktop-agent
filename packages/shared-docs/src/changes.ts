/**
 * `app.changes`：最近一轮（一次用户输入）的 git 基线。
 *
 * 只存基线 hash 与轮次标识，diff 与统计都现算——把每轮 patch 落盘会让磁盘长期膨胀。
 * conversation 作用域 + latest：只关心“最近一轮”，分叉随会话携带。
 */
import { defineDoc } from "@earendil-works/pi-durable"

export type AppChanges = {
  /** 这一轮对应的 submission id；0 表示还没有记录。 */
  submissionId: number
  /** `git stash create` 得到的起点 commit；空串表示工作区不在 git 仓库或没有基线。 */
  baseline: string
  /** 写入时的墙钟时间（毫秒）。 */
  at: number
}

export const AppChangesDoc = defineDoc({
  kind: "app.changes",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: (): AppChanges => ({ submissionId: 0, baseline: "", at: 0 }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 16,
})
