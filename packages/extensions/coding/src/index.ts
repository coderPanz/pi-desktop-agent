/**
 * `coding` 扩展：五个本机工具 + 三档审批
 * 工具名：`read` / `list_dir` / `write` / `edit` / `bash`
 * SDK 已经做对了。这里只补 SDK 没做的三件事：`list_dir`、工作区边界、审批
 */
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools"
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable"
import type {
  Extension,
  ToolExecutionMode,
  ToolRegistration,
} from "@earendil-works/pi-durable"
export type { ApprovalContext, ApprovalRequest, Approver } from "./approval.ts"

import os from "node:os"

// 审批
import { DEFAULT_APPROVAL_TIMEOUT_MS, requestApproval, type Approver } from "./approval.ts"
// 工作区边界检查
import { createPathGuard, type PathGuard } from "./guard.ts"
// 路径边界检查
import { isInside } from "./paths.ts"
// 审批策略判断
import { classify, describeCall, type PolicyOptions, type ToolCallView } from "./policy.ts"
// 工具失败结果
import { toolError } from "./results.ts"
// list_dir 工具
import { createListDirTool } from "./tools/list-dir.ts"

/** 扩展名：写进 `pi.agent` 的选择列表 */
export const CODING_EXTENSION_NAME = "coding"

export type CodingExtensionOptions = {
  /**
   * workspace：相对目录的基准，case：src/a.ts 解析为 <workspace>/src/a.ts
   * 文件工具的准入边界： read/list_dir/write/edit 工具的 path 必须落在工作区之内
   * bash 起点 cwd 的校验，起点越界直接失败
  */
  readonly workspace: string
  /** 审批答复通道；不给 = 三档里的 `ask` 一律按拒绝处理。 */
  readonly approve?: Approver
  /** 等答复的超时，默认 120s。 */
  readonly approvalTimeoutMs?: number
  readonly home?: string
}

/** 
 * 先验路径-再执行
 * 越界的调用连文件都不打开
*/
function withPathGuard(tool: ToolRegistration, guard: PathGuard): ToolRegistration {
  return {
    ...tool,
    async execute(args, api, context) {
      const requested = (args as { readonly path?: unknown }).path
      if (typeof requested !== "string") return toolError("invalid_arguments", "缺少 path 参数。")
      const env = api.env
      if (env === undefined) return toolError("no_environment", "没有可用的执行环境。")
      const verdict = await guard(requested, env, context)
      if (!verdict.ok) return toolError("path_outside_workspace", verdict.reason)
      return tool.execute(args, api, context)
    },
  }
}

/** 
 * 覆写重放与并发策略
 * replay（崩溃后这次调用能不能重跑）和 executionMode（这一轮工具调用并行还是串行）
 * replay：SDK 默认 unsafe，我们需要：read / list_dir 要 "safe"：中断后重读一遍结果一样
 * executionMode：SDK 默认跟随全局 settings.toolExecution，默认 "parallel"（harness/agent.js:53），我们需要： write / edit / bash 要 "sequential" 
 */
function withPolicy(
  tool: ToolRegistration,
  policy: { readonly replay?: "safe" | "unsafe"; readonly executionMode?: ToolExecutionMode },
): ToolRegistration {
  return { ...tool, ...policy }
}

/** 
 * 创建 coding 扩展
 * @param options 扩展选项：工作区根、审批通道、超时
 * @returns 扩展实例
 */
export function createCodingExtension(options: CodingExtensionOptions): Extension<ToolRegistration> {
  // 工作区边界检查
  const guard = createPathGuard(options.workspace)
  // 超时
  const timeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS
  // 审批策略
  const policy: PolicyOptions = { home: options.home ?? os.homedir() }

  /**
   * 工具注册表
   * 包括：
   * - 中断后-可重新执行的工具配置
   * - list_dir 工具配置
   * - 中断后-不可重新执行的工具配置
   * - bash 工具配置
   */
  const tools: ToolRegistration[] = [
    // 可重新执行的工具配置
    withPolicy(withPathGuard(createReadTool(), guard), { replay: "safe" }),
    // list_dir 工具配置
    createListDirTool({ guard }),
    // 【写入存储】-【执行命令】工具配置→ 不重放，整轮串行
    withPolicy(withPathGuard(createWriteTool(), guard), {
      replay: "unsafe",
      executionMode: "sequential", // 串行执行
    }),
    // 不能重新执行的工具配置
    withPolicy(withPathGuard(createEditTool(), guard), {
      replay: "unsafe",
      executionMode: "sequential",
    }),
    // bash 工具配置
    withPolicy(
      createBashTool({
        // cwd 由 env 决定；落到工作区外说明装配错了，直接失败而不是硬跑。
        prepare(execution) {
          if (!isInside(options.workspace, execution.cwd)) {
            throw new Error(
              `cwd ${execution.cwd} 在工作区 ${options.workspace} 之外，拒绝执行。`,
            )
          }
        },
      }),
      { replay: "unsafe", executionMode: "sequential" },
    ),
  ]

  /**
   * 执行前的检查
   * - ToolTask：SDK 内置的「一次工具调用」任务（名字 pi.tool），把「解析工具 → 校验参数 → 跑 beforeTool 钩子 → 记执行意图 → 执行 → 跑 afterTool → 落结果」这一  
 串跑成一个崩溃后可恢复的 durable 任务
   *  - block：beforeTool 钩子返回的一个字符串，表示这次调用不许执行——它会被写成模型看到的失败结果 Tool call blocked: <block>，工具一次都不会跑。
   */
  const approvals = hook(ToolTask, {
    // 在工具执行前，检查是否允许执行
    async beforeTool(call, api, context) {
      const view: ToolCallView = { name: call.name, arguments: call.arguments }
      const verdict = classify(view, policy)
      if (verdict === "allow") return undefined
      const summary = describeCall(view)
      if (verdict === "deny") return { block: `禁止执行：${summary}` }
      const approved = await requestApproval(
        {
          tool: call.name,
          summary,
          conversationId: api.conversationId,
          callId: call.id,
        },
        options.approve,
        {
          timeoutMs,
          // 会话被中断或关闭时立刻按拒绝返回：不然要等到超时，关闭方会一直等这次调用结束。
          signal: context.abortSignal,
        },
      )
      return approved ? undefined : { block: `未获批准，已跳过：${summary}` }
    },
  })

  // 定义一个扩展
  return defineExtension({
    name: CODING_EXTENSION_NAME, // "coding"
    tools, // 工具注册表
    hooks: [approvals], // 工具调用前置审批
  })
}
