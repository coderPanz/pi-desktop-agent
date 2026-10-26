/**
 * 阶段 3：中断、排队与多会话 —— 行为实验（不交互）
 *
 * 每个场景用独立会话，跑完断言结果。
 * 运行：pnpm scenarios
 */

import { Type } from "typebox";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import {
  ConversationBusy,
  Harness,
  MemoryStorage,
  createRegistry,
  defineExtension,
  defineTool,
  type ConversationId,
  type ConversationView,
  type EntryRecord,
} from "@earendil-works/pi-durable";
import { createModelRegistry, pickModel } from "./agent/models.ts";
import { SessionManager } from "./core/session/manager.ts";

const ctx = BACKGROUND_CONTEXT;

/** 慢工具：制造「正在忙」的窗口，让 steer / reject / abort 有确定的时机。 */
const slowTask = defineTool({
  name: "slow_task",
  description: "等待指定毫秒后返回，用于测试中断与排队。",
  parameters: Type.Object({
    ms: Type.Integer({ minimum: 1, maximum: 10_000, description: "等待的毫秒数" }),
    label: Type.Optional(Type.String({ description: "可选标签" })),
  }),
  // 没有副作用，但也不标 safe：它只是为了制造「正在忙」的时间窗，重跑没有意义。
  replay: "unsafe",
  /**
   * 工具真正被调用时执行这里。Harness 传三个参数：
   * @param args    已按上面的 TypeBox schema 校验过的参数（ms 必有，label 可选）。
   * @param _api    ToolExecutionApi：推送输出、更新 details、嵌套调用工具等；本工具用不到。
   * @param execCtx 本次调用的 Context；abort() 时它的 abortSignal 会被触发。
   */
  async execute(args, _api, execCtx) {
    // 要做一个「可取消的 sleep」：setTimeout 本身不认识取消信号，所以要自己接信号。
    // 若不接信号，abort() 只能等这段睡眠自然结束（实测过 3988ms），验收要求的「1 秒内空闲」就不成立。
    await new Promise<void>((resolve, reject) => {
      // 取出取消信号；工具没有环境时也可能没有信号，所以后面都用可选链。
      const signal = execCtx.abortSignal;

      // 正常路径：睡够 ms 就完成，并摘掉监听器避免留下悬挂的订阅。
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, args.ms);

      // 取消路径：清掉定时器并 reject，工具任务以错误结束，abort() 因此能立刻返回。
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("slow_task 被取消"));
      };

      // 信号已经取消过时不会补发事件，必须自己主动走一次取消路径。
      if (signal?.aborted) return onAbort();

      // 只订阅一次：触发后由引擎自动移除，不会重复进入取消路径。
      signal?.addEventListener("abort", onAbort, { once: true });
    });

    // 两个通道：output 给模型看，details 给 UI 用。
    return {
      output: [{ type: "text" as const, text: `slow_task 完成：${args.ms}ms${args.label ?? ""}` }],
      details: { ms: args.ms },
    };
  },
});

const registry = createRegistry();
registry.install(defineExtension({ name: "stage3-test", tools: [slowTask] }));

const models = createModelRegistry();
const model = await pickModel(models);

const harness = await Harness.open(new MemoryStorage(), {
  models,
  registry,
  // 让短对话也能被手动压缩（默认 keepRecentTokens 20000，太短就没有可压缩区间）。
  settings: { compaction: { keepRecentTokens: 40, reserveTokens: 2000 } },
}, ctx);
harness.resume();

/** 统计每个会话收到多少帧，用于「切走后后台仍在推进」。 */
const frames = new Map<ConversationId, number>();
const manager = new SessionManager(harness, (id) => frames.set(id, (frames.get(id) ?? 0) + 1));
await manager.init(ctx);

const failed: string[] = [];
const ok = (name: string, pass: boolean, detail = ""): void => {
  if (!pass) failed.push(name);
  console.log(`${pass ? "✓" : "✗"} ${name}${detail ? `｜${detail}` : ""}`);
};

/** 轮询等待条件成立。 */
async function waitFor(label: string, predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`等待超时：${label}`);
}

/** 新建会话并把模型配给它。 */
const newConv = async (): Promise<ConversationId> =>
  (await manager.create(ctx, { model: { provider: model.provider, modelId: model.id } })).id;

/** 触发一次慢工具调用，等它真的开始执行。 */
const startSlow = async (id: ConversationId, ms: number) => {
  const submitted = await manager.submit(id, `调用 slow_task，ms 传 ${ms}，然后告诉我它返回了什么。`, undefined, ctx);
  await waitFor("工具开始执行", () => hasRunningTool(manager.view(id)));
  return submitted;
};

const hasRunningTool = (view: ConversationView | undefined): boolean =>
  ((view?.docs["pi.live"] as { tools?: { status?: string }[] } | undefined)?.tools ?? []).some((slot) => slot.status !== "done");

