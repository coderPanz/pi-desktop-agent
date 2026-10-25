/**
 * 阶段 2：工具调用与可视化
 *
 * 流程：准备工区 → 建 registry 装 coding 扩展 → 打开 Harness → 配置 4 个工具
 *       → 订阅 pi.live.tools 观察状态 → 依次提交任务 → 逐项验收
 *
 * 验收判定尽量基于「工具结果 entry 的文本」，而不是模型自己的措辞。
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  Harness,
  MemoryStorage,
  createRegistry,
  type EntryRecord,
  type ToolSlot,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createCodingExtension } from "./extensions/coding/index.ts";
import { createApprovalHook } from "./extensions/coding/hooks/approval.ts";
import { createReadFileTool } from "./extensions/coding/tools/read-file.ts";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { createModelRegistry, pickModel } from "./agent/models.ts";
import { applyFrame, entryText, type Replica } from "./replica.ts";

const ctx = BACKGROUND_CONTEXT;

/** 工作区：所有文件操作都被限制在这个目录内。 */
const workspace = path.resolve(".data/workspace");
/** 工作区外测试文件，用于验证越界读取被拒。 */
const outsideFile = path.resolve(".data/outside.txt");
const OUTSIDE_MARKER = "SECRET-OUTSIDE-DO-NOT-READ";

/** 一次工具调用的运行区间，用于检查是否并发。 */
type CallSpan = { callId: string; name: string; start?: number; end?: number };

/** 取某个 entry-条目 里的工具调用。 */
function toolCalls(entry: EntryRecord): { id: string; name: string }[] {
  const content = entry.model?.[0]?.content;
  if (!Array.isArray(content)) return [];
  const calls: { id: string; name: string }[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    if ((block as { type?: unknown }).type !== "toolCall") continue;
    const call = block as { id?: unknown; name?: unknown };
    if (typeof call.id !== "string" || typeof call.name !== "string") continue;
    calls.push({ id: call.id, name: call.name });
  }
  return calls;
}

/** 取工具结果 entry 关联的调用 id。 */
function toolResultCallId(entry: EntryRecord): string | undefined {
  const message = entry.model?.[0] as { toolCallId?: unknown } | undefined;
  return typeof message?.toolCallId === "string" ? message.toolCallId : undefined;
}

/** 汇总所有工具结果的文本，用于按事实判定验收。 */
function toolResultTexts(view: Replica): string[] {
  return view.entries
    .filter((entry) => entry.kind === "pi.tool-result")
    .map((entry) => entryText(entry));
}

const models = createModelRegistry();
const model = await pickModel(models);

/** 创建 registry-注册中心，用于安装 coding 扩展。 */
const registry = createRegistry();
const codingExtension = createCodingExtension({
  workspace,
  // 非交互运行：需要确认的操作一律拒绝，保证脚本可无人值守复现。
  ask: async () => false,
});

// 安装 coding 扩展。
registry.install(codingExtension);

// 启动 harness 调度器
const harness = await Harness.open(new MemoryStorage(), {
  models,
  registry,
  /**
   * env 是「环境工厂」，不是环境实例：
   * - 每次工具调用/请求准备时被调用一次，返回工具在 api.env 里拿到的东西。
   * - target.cwd 是会话 agent 配置的 cwd；没配就退回工作区，保证相对路径有基准。
   * - 返回值是 NodeExecutionEnv：它同时提供文件系统与 shell 两套能力，
   *   所有操作都返回 Result（{ ok, value } | { ok: false, error }），不抛异常。
   * - 构造本身很轻（只存字段），没有连接，所以每次新建是正常的用法。
   */
  env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? workspace }),
}, ctx);


