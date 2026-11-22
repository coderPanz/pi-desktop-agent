/**
 * `app.activity`：会话最近一次"有动静"的墙钟时间（毫秒）。
 *
 * pi-durable 的会话记录只有 id / parent / owner，没有时间戳；
 * 侧栏「最近」要按活跃时间倒序、还要在每行右侧显示"刚刚 / 5分钟前 / 10月22日"，
 * 所以这里单独记一个时间节点：每次用户提交输入时写一次（会话新建、但还没说话时没有这份文档）。
 *
 * conversation 作用域 + latest：跟会话一起走；分叉携带当前值，分叉本身会再写成"现在"。
 */
import { defineDoc } from "@earendil-works/pi-durable"

export type AppActivity = {
  /** 最近一次用户提交输入的时间（epoch 毫秒）。 */
  at: number
}

export const AppActivityDoc = defineDoc({
  kind: "app.activity",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: (): AppActivity => ({ at: 0 }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 16,
})
