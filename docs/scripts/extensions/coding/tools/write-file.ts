import path from "node:path";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-durable";
import { textOutput } from "../output.ts";
import { displayPath, resolveInside } from "../paths.ts";

/** 写入或覆盖工作区内的文本文件。 */
export function createWriteFileTool(workspace: string) {
  return defineTool({
    name: "write_file",
    description:
      "在工作区内创建或覆盖一个文本文件，父目录会自动创建。path 使用相对工作区根目录的相对路径。会覆盖同名文件，请在 content 里给出完整内容。",
    parameters: Type.Object({
      path: Type.String({ description: "相对工作区根目录的文件路径，例如 notes/todo.md" }),
      content: Type.String({ description: "写入的完整文本内容" }),
    }),
    // 有副作用：崩溃后重跑会写两次，必须保持默认的 unsafe。
    replay: "unsafe",
    // 写文件不能与读并发，整轮按顺序执行。
    executionMode: "sequential",
    outputLimits: { maxBytes: 8 * 1024, maxLines: 100, retain: "head" },
    async execute(args, api, ctx) {
      const env = api.env;
      if (env === undefined) return { isError: true, output: textOutput("当前环境没有文件系统，无法写入文件。") };

      let absolute: string;
      try {
        absolute = resolveInside(workspace, args.path);
      } catch (error) {
        return { isError: true, output: textOutput(`拒绝写入：${error instanceof Error ? error.message : String(error)}`) };
      }

      // 先读旧内容，用于报告这次是新建还是覆盖。
      const existing = await env.exists(absolute, ctx);
      const previous = existing.ok && existing.value ? await env.readTextFile(absolute, ctx) : undefined;
      const previousBytes = previous?.ok ? Buffer.byteLength(previous.value, "utf8") : 0;
      const created = !(existing.ok && existing.value);

      const parent = path.dirname(absolute);
      const madeDir = await env.createDir(parent, { recursive: true }, ctx);
      if (!madeDir.ok) {
        return { isError: true, output: textOutput(`创建目录失败（${madeDir.error.code}）：${displayPath(workspace, parent)}`) };
      }

      const written = await env.writeFile(absolute, args.content, ctx);
      if (!written.ok) {
        return { isError: true, output: textOutput(`写入失败（${written.error.code}）：${displayPath(workspace, absolute)}`) };
      }

      const bytes = Buffer.byteLength(args.content, "utf8");
      const relative = displayPath(workspace, absolute);
      return {
        output: textOutput(`${created ? "已创建" : "已覆盖"} ${relative}，共 ${bytes} 字节。`),
        details: { path: relative, bytes, created, previousBytes },
      };
    },
  });
}
