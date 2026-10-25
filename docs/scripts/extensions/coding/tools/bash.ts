import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-durable";
import { textOutput } from "../output.ts";
import { resolveInside } from "../paths.ts";

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 120_000;

/** 在工作区内执行 shell 命令，输出边跑边推给 UI。 */
export function createBashTool(workspace: string) {
  return defineTool({
    name: "bash",
    description:
      "在工作区内执行 shell 命令，返回退出码与已合并的输出。cwd 使用相对工作区根目录的路径，默认工作区根目录。命令有超时保护，超过时限会被杀掉。",
    parameters: Type.Object({
      command: Type.String({ description: "要执行的命令，例如 ls -la 或 node --version" }),
      cwd: Type.Optional(Type.String({ description: "相对工作区根目录的工作目录，默认为工作区根目录" })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: MAX_TIMEOUT_MS, description: `超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}` })),
    }),
    replay: "unsafe",
    executionMode: "sequential",
    // 输出可能无限：只保留尾部，避免写放大。
    outputLimits: { maxBytes: 64 * 1024, maxLines: 800, retain: "tail" },
    async execute(args, api, ctx) {
      const env = api.env;
      if (env === undefined) return { isError: true, output: textOutput("当前环境无法执行命令（没有 env）。") };

      let cwd: string;
      try {
        cwd = resolveInside(workspace, args.cwd ?? ".");
      } catch (error) {
        return { isError: true, output: textOutput(`拒绝执行：${error instanceof Error ? error.message : String(error)}`) };
      }

      const startedAt = Date.now();
      const result = await env.exec(args.command, {
        cwd,
        timeout: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        // 边跑边推：UI 与模型都能看到进行中的输出。
        onOutput: (text) => api.output(text),
      }, ctx);

      const durationMs = Date.now() - startedAt;
      const retained = api.retainedOutput();
      const exitCode = result.ok ? result.value.exitCode : undefined;

      if (!result.ok) {
        const code = result.error.code;
        const reason = code === "timeout" ? `命令超时（${args.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms）已被终止` : `命令执行失败（${code}）`;
        return {
          isError: true,
          output: textOutput(`${reason}。已捕获输出：\n${retained.text || "(无输出)"}`),
          details: { command: args.command, exitCode: null, durationMs, truncated: retained.truncated },
        };
      }

      const output = retained.text.trim();
      const body = output === "" ? "，无输出" : `，输出：\n${output}`;
      const suffix = retained.truncated ? "\n[输出已截断]" : "";
      return {
        output: textOutput(`退出码 ${exitCode}${body}${suffix}`),
        details: { command: args.command, exitCode: exitCode ?? null, durationMs, truncated: retained.truncated },
      };
    },
  });
}
