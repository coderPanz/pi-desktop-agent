/**
 * `app.workspace` 存的是「界面长什么样」，不是聊天内容。
 *
 * 三样东西：钉在左边的文件、停在哪个页面（聊天 / 改了什么 / 文件列表）、有没有没看的报错。
 *
 * 用处很朴素：下次打开这个会话，界面还是你上次走开时的样子。每个会话各存一份，不会串。
 *
 * 为什么不放浏览器本地存储：它得跟聊天记录挨在一起，才能一起备份，
 * 也才能在「从第 2 条消息分叉」时把界面回到那一刻——第 2 条时你钉了 1 个文件、
 * 停在聊天页，分出来的新会话看到的就是这 1 个文件和聊天页，不是你后来钉的 4 个。
 *
 * 现在还没接上：等做界面时才真正读写，眼下没有代码用它。
 */
import { defineDoc } from "@earendil-works/pi-durable"

export type AppWorkspace = {
  /** 钉在顶部的文件，路径相对会话 cwd。 */
  pinned: string[]
  /** 界面停在哪个视图，默认 `chat`。 */
  view: "chat" | "diff" | "files"
  /** 最近一次要显示的错误；成功后清空。 */
  lastError?: { message: string; at: number }
}

/** kind 写入库即契约；攒够 32 条增量再落一次整帧，省写入。 */
export const AppWorkspaceDoc = defineDoc({
  kind: "app.workspace",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: (): AppWorkspace => ({ pinned: [], view: "chat" }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 32,
})
