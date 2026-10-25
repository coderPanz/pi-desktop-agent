import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createApprovalHook } from "./hooks/approval.ts";
import { createBashTool } from "./tools/bash.ts";
import { createListDirTool } from "./tools/list-dir.ts";
import { createReadFileTool } from "./tools/read-file.ts";
import { createWriteFileTool } from "./tools/write-file.ts";

const ctx = BACKGROUND_CONTEXT;

let root = "";
let workspace = "";

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "coding-guard-"));
  workspace = path.join(root, "workspace");
  const env = new NodeExecutionEnv({ cwd: root });
  await env.createDir(workspace, { recursive: true }, ctx).then((r) => assert.ok(r.ok));
  await env.writeFile(path.join(workspace, "README.md"), "# 内部文件\n", ctx).then((r) => assert.ok(r.ok));
  await env.writeFile(path.join(root, "outside.txt"), "SECRET-OUTSIDE\n", ctx).then((r) => assert.ok(r.ok));
  await env.cleanup(ctx);
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 只填工具真正用到的字段：env 与输出通道，其余按类型断言掉。 */
function fakeApi(): ToolExecutionApi {
  const chunks: string[] = [];
  return {
    env: new NodeExecutionEnv({ cwd: workspace }),
    output: (chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    },
    retainedOutput: () => ({ text: chunks.join(""), truncated: false }),
  } as unknown as ToolExecutionApi;
}

/** 从工具结果里取出文本。 */
const textOf = (result: { output?: unknown }): string =>
  Array.isArray(result.output) ? result.output.map((block) => (block as { text?: string }).text ?? "").join("") : "";

test("read_file 读取工作区外路径被拒绝，且不泄露内容", async () => {
  const tool = createReadFileTool(workspace);
  const result = await tool.execute({ path: "../outside.txt" }, fakeApi(), ctx);
  const text = textOf(result);
  assert.equal(result.isError, true);
  assert.match(text, /拒绝访问|超出工作区/);
  assert.doesNotMatch(text, /SECRET-OUTSIDE/);
});

test("read_file 能读取工作区内文件并带行号", async () => {
  const tool = createReadFileTool(workspace);
  const result = await tool.execute({ path: "README.md" }, fakeApi(), ctx);
  assert.notEqual(result.isError, true);
  assert.match(textOf(result), /1: # 内部文件/);
});

test("list_dir 列出工作区内条目", async () => {
  const tool = createListDirTool(workspace);
  const result = await tool.execute({ path: "." }, fakeApi(), ctx);
  assert.match(textOf(result), /README\.md/);
});

test("write_file 写入工作区外路径被拒绝", async () => {
  const tool = createWriteFileTool(workspace);
  const result = await tool.execute({ path: "../escape.txt", content: "x" }, fakeApi(), ctx);
  assert.equal(result.isError, true);
  assert.match(textOf(result), /拒绝写入|超出工作区/);
});

test("write_file 真的写出文件", async () => {
  const tool = createWriteFileTool(workspace);
  const result = await tool.execute({ path: "notes/ok.txt", content: "hello" }, fakeApi(), ctx);
  assert.notEqual(result.isError, true);
  const env = new NodeExecutionEnv({ cwd: workspace });
  const read = await env.readTextFile(path.join(workspace, "notes/ok.txt"), ctx);
  assert.ok(read.ok);
  assert.equal(read.value, "hello");
  await env.cleanup(ctx);
});

test("bash 普通命令能执行并返回输出", async () => {
  const tool = createBashTool(workspace);
  const result = await tool.execute({ command: "node --version" }, fakeApi(), ctx);
  assert.notEqual(result.isError, true);
  assert.match(textOf(result), /v?\d+\.\d+\.\d+/);
});

test("bash 工作区外 cwd 被拒绝", async () => {
  const tool = createBashTool(workspace);
  const result = await tool.execute({ command: "pwd", cwd: "../" }, fakeApi(), ctx);
  assert.equal(result.isError, true);
  assert.match(textOf(result), /拒绝执行|超出工作区/);
});

/** 直接调用 Hook 的 beforeTool，避免依赖模型是否真的发起调用。 */
async function runHook(toolName: string, args: Record<string, unknown>) {
  const approval = createApprovalHook({ workspace, ask: async () => false });
  const handlers = approval.handlers as {
    beforeTool: (call: { name: string; arguments: unknown }, api: unknown, context: unknown) => Promise<{ block?: string } | undefined>;
  };
  return handlers.beforeTool({ name: toolName, arguments: args }, {}, ctx);
}

test("Hook 直接拒绝 rm -rf /", async () => {
  const result = await runHook("bash", { command: "rm -rf /" });
  assert.ok(result?.block);
  assert.match(result!.block!, /已拒绝/);
});

test("Hook 把 rm 变成需确认，非交互时拒绝", async () => {
  const result = await runHook("bash", { command: "rm -rf build" });
  assert.ok(result?.block);
  assert.match(result!.block!, /用户拒绝执行/);
});

test("Hook 放行普通命令", async () => {
  assert.equal(await runHook("bash", { command: "node --version" }), undefined);
});

test("Hook 拒绝写工作区外路径", async () => {
  const result = await runHook("write_file", { path: "../x.txt" });
  assert.match(result?.block ?? "", /已拒绝/);
});

test("Hook 对未受管工具不拦截", async () => {
  assert.equal(await runHook("read_file", { path: "README.md" }), undefined);
});
