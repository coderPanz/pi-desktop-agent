/**
 * 最小 Agent 调用
 * 1. 创建模型注册表、注册表、内存存储
 * 2. 打开会话运行时
 * 3. 配置会话运行时
 * 4. 提交问题
 * 5. 等待提交完成
 * 6. 检查结果
 * 7. 关闭会话运行时
 */

// Harness：会话运行时。它管理会话、任务、调度和持久化，模型请求只是其中一步。
// MemoryStorage：内存版存储实现，进程退出数据就没了（阶段 0 故意不落盘）。
// createRegistry：工具/扩展注册表，阶段 0 是空的，后面接工具时往这里注册。
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";

// Context（来自 chord）是一条调用链上的“环境句柄”，负责取消信号传递等。
// BACKGROUND_CONTEXT 是没有任何超时/取消 标记 的根上下文，脚本里一路传下去即可。
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

import { createModelRegistry, pickModel } from "./agent/models.ts";


const messageText = (entry: { model?: readonly any[] } | undefined) => {
  const content = entry?.model?.[0]?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block?.type === "text")
      .map((block) => block.text)
      .join("");
  }
  return "";
};

// 整个脚本共用的上下文
const ctx = BACKGROUND_CONTEXT;

// 模型来源：models.ts 里自建的 gateway provider
const models = createModelRegistry();

// 工具/扩展注册表；阶段 0 没有任何工具，所以是空的
const registry = createRegistry();

// 持久化后端：内存实现。换成 SQLite 时只需要换这一个对象
const storage = new MemoryStorage();

let harness: Harness | undefined;

try {
  // 提取可用模型
  const model = await pickModel(models);
  console.log("模型名称:", `${model.id}`);

  // 打开一个 Harness：把「存储 + 模型集合 + 工具注册表 + 上下文」绑定成一个运行时。
  harness = await Harness.open(storage, { models, registry }, ctx);

  // 拾取和恢复中断的任务，启动调度循环，前置处理排队中的提交
  harness.resume();

  // 拿到默认的根会话（Conversation）。
  const root = await harness.root(ctx);

  // 选择这个会话使用哪个模型
  await root.configure({
    model: { provider: model.provider, modelId: model.id },
  }, ctx);

  // 提交一条用户输入到存储中
  // 底层调度器会执行
  const submission = await root.submit({
    type: "input",
    content: "北京天气怎么样？",
    requestId: crypto.randomUUID(),
  }, ctx);


  // 等待提交任务的完成，任务完成后会将结果写入存储
  const settled = await submission.wait(ctx);
  console.log("本次提交状态:", settled);

  // 从存储中拿到调用结果
  const page = await root.entries({ order: "descending" }, 10, undefined, ctx);
  console.log("page:", page.items.map(e => ({ id: e.id, kind: e.kind })));

  // kind 由系统/应用定义：pi.user 是用户输入，pi.assistant 是模型回复，pi.tool 是工具调用。
  const assistant = page.items.find(e => e.kind === "pi.assistant");
  console.log("assistant.id:", assistant?.id);

  // assistant.model 是这条回复对应的模型消息数组，打印原始结构方便调试
  console.dir(assistant?.model, { depth: 6 });
  console.log("assistant.text:", messageText(assistant));

} catch (error) {
  // 只打印 message，避免把一整段栈打给最终用户
  console.error("运行失败:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  if (harness) {
    // inspect 是运行时快照：
    //   scheduling — "paused" | "running" | "closing"
    //   tasks      — 每个任务的 record（id/kind/...）和 state.kind（running/ready/waiting/completing/blocked）
    //   submissions— 排队中和已放置的提交
    // close 前确认没有 running 任务，避免“明明结束了却还在跑”的错觉。
    const inspection = await harness.inspect(ctx);
    console.log("inspect:", {
      scheduling: inspection.scheduling,
      tasks: inspection.tasks.map(t => `${t.record.kind}:${t.state.kind}`),
      running: inspection.tasks.filter(t => t.state.kind === "running").length,
      submissions: inspection.submissions.length,
    });

    // 停止调度并释放资源。必须 await，否则进程可能挂着不退出。
    await harness.close(ctx);
  }
}