/** 条目文本。 */
const textOf = (entry: EntryRecord | undefined): string => {
  const content = entry?.model?.[0]?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => (block as { type?: string }).type === "text").map((block) => (block as { text?: string }).text ?? "").join("");
};

const findIndex = (entries: readonly EntryRecord[], predicate: (entry: EntryRecord) => boolean): number => entries.findIndex(predicate);

try {
  console.log(`已选择模型：${model.provider}/${model.id}`);

  // 1. 排队
  console.log("\n=== 1. 忙碌时连发三条（followUp）===");
  {
    const id = await newConv();
    const submissions = [
      await manager.submit(id, "用约 100 字解释什么是消息队列。", undefined, ctx),
      await manager.submit(id, "再举一个实际例子。", undefined, ctx),
      await manager.submit(id, "最后用一句话总结。", undefined, ctx),
    ];
    ok("三次 requestId 不同", new Set(submissions.map((item) => item.requestId)).size === 3);
    await Promise.all(submissions.map((item) => item.submission.wait(ctx)));
    await manager.waitForIdle(id, ctx);

    const entries = await manager.entries(id, ctx);
    const order = entries.filter((entry) => entry.kind === "pi.user" || entry.kind === "pi.assistant").map((entry) => entry.kind.replace("pi.", ""));
    ok("三条输入都在转录里", order.filter((kind) => kind === "user").length === 3);
    ok("按问-答顺序处理", order.join(",") === "user,assistant,user,assistant,user,assistant", order.join(","));
    ok("排队结束后 inbox 为空", ((await manager.inbox(id, ctx))?.length ?? 0) === 0);
  }

  // 2. steer
  console.log("\n=== 2. steer 插在工具轮之后、下次请求之前 ===");
  {
    const id = await newConv();
    const slow = await startSlow(id, 1500);
    const steer = await manager.submit(id, "补充一句：回答里带「补充」两个字。", "steer", ctx);
    await slow.submission.wait(ctx);
    await steer.submission.wait(ctx);
    await manager.waitForIdle(id, ctx);

    const entries = await manager.entries(id, ctx);
    const resultIndex = findIndex(entries, (entry) => entry.kind === "pi.tool-result");
    const steerIndex = findIndex(entries, (entry) => entry.kind === "pi.user" && textOf(entry).includes("补充"));
    const lastAssistant = entries.map((entry) => entry.kind).lastIndexOf("pi.assistant");
    ok("steer 在工具结果之后", steerIndex > resultIndex, `工具结果 ${resultIndex} / steer ${steerIndex}`);
    ok("steer 在最后一条回答之前", steerIndex < lastAssistant, `steer ${steerIndex} / 末条回答 ${lastAssistant}`);
  }

  // 3. reject
  console.log("\n=== 3. 忙碌时 reject 抛 ConversationBusy ===");
  {
    const id = await newConv();
    const slow = await startSlow(id, 1500);
    const before = (await manager.entries(id, ctx)).length;
    let caught: unknown;
    try {
      await manager.submit(id, "这条会被拒绝。", "reject", ctx);
    } catch (error) {
      caught = error;
    }
    const after = (await manager.entries(id, ctx)).length;
    ok("抛出 ConversationBusy", caught instanceof ConversationBusy, caught instanceof Error ? caught.name : String(caught));
    ok("会话内容没变", after === before, `${before} → ${after}`);
    await slow.submission.wait(ctx);
    await manager.waitForIdle(id, ctx);
  }

  // 4. abort
  console.log("\n=== 4. abort 后 1 秒内空闲，内容保留 ===");
  {
    const id = await newConv();
    const slow = await startSlow(id, 5000);
    const startedAt = Date.now();
    const abortMs = await manager.abort(id, ctx);
    await manager.waitForIdle(id, ctx);
    const totalMs = Date.now() - startedAt;

    const inspect = await harness.inspect(ctx);
    const running = inspect.tasks.filter((task) => task.state.kind === "running").length;
    const entries = await manager.entries(id, ctx);
    ok("没有 running 任务", running === 0, `running ${running}`);
    ok("1 秒内变空闲", totalMs < 1000, `共 ${totalMs}ms（abort ${abortMs}ms）`);
    ok("已生成部分保留为 assistant 条目", entries.some((entry) => entry.kind === "pi.assistant"));
    await slow.submission.wait(ctx).catch(() => undefined);
  }

  // 5. 取消 wait 的 ctx
  console.log("\n=== 5. 取消 wait 的 ctx，任务仍在跑 ===");
  {
    const id = await newConv();
    const slow = await startSlow(id, 3000);
    const { context: child, cancel } = withCancel(ctx);
    const waiting = slow.submission.wait(child).then(() => "settled", (error: unknown) => `rejected:${error instanceof Error ? error.name : ""}`);
    cancel();
    const outcome = await waiting;
    const inspect = await harness.inspect(ctx);
    const running = inspect.tasks.filter((task) => task.state.kind === "running").length;
    ok("wait 提前结束", outcome !== "settled" || running > 0, outcome);
    ok("任务仍在运行", running > 0, `running ${running}`);
    await manager.abort(id, ctx);
    await manager.waitForIdle(id, ctx);
    await slow.submission.wait(ctx).catch(() => undefined);
  }

  // 6. fork
  console.log("\n=== 6. fork 后两条时间线互不影响 ===");
  {
    const source = await newConv();
    const base = await manager.submit(source, "用一句话介绍你自己。", undefined, ctx);
    await base.submission.wait(ctx);
    await manager.waitForIdle(source, ctx);

    const at = (await manager.entries(source, ctx)).filter((entry) => entry.kind === "pi.assistant").at(-1)?.id;
    if (at === undefined) throw new Error("没有可用的分叉点");
    const forked = await manager.fork(source, at, ctx);
    ok("分叉得到新会话", forked.id !== source, `${source} → ${forked.id}`);

    const left = await manager.submit(source, "只回复「好的 111」。", undefined, ctx);
    const right = await manager.submit(forked.id, "只回复「好的 222」。", undefined, ctx);
    await left.submission.wait(ctx);
    await right.submission.wait(ctx);
    await manager.waitForIdle(source, ctx);
    await manager.waitForIdle(forked.id, ctx);

    const leftEntries = await manager.entries(source, ctx);
    const rightEntries = await manager.entries(forked.id, ctx);
    let common = 0;
    while (common < leftEntries.length && common < rightEntries.length && leftEntries[common].id === rightEntries[common].id) common += 1;

    const leftTail = textOf(leftEntries.at(-1));
    const rightTail = textOf(rightEntries.at(-1));
    ok("共享共同前缀", common >= 2, `共同 ${common} 条`);
    ok("两边尾部互不污染", !leftTail.includes("222") && !rightTail.includes("111"), `左 ${leftTail.slice(0, 12)} / 右 ${rightTail.slice(0, 12)}`);
  }

  // 7. reset
  console.log("\n=== 7. reset 后看不到旧历史 ===");
  {
    const id = await newConv();
    const seed = await manager.submit(id, "记住数字 4242，只回复「已记住」。", undefined, ctx);
    await seed.submission.wait(ctx);
    await manager.waitForIdle(id, ctx);
    ok("reset 前上下文含 4242", JSON.stringify(await manager.messages(id, ctx)).includes("4242"));

    await manager.reset(id, "上下文重置：忽略之前的内容。", ctx);
    await manager.waitForIdle(id, ctx);
    const after = JSON.stringify(await manager.messages(id, ctx));
    ok("reset 后不含有 4242", !after.includes("4242"));
    ok("reset 后带 handoff", after.includes("上下文重置"));
  }

  // 8. compact
  console.log("\n=== 8. compact 后上下文变短并新增 pi.compaction ===");
  {
    const id = await newConv();
    for (const question of ["用约 120 字解释写放大。", "用约 120 字解释 WAL。", "用约 120 字解释检查点。"]) {
      const submitted = await manager.submit(id, question, undefined, ctx);
      await submitted.submission.wait(ctx);
      await manager.waitForIdle(id, ctx);
    }
    const before = (await manager.messages(id, ctx)).length;
    await manager.compact(id, "总结前三轮要点。", ctx);
    const after = (await manager.messages(id, ctx)).length;
    const hasCompaction = (await manager.entries(id, ctx)).some((entry) => entry.kind === "pi.compaction");
    ok("出现 pi.compaction 条目", hasCompaction);
    ok("消息数变少", after < before, `${before} → ${after}`);
  }

  // 9. 切换会话 + manager 无打印
  console.log("\n=== 9. 切走后后台仍推进，且 manager 不打印 ===");
  {
    const background = await newConv();
    const foreground = await newConv();
    const before = frames.get(background) ?? 0;
    const slow = await startSlow(background, 1500);
    manager.switchTo(foreground);
    await slow.submission.wait(ctx);
    await manager.waitForIdle(background, ctx);

    ok("当前会话已切换", manager.activeId === foreground, `active=${manager.activeId}`);
    ok("后台会话继续收到帧", (frames.get(background) ?? 0) > before, `${before} → ${frames.get(background) ?? 0}`);
    ok("后台会话产出了回答", (await manager.entries(background, ctx)).some((entry) => entry.kind === "pi.assistant"));

    const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("./core/session/manager.ts", import.meta.url), "utf8"));
    ok("manager.ts 里没有 console", !/\bconsole\s*\./.test(source));
  }
} catch (error) {
  failed.push("脚本异常");
  console.error("场景执行出错：", error instanceof Error ? error.message : error);
} finally {
  await manager.dispose();
  await harness.close(ctx);
}

if (failed.length > 0) {
  console.error(`阶段 3 未通过，失败项：${failed.join("、")}`);
  process.exitCode = 1;
} else {
  console.log("\n阶段 3 通过：排队、steer、reject、abort、fork、reset、compact、多会话均符合预期。");
}
