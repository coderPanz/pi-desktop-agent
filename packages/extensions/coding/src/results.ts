/**
 * 工具的失败结果：`isError` + 一条 `diagnostics`，内容同时给模型看
 * 工具的预期失败不抛异常（抛了 Harness 也会转成错误结果），这样 `details`、诊断与结构化输出都还在我们的控制里。
 */
import type { ToolExecutionResult } from "@earendil-works/pi-durable"

/** 机器可读的错误码：出现在 `diagnostics[].code`，UI 与测试按它断言。 */
export type ToolErrorCode =
  | "path_outside_workspace"
  | "no_environment"
  | "invalid_arguments"
  | "list_failed"

/** 一次失败的工具结果。 */
export function toolError(code: ToolErrorCode, message: string): ToolExecutionResult {
  return {
    output: [{ type: "text", text: message }],
    isError: true,
    diagnostics: [{ severity: "error", code, message }],
  }
}
