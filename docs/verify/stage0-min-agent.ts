/**
 * 阶段 0 · 工作区与最小 Agent 调用
 *
 * 验收目标（G0）：
 *   1. 提交一句话，拿到完整回答；
 *   2. 打印出的 provider/modelId 与实际配置一致；
 *   3. 同一 requestId 再提交一次，命中同一条 submission；
 *   4. close 前 inspect() 没有 running 任务；
 *   5. 进程自然退出（不 process.exit）。
 *
 * 这一阶段故意用 MemoryStorage：先把链路跑通，落盘是阶段 4 的事。
 */
import { randomUUID } from "node:crypto"

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import {
  createRegistry,
  Harness,
  MemoryStorage,
  type EntryRecord,
} from "@earendil-works/pi-durable"

import { check, observe, report } from "./lib/assert.ts"
import { createModelRegistry, MODEL_ID, pickModel, PROVIDER_ID } from "./lib/models.ts"

/** 从 entry 的 model 消息里取纯文本（content 可能是字符串，也可能是内容块数组）。 */
function messageText(entry: EntryRecord | undefined): string {
  const message = entry?.model?.[0] as unknown as { content?: unknown } | undefined
  const content = message?.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter(
      (block): block is { type?: unknown; text?: unknown } =>
        typeof block === "object" && block !== null,
    )
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("")
}

const ctx = BACKGROUND_CONTEXT
const models = createModelRegistry()
const registry = createRegistry()
const storage = new MemoryStorage()

let harness: Harness | undefined

try {
  const model = await pickModel(models)
  console.log("模型：", `${model.provider}/${model.id}`)

  harness = await Harness.open(storage, { models, registry }, ctx)
  harness.resume()

  const root = await harness.root(ctx)

  // Harness 不知道你想用哪个模型；必须显式给会话选。ModelRef 的字段是 provider + modelId。
  const modelRef = { provider: model.provider, modelId: model.id }
  await root.configure({ model: modelRef }, ctx)
  check(
    "配置的模型与会话一致",
    modelRef.provider === PROVIDER_ID && modelRef.modelId === MODEL_ID,
    `${modelRef.provider}/${modelRef.modelId}`,
  )

  const requestId = randomUUID()
  const submission = await root.submit(
    { type: "input", content: "用一句话介绍你自己。", requestId },
    ctx,
  )
  console.log("提交：", submission.id, "requestId:", requestId)

  const settled = await submission.wait(ctx)
  check("提交结算状态为 done", settled.status === "done", settled.status)

  const page = await root.entries({ order: "descending" }, 20, undefined, ctx)
  const assistant = page.items.find((entry) => entry.kind === "pi.assistant")
  const text = messageText(assistant)
  check("拿到非空的 assistant 回答", text.length > 0, `${text.length} 字`)
  console.log("回答：", text)

  const userEntry = page.items.find((entry) => entry.kind === "pi.user")
  check("转录里有对应的用户条目", userEntry !== undefined, `entry id: ${userEntry?.id}`)

  // 同一个 requestId 再提交一次：应命中同一条 submission，而不是再跑一轮。
  const again = await root.submit(
    { type: "input", content: "用一句话介绍你自己。", requestId },
    ctx,
  )
  check(
    "同一 requestId 命中同一条 submission",
    again.id === submission.id,
    `${submission.id} / ${again.id}`,
  )

  const assistantCount = page.items.filter((entry) => entry.kind === "pi.assistant").length
  observe("当前 assistant 条目数", String(assistantCount))

  const inspection = await harness.inspect(ctx)
  const running = inspection.tasks.filter((task) => task.state.kind === "running")
  console.log("关闭前运行状态：", {
    调度: inspection.scheduling,
    任务: inspection.tasks.map((task) => `${task.record.kind}:${task.state.kind}`),
    提交数: inspection.submissions.length,
  })
  check("没有 running 任务", running.length === 0, `${running.length} 个`)
} catch (error) {
  check("脚本无异常", false, error instanceof Error ? error.message : String(error))
} finally {
  // 必须 await close：否则进程可能挂着不退出，也会误判成「关不掉」。
  if (harness !== undefined) await harness.close(ctx)
  report("阶段 0 验收")
}
