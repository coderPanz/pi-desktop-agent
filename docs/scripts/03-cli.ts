/**
 * 阶段 3：交互式会话 CLI
 *
 * 读一行：是命令就调 manager，不是命令就发给当前会话。
 * 打印只在这里做，manager 保持无输出。
 * 运行：pnpm cli
 */

import { createInterface } from "node:readline/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  Harness,
  MemoryStorage,
  createRegistry,
  type ConversationId,
  type ConversationView,
  type EntryId,
  type InboxItem,
} from "@earendil-works/pi-durable";
import { createModelRegistry, pickModel } from "./agent/models.ts";
import { SessionManager, type WhenBusy } from "./core/session/manager.ts";

const ctx = BACKGROUND_CONTEXT;
const tag = (id: ConversationId): string => `[${id}]`;

const models = createModelRegistry();
const model = await pickModel(models);
const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, ctx);
harness.resume();

/** 已经打印过的 assistant 条数与工具状态，用来只输出新变化。 */
const printed = new Map<ConversationId, number>();
const toolState = new Map<ConversationId, string>();

const manager = new SessionManager(harness, (id, view) => {
  // 工具状态：只在变化时打印。
  const tools = (view.docs["pi.live"] as { tools?: { name: string; status: string }[] } | undefined)?.tools ?? [];
  const summary = tools.map((slot) => `${slot.name}:${slot.status}`).join(", ");
  if (summary !== "" && summary !== toolState.get(id)) {
    toolState.set(id, summary);
    console.log(`${tag(id)} 工具 ${summary}`);
  }

  // 新落盘的 assistant 回答。
  const assistants = view.entries.filter((entry) => entry.kind === "pi.assistant");
  const seen = printed.get(id) ?? 0;
  if (assistants.length > seen) {
    console.log(`${tag(id)} 回答：${textOf(assistants.at(-1)?.model?.[0]?.content)}`);
    printed.set(id, assistants.length);
  }
});

/** 取内容块里的文本。 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => (block as { type?: string }).type === "text")
    .map((block) => (block as { text?: string }).text ?? "")
    .join("");
}

/** 排队项摘要。 */
function describeInbox(item: InboxItem): string {
  if (item.mode === "write") return `写入 ${JSON.stringify(item.entry).slice(0, 50)}`;
  return (typeof item.content === "string" ? item.content : JSON.stringify(item.content)).slice(0, 50);
}

const help = [
  "命令：",
  "  /new /list /switch <id> /abort /fork <entryId>",
  "  /reset /compact [提示] /inbox /mode followup|steer /help /exit",
  "其他输入一律视为消息，发给当前会话。",
].join("\n");

const root = await manager.init(ctx);
// 根会话也要明确指定模型，否则提交会因为「没有模型」直接失败。
await root.configure({ model: { provider: model.provider, modelId: model.id } }, ctx);

let mode: WhenBusy = "followUp";
const rl = createInterface({ input: process.stdin, output: process.stdout });
// 用异步迭代器读行：管道输入结束时会正常 done，不会像 rl.question 那样挂住。
const lines = rl[Symbol.asyncIterator]();
const ask = async (prompt: string): Promise<string | undefined> => {
  process.stdout.write(prompt);
  const { value, done } = await lines.next();
  return done ? undefined : value;
};

console.log(`已选择模型：${model.provider}/${model.id}`);
console.log(help);

try {
  for (;;) {
    const answer = await ask(`\n${tag(manager.active())} > `);
    if (answer === undefined) break;
    const line = answer.trim();
    if (line === "") continue;

    // 普通输入：一行只创建一个提交。
    if (!line.startsWith("/")) {
      try {
        const { requestId } = await manager.submit(manager.active(), line, mode, ctx);
        console.log(`${tag(manager.active())} 已提交（${mode}，requestId ${requestId.slice(0, 8)}）`);
      } catch (error) {
        console.log(`${tag(manager.active())} 提交失败：${error instanceof Error ? error.name : String(error)}`);
      }
      continue;
    }

    const [command, ...rest] = line.split(/\s+/);
    const argument = rest.join(" ").trim();

    try {
      if (command === "/exit") {
        break;
      } else if (command === "/help") {
        console.log(help);
      } else if (command === "/new") {
        const created = await manager.create(ctx, { model: { provider: model.provider, modelId: model.id } });
        manager.switchTo(created.id);
        console.log(`已新建并切换到 ${tag(created.id)}`);
      } else if (command === "/list") {
        for (const id of manager.ids()) {
          const count = manager.view(id)?.entries.length ?? 0;
          console.log(`  ${id === manager.activeId ? "*" : " "} ${id}\t条目 ${count}\t${manager.busy(id) ? "忙碌" : "空闲"}`);
        }
      } else if (command === "/switch") {
        const target = Number(argument) as ConversationId;
        manager.switchTo(target);
        console.log(`已切换到 ${tag(target)}`);
      } else if (command === "/abort") {
        const ms = await manager.abort(manager.active(), ctx);
        await manager.waitForIdle(manager.active(), ctx);
        console.log(`${tag(manager.active())} 已中断（${ms}ms）`);
      } else if (command === "/fork") {
        const forked = await manager.fork(manager.active(), Number(argument) as EntryId, ctx);
        manager.switchTo(forked.id);
        console.log(`已分叉到 ${tag(forked.id)}`);
      } else if (command === "/reset") {
        const handoff = (await ask("重置原因："))?.trim();
        if (handoff === undefined) break;
        await manager.reset(manager.active(), handoff === "" ? "上下文重置。" : handoff, ctx);
        console.log(`${tag(manager.active())} 已开始新上下文`);
      } else if (command === "/compact") {
        const { taskId } = await manager.compact(manager.active(), argument === "" ? undefined : argument, ctx);
        console.log(`${tag(manager.active())} 压缩完成（task ${taskId}）`);
      } else if (command === "/inbox") {
        const items = (await manager.inbox(manager.active(), ctx)) ?? [];
        console.log(items.length === 0 ? "  没有排队的输入" : items.map((item) => `  ${item.id}\t${item.mode}\t${describeInbox(item)}`).join("\n"));
      } else if (command === "/mode") {
        const next = argument.toLowerCase();
        if (next !== "followup" && next !== "steer") throw new Error("用法：/mode followup|steer");
        mode = next === "steer" ? "steer" : "followUp";
        console.log(`默认忙碌策略：${mode}`);
      } else {
        console.log(`未知命令：${command}`);
      }
    } catch (error) {
      console.log(`${tag(manager.active())} 命令失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
} finally {
  rl.close();
  await manager.dispose();
  await harness.close(ctx);
}
