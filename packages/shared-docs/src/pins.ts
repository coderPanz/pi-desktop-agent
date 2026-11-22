/**
 * `app.pins`：侧栏「最近」里被置顶的会话 id。
 *
 * 置顶是列表排序偏好，不是聊天内容，所以放 session 作用域的单例文档（一个数据根一份），
 * 和 `app.trash` 对称：一个记「不显示」，一个记「排最前」。
 *
 * 为什么不在会话记录里存：`pi-durable` 的会话记录只有 id / parent / owner，且写入即不可变；
 * 置顶是可以反复改的界面偏好，必须放在可以反复提交的文档里。
 */
import { defineDoc } from "@earendil-works/pi-durable"

export type AppPins = {
  /** 置顶的会话 id（保持置顶顺序、不重复）。 */
  pinned: number[]
}

export const AppPinsDoc = defineDoc({
  kind: "app.pins",
  version: 1,
  scope: "session",
  initial: (): AppPins => ({ pinned: [] }),
  // 小文档：攒够一批增量再落一次整帧
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 32,
})