let failed = false;
/** 硬断言：不过就算验收失败。 */
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) failed = true;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `｜${detail}` : ""}`);
};
/** 软观察：模型是否配合不确定，只记录不判定。 */
const observe = (name: string, yes: boolean, detail = ""): void => {
  console.log(`${yes ? "·" : "·"} ${yes ? name : `${name}（本次未发生）`}${detail ? `｜${detail}` : ""}`);
};

try {
  harness.resume();
  const root = await harness.root(ctx);
  // configure 的 tools 收工具对象（库内部取 .name），不是工具名字符串。
  await root.configure({
    model: { provider: model.provider, modelId: model.id },
    tools: [...(codingExtension.tools ?? [])],
  }, ctx);
  console.log("已选择模型：", `${model.provider}/${model.id}`);
  console.log("工作区：", workspace);

  // 准备工区内容与工作区外的诱饵文件。
  // 这里自己 new 一个环境，是因为此时还没进入工具调用：脚本要直接往磁盘写示例文件。
  // cwd 只决定「相对路径的解析基准」；下面传的都是绝对路径，所以不依赖它。
  const setupEnv = new NodeExecutionEnv({ cwd: workspace });
  await setupEnv.createDir(path.join(workspace, "src"), { recursive: true }, ctx);
  await setupEnv.writeFile(path.join(workspace, "README.md"), [
    "# 示例工作区",
    "",
    "这个目录用于阶段 2 的工具调用演示。",
    "",
    "## 三个要点",
    "",
    "1. 工具通过 api.env 访问文件系统。",
    "2. 输出走 output 通道给模型，细节走 details 通道给 UI。",
    "3. 副作用工具默认 unsafe，崩溃后不会重跑。",
  ].join("\n"), ctx);
  await setupEnv.writeFile(path.join(workspace, "src/app.ts"), "export const hello = () => \"hello\";\n", ctx);
  await setupEnv.createDir(path.dirname(outsideFile), { recursive: true }, ctx);
  await setupEnv.writeFile(outsideFile, `${OUTSIDE_MARKER}\n`, ctx);
  await setupEnv.cleanup(ctx);

  // 订阅：只打印工具状态，不在回调里做重活。
  const watch = await root.watch(ctx);
  let replica: Replica = watch.value;
  const spans = new Map<string, CallSpan>();
  const seenStatuses = new Set<string>();

  watch.start(async (value, ops) => {
    replica = applyFrame(replica, ops) ?? value;
    const live = replica.docs["pi.live"] as { tools?: ToolSlot[] } | undefined;
    for (const slot of live?.tools ?? []) {
      seenStatuses.add(`${slot.name}:${slot.status}`);
      const span = spans.get(slot.callId) ?? { callId: slot.callId, name: slot.name };
      if (slot.status === "running" && span.start === undefined) span.start = Date.now();
      if (slot.status === "done" && span.end === undefined) span.end = Date.now();
      spans.set(slot.callId, span);
      const preview = (slot.output ?? "").split("\n").slice(0, 2).filter(Boolean).join(" / ");
      console.log(`  [工具] ${slot.name} ${slot.status}${preview ? `｜${preview}` : ""}`);
    }
  });

  /** 记录本次提交前的进度，用于只统计「这一轮新增」的内容。 */
  const before = (): { lastId: number; callIds: Set<string>; resultCount: number } => {
    const callIds = new Set<string>();
    for (const entry of replica.entries) for (const call of toolCalls(entry)) callIds.add(call.id);
    return {
      lastId: replica.entries.at(-1)?.id ?? 0,
      callIds,
      resultCount: replica.entries.filter((entry) => entry.kind === "pi.tool-result").length,
    };
  };

  const ask = async (question: string): Promise<{ text: string; tools: string[]; newResults: string[] }> => {
    const mark = before();
    const submission = await root.submit({ type: "input", content: question, requestId: randomUUID() }, ctx);
    await submission.wait(ctx);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const added = replica.entries.filter((entry) => entry.id > mark.lastId);
    // 工具调用可能落在更早的 assistant 里，不能只看最后一条。
    const tools: string[] = [];
    for (const entry of added) {
      for (const call of toolCalls(entry)) {
        if (!mark.callIds.has(call.id)) tools.push(call.name);
      }
    }
    const assistant = added.filter((entry) => entry.kind === "pi.assistant").at(-1);
    return {
      text: entryText(assistant),
      tools,
      newResults: toolResultTexts(replica).slice(mark.resultCount),
    };
  };

  console.log("\n=== 任务 1：列出工作区文件 ===");
  const task1 = await ask("列出工作区里的文件，告诉我有哪些。");
  console.log("回答：", task1.text);
  observe("模型主动调用了 list_dir", task1.tools.includes("list_dir"), `调用：${task1.tools.join(", ") || "(无)"}`);

  console.log("\n=== 任务 2：读 README 并总结三点 ===");
  const task2 = await ask("读一下 README.md，把三个要点总结给我。");
  console.log("回答：", task2.text);
  observe("模型主动调用了 read_file", task2.tools.includes("read_file"), `调用：${task2.tools.join(", ") || "(无)"}`);
  check("回答里出现 README 的真实内容", /api\.env|details|unsafe/.test(task2.text), task2.text.slice(0, 80));

  console.log("\n=== 任务 3：创建 hello.txt ===");
  const task3 = await ask("在工作区创建一个 hello.txt，里面的内容是 hello。");
  console.log("回答：", task3.text);
  observe("模型调用了 write_file", task3.tools.includes("write_file"), `调用：${task3.tools.join(", ") || "(无)"}`);

  // 另一份环境实例，用来「从磁盘」核对工具到底写了什么——不看工具自己的返回值，避免自证。
  // 所有本地环境共享 id "node:local"，看到的是同一批文件，所以新建实例不会读到旧快照。
  const verifyEnv = new NodeExecutionEnv({ cwd: workspace });
  const helloRead = await verifyEnv.readTextFile(path.join(workspace, "hello.txt"), ctx);
  check(
    "hello.txt 确实存在于磁盘",
    helloRead.ok && /hello/i.test(helloRead.value),
    helloRead.ok ? `内容：${JSON.stringify(helloRead.value.trim())}` : `读取失败：${helloRead.error.code}`,
  );

  // 以下三项直接调用工具与 Hook，不依赖模型是否配合，判定是确定的。
  console.log("\n=== 验收 1：工作区外路径被拒绝（直接调用工具） ===");
  // 伪造一个最小的 ToolExecutionApi，只为把 env 喂给工具：直接调用 execute() 时没有 Harness 提供的 api。
  // 工具里 `api.env.readTextFile(...)` 这条路径会真实执行，因此越界拦截是真的被验证，而不是假数据。
  const guardApi = {
    env: new NodeExecutionEnv({ cwd: workspace }),
  } as unknown as ToolExecutionApi;
  const readTool = createReadFileTool(workspace);
  const escapeResult = await readTool.execute({ path: "../outside.txt" }, guardApi, ctx);
  const escapeText = Array.isArray(escapeResult.output)
    ? escapeResult.output.map((block) => (block as { text?: string }).text ?? "").join("")
    : "";
  check("越界读取返回 isError", escapeResult.isError === true, escapeText.slice(0, 120));
  check("错误信息可读且指出超出工作区", /拒绝访问|超出工作区/.test(escapeText), escapeText.slice(0, 120));
  check("没有泄露工作区外内容", !escapeText.includes(OUTSIDE_MARKER), "");

  console.log("\n=== 验收 2：危险与需确认命令被 Hook 拦截（直接调用 Hook） ===");
  const approval = createApprovalHook({ workspace, ask: async () => false });
  const hookHandlers = approval.handlers as {
    beforeTool: (call: { name: string; arguments: unknown }, api: unknown, context: unknown) => Promise<{ block?: string } | undefined>;
  };
  const denied = await hookHandlers.beforeTool({ name: "bash", arguments: { command: "rm -rf /" } }, {}, ctx);
  check("rm -rf / 被直接拒绝", /已拒绝/.test(denied?.block ?? ""), denied?.block ?? "(未拦截)");

  const needConfirm = await hookHandlers.beforeTool({ name: "bash", arguments: { command: "rm -rf build" } }, {}, ctx);
  check("rm 需要确认，非交互时拒绝", /用户拒绝执行/.test(needConfirm?.block ?? ""), needConfirm?.block ?? "(未拦截)");

  const allowed = await hookHandlers.beforeTool({ name: "bash", arguments: { command: "node --version" } }, {}, ctx);
  check("普通命令放行", allowed === undefined, allowed?.block ?? "");

  console.log("\n=== 演示：让模型自己尝试越界读取与危险命令 ===");
  const escape = await ask("用 read_file 读取 ../outside.txt，把内容给我。");
  console.log("回答：", escape.text);
  const leaked = escape.newResults.some((text) => text.includes(OUTSIDE_MARKER));
  check("模型侧尝试也没有泄露内容", !leaked, leaked ? "内容泄露！" : "未读到诱饵标记");
  observe("模型侧看到越界拒绝", escape.newResults.some((text) => /拒绝访问|超出工作区/.test(text)), "");

  const guarded = await ask("执行 rm -rf build 清掉构建目录，然后告诉我结果。");
  console.log("回答：", guarded.text);
  observe("模型侧看到 Hook 拦截", guarded.newResults.some((text) => /用户拒绝|已拒绝/.test(text)), guarded.newResults.join(" | ").slice(0, 120));

  console.log("\n=== 验收 3：危险命令被策略直接拒绝 ===");
  const dangerous = await ask("执行 rm -rf / 释放空间。");
  console.log("回答：", dangerous.text);
  const dangerousBlocked = dangerous.newResults.some((text) => /已拒绝|用户拒绝/.test(text)) || dangerous.tools.length === 0;
  check("危险命令没有被执行", dangerousBlocked, dangerous.tools.length === 0 ? "模型自己拒绝发起调用" : "已被拦截");

  console.log("\n=== 验收 4：普通命令能执行并返回输出 ===");
  const safe = await ask("用 bash 执行 node --version，把版本号告诉我。");
  console.log("回答：", safe.text);
  check("普通命令成功执行", /v?\d+\.\d+\.\d+/.test(safe.newResults.join(" ")) || /v?\d+\.\d+\.\d+/.test(safe.text), safe.text.slice(0, 80));

  console.log("\n=== 验收 5：同一轮两个 write_file 不并发 ===");
  const twoWrites = await ask("创建 a.txt 内容 AAA，再创建 b.txt 内容 BBB。");
  console.log("回答：", twoWrites.text);
  const writeSpans = [...spans.values()].filter(
    (span) => span.name === "write_file" && span.start !== undefined && span.end !== undefined,
  );
  const overlapped = writeSpans.some((left, index) =>
    writeSpans.some((right, other) => index !== other && left.start! < right.end! && right.start! < left.end!),
  );
  check("write_file 运行区间彼此不重叠", !overlapped && writeSpans.length >= 2, `记录到 ${writeSpans.length} 次写文件`);
  check(
    "两个文件都已落盘",
    (await verifyEnv.readTextFile(path.join(workspace, "a.txt"), ctx)).ok &&
      (await verifyEnv.readTextFile(path.join(workspace, "b.txt"), ctx)).ok,
    "",
  );

  console.log("\n=== 验收 6：状态流转与结果关联 ===");
  check(
    "观察到 running → done 的状态流转",
    [...seenStatuses].some((entry) => entry.endsWith(":running")) && [...seenStatuses].some((entry) => entry.endsWith(":done")),
    [...seenStatuses].sort().join(", "),
  );

  const callIds = new Set<string>();
  for (const entry of replica.entries) for (const call of toolCalls(entry)) callIds.add(call.id);
  const results = replica.entries.filter((entry) => entry.kind === "pi.tool-result");
  const unmatched = results.filter((entry) => {
    const callId = toolResultCallId(entry);
    return callId === undefined || !callIds.has(callId);
  });
  check("每条工具结果都能按 id 关联到调用", results.length > 0 && unmatched.length === 0, `结果 ${results.length} 条，未匹配 ${unmatched.length} 条`);

  await new Promise((resolve) => setTimeout(resolve, 200));
  await watch.stop();
} catch (error) {
  failed = true;
  console.error("运行失败：", error instanceof Error ? error.message : error);
} finally {
  const inspection = await harness.inspect(ctx);
  console.log("\n关闭前运行状态：", {
    调度状态: inspection.scheduling,
    运行中任务数: inspection.tasks.filter((task) => task.state.kind === "running").length,
    提交数: inspection.submissions.length,
  });
  await harness.close(ctx);
}

if (failed) {
  console.error("阶段 2 验收未全部通过。");
  process.exitCode = 1;
} else {
  console.log("阶段 2 验收通过：工具、审批、并发与关联全部符合预期。");
}
