/**
 * `app.trash`：被「删除」的会话 id。
 *
 * 为什么只藏不删：`pi-durable` 的 `Storage` 没有删除接口——会话与条目一旦创建就不可变，
 * 直接删库会破坏 id 单调、commit `seq` 连续和 fork 的祖先链。所以界面的「删除」等于
 * 「从会话列表移除」，条目与任务仍留在库里（想恢复只需把 id 从这份文档里拿掉）。
 *
 * Session 作用域的单例：一个数据根一份，跟具体会话无关。kind 写入库即契约。
 */
import { defineDoc } from "@earendil-works/pi-durable"

export type AppTrash = {
  /** 已从列表移除的会话 id（升序、不重复）。 */
  hidden: number[]
}

export const AppTrashDoc = defineDoc({
  kind: "app.trash",
  version: 1,
  scope: "session",
  initial: (): AppTrash => ({ hidden: [] }),
  // 小文档：攒够一批增量再落一次整帧，避免每删一个会话就写一份完整 base。
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 32,
})
