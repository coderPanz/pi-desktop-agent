/**
 * 流式输出与状态订阅
 * 1. 创建模型注册表、注册表、内存存储
 * 2. 打开会话运行时
 * 3. 配置会话运行时
 * 4. 订阅根会话的结构视图
 * 5. 拿到根会话的初始状态副本
 * 6. 订阅更新，每次状态更新调该回调函数
 * 7. 提交问题
 * 8. 等待提交完成
 * 9. 停止订阅
 * 10. 检查结果
 */

import { randomUUID } from "node:crypto";
import { applyImmutable, isBase, type Op } from "@earendil-works/chord/delta";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  Harness,
  MemoryStorage,
  type ConversationView,
  type EntryRecord,
  type WatchEnd,
} from "@earendil-works/pi-durable";

import { createModelRegistry, pickModel } from "./agent/models.ts";

export type Replica = ConversationView;

type TextBlock = { readonly type?: unknown; readonly text?: unknown };

/**
 * 订阅收到的一批 ops 应用到旧副本 prev（上一个），得到新的会话副本， 整个过程是不可变更新：旧副本 prev + 本帧 ops → 新副本 next
 * @param prev 旧副本
 * @param ops 为这一帧对状态所做的变更
 * @returns 新的会话副本
 */
export function applyFrame(prev: Replica | undefined, ops: readonly Op[]): Replica | undefined {
  /**
   * 空帧处理，表示当前帧没有任何变更，返回上一个帧即可。
   * 这对 React、Vue 或其他响应式 UI 很重要：
      - 没有变化，就不应该触发重渲染；
      - 不应无意义创建一个新的对象。
   */
  if (ops.length === 0) return prev
  return isBase(ops)
    ? applyImmutable<Replica>(undefined, ops) // 整帧替换：直接替换整个副本，避免旧消息残留，已删除的文档仍存在
    : applyImmutable(prev, ops) // 增量帧：基于旧副本进行增量更新
}

/** 从模型内容块中提取供终端显示的纯文本。 */
function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is TextBlock => typeof block === "object" && block !== null)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
}

/** 从实时文档读取尚未落盘的 assistant 文本。 */
function liveText(view: Replica): string {
  const live = view.docs["pi.live"] as { generation?: { message?: { content?: unknown } } } | undefined;
  return textFromContent(live?.generation?.message?.content);
}

/** 从正式 assistant entry 读取已经落盘的最终文本。 */
function entryText(entry: EntryRecord | undefined): string {
  return textFromContent(entry?.model?.[0]?.content);
}

/** 读取界面此刻应显示的文本，优先显示实时消息并在落盘后切换到正式 entry。 */
function displayedText(view: Replica): string {
  const live = liveText(view);
  if (live) return live;
  return entryText(view.entries.filter((entry) => entry.kind === "pi.assistant").at(-1));
}

/** 解析命令行参数，便于分别验证不同的流式提交间隔。 */
function partialIntervalMs(): number {
  const value = process.argv.find((arg) => arg.startsWith("--partial-interval-ms="))?.split("=")[1];
  const parsed = value === undefined ? 100 : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("--partial-interval-ms 必须是正数");
  return parsed;
}

const ctx = BACKGROUND_CONTEXT;
const intervalMs = partialIntervalMs();
const models = createModelRegistry();
const registry = createRegistry();
const storage = new MemoryStorage();
let harness: Harness | undefined;
let watchEnd: WatchEnd | undefined;

try {
  const model = await pickModel(models);
  console.log("已选择模型：", `${model.provider}/${model.id}`);

  harness = await Harness.open(storage, {
    models,
    registry,
    settings: { progress: { partialIntervalMs: intervalMs } },
  }, ctx);
  harness.resume();

  // harness 是会话运行时，root 是根会话
  const root = await harness.root(ctx);
  await root.configure({ model: { provider: model.provider, modelId: model.id } }, ctx);

  // root.watch 订阅这个根会话的结构视图
  const watch = await root.watch(ctx);

  // 拿到根会话的初始状态副本
  let replica: Replica | undefined = watch.value;
  // 帧数
  let frameCount = 0;
  // 整帧数
  let baseFrameCount = 0;

  let callbackError: unknown;
  let lastDisplayedText = "";

  console.log("初始副本：", { 条目数: replica.entries.length, 文档键: Object.keys(replica.docs) });

  // 订阅更新，每次状态更新调该回调函数
  watch.start(async (value, ops) => {
    // 从这行开始，模型每吐一段，这里就被调一次
    try {
      const before = replica
      const beforeJson =
        before === undefined ? undefined : JSON.stringify(before)
      replica = applyFrame(replica, ops) ?? value
      if (before !== undefined && JSON.stringify(before) !== beforeJson)
        throw new Error("applyFrame 修改了旧副本")

      frameCount += 1
      // 如果ops是整帧，则整帧数加1
      if (isBase(ops)) baseFrameCount += 1
      const currentText = displayedText(replica)
      if (currentText && currentText !== lastDisplayedText) {
        lastDisplayedText = currentText
        console.log("当前回答：", currentText)
      }
      console.log("帧摘要：", {
        帧序号: frameCount,
        操作数: ops.length,
        是否整帧: isBase(ops),
        当前文本长度: currentText.length,
      })
    } catch (error) {
      callbackError = error
      console.error(
        "订阅回调处理失败：",
        error instanceof Error ? error.message : error,
      )
    }
  });

  const submission = await root.submit({
    type: "input",
    content: "请用约 200 个汉字分三点解释状态订阅，并确保每一点有具体说明。",
    requestId: randomUUID(),
  }, ctx);
  console.log("已提交问题：", submission.id);

  const settled = await submission.wait(ctx);
  console.log("提交已完成：", { 状态: settled.status, 提交编号: settled.id });
  await new Promise((resolve) => setTimeout(resolve, 500));

  watchEnd = await watch.stop();
  if (callbackError) throw callbackError;
  if (!replica) throw new Error("订阅结束后没有本地副本");

  const assistants = replica.entries.filter((entry) => entry.kind === "pi.assistant");
  const finalEntry = assistants.at(-1);
  const finalText = entryText(finalEntry);
  if (!finalText) throw new Error("没有读取到最终 assistant 文本");
  if (displayedText(replica) !== finalText) throw new Error("当前显示文本与最终 assistant entry 不一致");
  if (intervalMs <= 100 && frameCount < 5) throw new Error(`帧数不足：期望至少 5 帧，实际为 ${frameCount} 帧`);
  if (watchEnd.reason !== "stopped") throw new Error(`订阅停止原因异常：${watchEnd.reason}`);

  console.log("最终回答：", finalText);
  console.log("验收统计：", { 提交间隔毫秒: intervalMs, 总帧数: frameCount, 整帧数: baseFrameCount, 停止原因: watchEnd.reason });
  console.log("阶段 1 验收通过：流式输出、不可变副本和订阅停止行为均符合预期。");
} catch (error) {
  console.error("阶段 1 验收失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  if (harness) {
    const inspection = await harness.inspect(ctx);
    console.log("关闭前运行状态：", {
      调度状态: inspection.scheduling,
      运行中任务数: inspection.tasks.filter((task) => task.state.kind === "running").length,
      提交数: inspection.submissions.length,
    });
    await harness.close(ctx);
    console.log("Harness 已关闭。");
  }
}
