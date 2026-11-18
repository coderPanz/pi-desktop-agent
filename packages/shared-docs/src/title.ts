/**
 * `app.title`：侧栏上那行标题。
 *
 * 来源是会话里的**第一条用户消息**：不超过 10 个字就直接用原文，超过了让模型压成 10 字以内的摘要。
 * 摘要要落盘（而不是每次列表都问一次模型），所以单独存一份；`from` 记着它是从哪条条目生成的——
 * 条目变了（比如重置后重新开始）才重新生成。
 *
 * conversation 作用域 + latest：跟会话一起走，分叉照旧携带（`fork: "current"`），没有回卷需求。
 */
import { defineDoc } from "@earendil-works/pi-durable"

export type AppTitle = {
  /** 标题文本（已经截到 10 字以内）。 */
  title: string
  /** 生成自哪条条目（第一条用户消息的 id）。 */
  from: number
}

export const AppTitleDoc = defineDoc({
  kind: "app.title",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: (): AppTitle => ({ title: "", from: 0 }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 16,
})
