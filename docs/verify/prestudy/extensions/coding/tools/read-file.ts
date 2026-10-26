import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-durable";
import { textOutput } from "../output.ts";
import { displayPath, resolveInside } from "../paths.ts";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;

/** 读取工作区内的文本文件，返回带行号的内容。 */
export function createReadFileTool(workspace: string) {
  return defineTool({
    name: "read_file",
    description:
      "读取工作区内的文本文件，返回带行号的内容。path 使用相对于工作区根目录的相对路径；只用于文本，不要用于二进制文件。文件不存在时先用 list_dir 查看目录。",
    parameters: Type.Object({
      path: Type.String({ description: "相对工作区根目录的文件路径，例如 src/app.ts" }),
      offset: Type.Optional(Type.Integer({ minimum: 1, description: "起始行号，从 1 开始" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT, description: `最多读取多少行，默认 ${DEFAULT_LIMIT}` })),
    }),
    replay: "safe",
    executionMode: "parallel",
    outputLimits: { maxBytes: 64 * 1024, maxLines: 800, retain: "head" },
    async execute(args, api, ctx) {
      const env = api.env;
      if (env === undefined) return { isError: true, output: textOutput("当前环境没有文件系统，无法读取文件。") };

      let absolute: string;
      try {
        absolute = resolveInside(workspace, args.path);
      } catch (error) {
        return { isError: true, output: textOutput(`拒绝访问：${error instanceof Error ? error.message : String(error)}`) };
      }

      const read = await env.readTextFile(absolute, ctx);
      if (!read.ok) {
        const code = read.error.code;
        const hint = code === "not_found" ? "文件不存在，请先用 list_dir 查看目录。" : "请确认路径与权限。";
        return { isError: true, output: textOutput(`读取失败（${code}）：${displayPath(workspace, absolute)}。${hint}`) };
      }

      const lines = read.value.split(/\r?\n/);
      const offset = (args.offset ?? 1) - 1;
      const limit = args.limit ?? DEFAULT_LIMIT;
      const slice = lines.slice(offset, offset + limit);
      const truncated = offset + slice.length < lines.length;
      const numbered = slice.map((line, index) => `${offset + index + 1}: ${line}`).join("\n");

      return {
        output: textOutput(
          truncated
            ? `${numbered}\n[已截断：共 ${lines.length} 行，当前显示第 ${offset + 1}-${offset + slice.length} 行]`
            : numbered,
        ),
        details: { path: displayPath(workspace, absolute), totalLines: lines.length, truncated },
      };
    },
  });
}
