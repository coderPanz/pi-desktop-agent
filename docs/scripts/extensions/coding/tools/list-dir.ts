import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-durable";
import { textOutput } from "../output.ts";
import { displayPath, resolveInside } from "../paths.ts";

/** 列目录时忽略的目录名。 */
const IGNORED = new Set(["node_modules", ".git", ".cache", "dist", "build"]);
const MAX_DEPTH = 3;
const MAX_ENTRIES = 400;

type Line = { depth: number; label: string };

/** 列出工作区内的目录与文件，默认只看一层。 */
export function createListDirTool(workspace: string) {
  return defineTool({
    name: "list_dir",
    description:
      "列出工作区内的目录与文件名，不读取文件内容。path 省略时列出工作区根目录；depth 控制递归深度，默认 1。自动忽略 node_modules、.git 等目录。",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "相对工作区根目录的目录路径，省略表示根目录" })),
      depth: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_DEPTH, description: "递归深度，默认 1" })),
    }),
    replay: "safe",
    executionMode: "parallel",
    outputLimits: { maxBytes: 32 * 1024, maxLines: 500, retain: "head" },
    async execute(args, api, ctx) {
      const env = api.env;
      if (env === undefined) return { isError: true, output: textOutput("当前环境没有文件系统，无法列目录。") };

      let absolute: string;
      try {
        absolute = resolveInside(workspace, args.path ?? ".");
      } catch (error) {
        return { isError: true, output: textOutput(`拒绝访问：${error instanceof Error ? error.message : String(error)}`) };
      }

      const depth = args.depth ?? 1;
      const lines: Line[] = [];
      let truncated = false;

      const walk = async (dir: string, level: number): Promise<void> => {
        if (level > depth || truncated) return;
        const listed = await env.listDir(dir, ctx);
        if (!listed.ok) {
          lines.push({ depth: level, label: `[无法读取：${listed.error.code}]` });
          return;
        }
        const sorted = [...listed.value].sort(
          (a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name),
        );
        for (const entry of sorted) {
          if (lines.length >= MAX_ENTRIES) {
            truncated = true;
            return;
          }
          if (entry.kind === "directory" && IGNORED.has(entry.name)) continue;
          const isDirectory = entry.kind === "directory";
          lines.push({
            depth: level,
            label: isDirectory ? `${entry.name}/` : `${entry.name} (${entry.size} B)`,
          });
          if (isDirectory) await walk(entry.path, level + 1);
        }
      };

      await walk(absolute, 1);

      if (lines.length === 0) {
        return {
          output: textOutput(`${displayPath(workspace, absolute)} 是空目录。`),
          details: { path: displayPath(workspace, absolute), entries: 0, truncated: false },
        };
      }

      const rendered = lines.map((line) => `${"  ".repeat(line.depth - 1)}${line.label}`).join("\n");

      return {
        output: textOutput(truncated ? `${rendered}\n[已截断：条目超过 ${MAX_ENTRIES} 个]` : rendered),
        details: { path: displayPath(workspace, absolute), entries: lines.length, truncated },
      };
    },
  });
}
