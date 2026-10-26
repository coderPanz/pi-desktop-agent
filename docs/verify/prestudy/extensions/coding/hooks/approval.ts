import { createInterface } from "node:readline/promises";
import { hook, ToolTask } from "@earendil-works/pi-durable";
import { classify, type Decision } from "../policy.ts";

/** 需要审批的工具。 */
const GUARDED = new Set(["bash", "write_file"]);

/** 一次审批请求。 */
type Ask = (question: string) => Promise<boolean>;

/** 默认审批：交互终端里询问，非交互环境一律拒绝。 */
async function askInTerminal(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * 审批 Hook：只拦 bash 与 write_file。
 * 判定逻辑在 policy.ts 的纯函数里，这里只负责「问人」和「拒绝」。
 *
 * 第一个参数 `ToolTask` 是什么、为什么必须传它：
 *
 * - `ToolTask` 是库内置的「工具执行任务」定义（任务名 `pi.tool`），模型发起的每一次工具调用、
 *   以及工具内部通过 `executeTool()` 发起的嵌套调用，都由这同一个任务承载。
 * - `hook(task, handlers)` 的实现只是 `{ task: task.definition.name, handlers }`，
 *   也就是说它**按任务名匹配**。传 `ToolTask` 等价于声明「我要挂到 `pi.tool` 这个任务上」，
 *   传别的任务（如 GenerationTask）就会挂到别的钩子上。
 * - 作用是让 Harness 在工具任务的执行流程里回调我们：解析工具 → 校验参数 → **跑 beforeTool**
 *   → 记录执行意图（commit）→ 真正 `execute()`。因为卡在「记录意图」之前，
 *   被拦住时工具一行代码都不会执行，也不会留下副作用。
 * - 只有「已安装 + 被当前会话选中」的扩展里的 hook 会被调用；
 *   多个扩展都返回 block 时，第一个生效。
 *
 * beforeTool 的返回值语义（库内实现）：
 *
 * - `{ block: "原因" }` → 调用以 `harnessError("blocked", "Tool call blocked: 原因")` 结束，
 *   作为工具结果写进转录，模型能看到原因，工具不执行。
 * - `{ arguments: {...} }` → 替换参数，随后会重新校验。
 * - 返回 `undefined` → 放行。
 * - 抛异常 → 按 block 处理（异常信息作为原因）。
 */
export function createApprovalHook(options: { workspace: string; ask?: Ask }) {
  const ask = options.ask ?? askInTerminal;

  // hook(ToolTask, ...) 把下面两个处理器注册到 `pi.tool` 任务上。
  return hook(ToolTask, {
    async beforeTool(call, _api, _ctx) {
      // call 已经带上了本次调用的 name 与（校验过的）arguments；嵌套调用还会带 parent。
      if (!GUARDED.has(call.name)) return undefined;

      const args = call.arguments as { command?: unknown; path?: unknown };
      const command = typeof args.command === "string" ? args.command : undefined;
      const path = typeof args.path === "string" ? args.path : undefined;

      // 纯函数判定：不读文件、不问人，只看工具名 + 命令文本 + 路径。
      const verdict = classify({ tool: call.name, command, path, workspaceRoot: options.workspace });

      // deny：直接拒绝，工具不会执行。
      if (verdict.decision === "deny") {
        return { block: `已拒绝：${verdict.reason ?? "命中安全策略"}` };
      }

      // ask：交给用户确认；用户或非交互环境拒绝时同样以 block 结束。
      if (verdict.decision === "ask") {
        const described = command ?? path ?? "(未知参数)";
        const approved = await ask(`即将执行 ${call.name}：${described}\n原因：${verdict.reason ?? "需要确认"}\n是否允许？`);
        if (!approved) return { block: `用户拒绝执行：${verdict.reason ?? call.name}` };
      }

      // 放行：返回 undefined，Harness 继续记录意图并执行工具。
      return undefined;
    },
  });
}

export type { Decision };
