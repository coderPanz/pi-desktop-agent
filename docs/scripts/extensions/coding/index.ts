import { defineExtension } from "@earendil-works/pi-durable";
import { createApprovalHook } from "./hooks/approval.ts";
import { createBashTool } from "./tools/bash.ts";
import { createListDirTool } from "./tools/list-dir.ts";
import { createReadFileTool } from "./tools/read-file.ts";
import { createWriteFileTool } from "./tools/write-file.ts";

export { classify, splitCommand } from "./policy.ts";
export { displayPath, resolveInside } from "./paths.ts";

/** 四个工具的名字，仅用于展示与日志。 */
export const CODING_TOOL_NAMES = ["read_file", "list_dir", "write_file", "bash"] as const;

export type CodingExtensionOptions = {
  /** 工作区根目录，所有路径都被限制在它内部。 */
  workspace: string;
  /** 覆盖审批询问方式，测试时可注入总是同意/总是拒绝。 */
  ask?: (question: string) => Promise<boolean>;
  /** 关闭审批 Hook，仅用于演示；默认开启。 */
  withoutApproval?: boolean;
};

/** coding 扩展：读写文件、执行命令，并对危险操作做审批。 */
export function createCodingExtension(options: CodingExtensionOptions) {
  const { workspace } = options;
  return defineExtension({
    name: "coding",
    tools: [
      createReadFileTool(workspace),
      createListDirTool(workspace),
      createWriteFileTool(workspace),
      createBashTool(workspace),
    ],
    hooks: options.withoutApproval ? [] : [createApprovalHook({ workspace, ask: options.ask })],
  });
}
