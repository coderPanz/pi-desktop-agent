/**
 * `app.changes`：最近一轮（一次用户输入）的 git 基线。
 *
 * 只存基线 hash 与轮次标识，diff 与统计都现算——把每轮 patch 落盘会让磁盘长期膨胀。
 * conversation 作用域 + latest：只关心“最近一轮”，分叉随会话携带。
 */
import { defineDoc } from "@earendil-works/pi-durable"

/** 一轮的起点。 */
export type AppChangeRound = {
  /** 这一轮对应的 submission id。 */
  submissionId: number
  /** `git stash create` 得到的起点 commit；空串表示工作区不在 git 仓库或没有基线。 */
  baseline: string
  /** 记录时的墙钟时间（毫秒）。 */
  at: number
}

export type AppChanges = AppChangeRound & {
  /**
   * 最近若干轮的起点，**最新在前**。用来支持「撤销到上一轮」。
   * 旧版本写入的文档没有这个字段，读取时按空数组处理。
   */
  rounds?: AppChangeRound[]
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
