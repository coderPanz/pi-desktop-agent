/**
 * `git_commit`：把本轮改过的文件提交，避免模型自己拼 `git commit -m` 写出乱七八糟的信息。
 *
 * 两条硬规则：
 * 1. **必须显式给 paths**：只提交你点名的那几个文件。没给就从 `git status` 全量提交会把用户
 *    手头未提交的改动一起带走，那不是我们该做的决定。
 * 2. 路径必须在工作区内、必须是 git 仓库里的路径；提交信息长度受限。
 *
 * 不做的事：不 push、不改 branch、不 amend。推送仍然走 `bash git push`（信任模式下免审批）。
 */
import { defineTool } from "@earendil-works/pi-durable"
import type { ExecutionEnv } from "@earendil-works/pi-durable/env"
import { Type } from "typebox"

import type { PathGuard } from "../guard.ts"
import { toolError } from "../results.ts"

const MESSAGE_LIMIT = 4_000
const PATH_LIMIT = 100

const schema = Type.Object({
  message: Type.String({ description: "提交信息。第一行是标题（建议 ≤72 字），需要细节时空一行再写正文。" }),
  paths: Type.Array(Type.String(), {
    minItems: 1,
    maxItems: PATH_LIMIT,
    description: "要提交的文件（相对工作区）。只提交这些，不会把工作区里其他改动一起带上。",
  }),
})

export function createGitCommitTool(options: { readonly guard: PathGuard; readonly workspace: string }) {
  const { guard, workspace } = options
  return defineTool({
    name: "git_commit",
    description:
      "提交指定的若干文件。必须给 paths（只提交这些文件），message 为提交信息。" +
      "不会 push、不会 amend；未跟踪的新文件也会被加入。",
    parameters: schema,
    replay: "unsafe",
    async execute(args, api, context) {
      const env: ExecutionEnv | undefined = api.env
      if (env === undefined) return toolError("no_environment", "没有可用的执行环境。")

      const message = args.message.trim()
      if (message === "") return toolError("invalid_arguments", "提交信息不能为空。")
      if (message.length > MESSAGE_LIMIT) return toolError("invalid_arguments", `提交信息太长（上限 ${String(MESSAGE_LIMIT)} 字）。`)
      const paths = args.paths
      if (paths.length === 0) return toolError("invalid_arguments", "paths 不能为空：只提交你点名的那几个文件。")

      // 先全批校验路径，再交给 git
      const relative: string[] = []
      for (const requested of paths) {
        const verdict = await guard(requested, env, context)
        if (!verdict.ok) return toolError("path_outside_workspace", verdict.reason)
        relative.push(requested)
      }

      const run = async (argv: readonly string[]): Promise<{ ok: boolean; text: string }> => {
        let text = ""
        const result = await env.exec([...argv], {
          cwd: workspace,
          timeout: 120,
          onOutput: chunk => { text += chunk },
        }, context)
        if (!result.ok) return { ok: false, text: result.error.message }
        return { ok: result.value.exitCode === 0, text }
      }

      const added = await run(["git", "add", "--", ...relative])
      if (!added.ok) return toolError("write_failed", `git add 失败：${added.text.trim().slice(0, 400)}`)

      const committed = await run(["git", "commit", "-m", message, "--", ...relative])
      if (!committed.ok) return toolError("write_failed", `git commit 失败：${committed.text.trim().slice(0, 600)}`)

      return {
        output: [{ type: "text", text: `已提交 ${String(relative.length)} 个文件：\n${relative.map(path => `- ${path}`).join("\n")}` }],
        details: { files: relative, message },
      }
    },
  })
}
