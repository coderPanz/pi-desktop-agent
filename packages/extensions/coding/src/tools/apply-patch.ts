/**
 * `apply_patch`：一次调用改多个文件。
 *
 * 为什么需要它：coding 里「改一处逻辑、跨 3 个文件」很常见，逐个 `edit` 要多次往返，
 * 而且中途失败会留下改一半的状态。
 *
 * 保证：
 * - 路径先全部过 `PathGuard`，有越界就整批拒绝（一个都不写）
 * - 所有改动先在内存里算好并**校验**（oldText 必须在原文里唯一命中）
 * - 落盘用「写临时文件 → 全部 rename」：rename 前任何失败都不动原文件；
 *   rename 阶段失败会把已替换的按旧内容还原
 * - 返回每个文件的路径与行数；具体 diff 由「本轮改动」卡片用 git 现算
 */
import { defineTool } from "@earendil-works/pi-durable"
import type { ExecutionEnv } from "@earendil-works/pi-durable/env"
import { Type } from "typebox"

import type { PathGuard } from "../guard.ts"
import { toolError } from "../results.ts"

const editEntry = Type.Object({
  path: Type.String({ description: "文件路径（相对工作区）。" }),
  edits: Type.Array(
    Type.Object({
      oldText: Type.String({ description: "要替换的原文片段；必须在文件里唯一出现。" }),
      newText: Type.String({ description: "替换成什么。" }),
    }),
    { minItems: 1, description: "同一文件的若干替换；都基于原文匹配，不是逐条累积。" },
  ),
})

const createEntry = Type.Object({
  path: Type.String({ description: "文件路径（相对工作区）。" }),
  content: Type.String({ description: "整文件内容；文件已存在时会被覆盖。" }),
})

const applyPatchSchema = Type.Object({
  patches: Type.Array(Type.Union([editEntry, createEntry]), {
    minItems: 1,
    description: "要改的文件列表；每项要么给 edits（片段替换），要么给 content（整文件写入）。",
  }),
})

type Patch = { readonly path: string; readonly edits?: readonly { oldText: string; newText: string }[]; readonly content?: string }

type Prepared = {
  readonly requested: string
  readonly absolute: string
  readonly before: string | undefined
  readonly after: string
}

/** 片段替换：每个 oldText 必须在原文里唯一命中，命中 0 次或多次都算失败（不猜）。 */
function applyEdits(before: string, edits: readonly { oldText: string; newText: string }[]): { ok: true; text: string } | { ok: false; reason: string } {
  let text = before
  for (const [index, edit] of edits.entries()) {
    const first = text.indexOf(edit.oldText)
    if (first === -1) return { ok: false, reason: `第 ${String(index + 1)} 段 oldText 在文件里找不到` }
    if (text.indexOf(edit.oldText, first + 1) !== -1) {
      return { ok: false, reason: `第 ${String(index + 1)} 段 oldText 命中多处，请写得更具体` }
    }
    text = `${text.slice(0, first)}${edit.newText}${text.slice(first + edit.oldText.length)}`
  }
  return { ok: true, text }
}

export function createApplyPatchTool(options: { readonly guard: PathGuard }) {
  const { guard } = options
  return defineTool({
    name: "apply_patch",
    description:
      "一次修改多个文件：每项给 `edits`（片段替换，oldText 必须唯一命中）或 `content`（整文件写入）。" +
      "先全部校验再落盘，任何一项失败都不会写入任何文件。返回每个文件的 diff。",
    parameters: applyPatchSchema,
    replay: "unsafe",
    async execute(args, api, context) {
      const env: ExecutionEnv | undefined = api.env
      if (env === undefined) return toolError("no_environment", "没有可用的执行环境，无法改文件。")

      const patches = args.patches as readonly Patch[]
      if (patches.length === 0) return toolError("invalid_arguments", "patches 不能为空。")

      // 1. 先把所有路径校验完：有一个越界就整批拒绝
      const resolved: { patch: Patch; absolute: string }[] = []
      for (const patch of patches) {
        const verdict = await guard(patch.path, env, context)
        if (!verdict.ok) return toolError("path_outside_workspace", verdict.reason)
        resolved.push({ patch, absolute: verdict.absolute })
      }

      // 2. 在内存里算出结果并校验（此时一个字节都没写）
      const prepared: Prepared[] = []
      for (const { patch, absolute } of resolved) {
        const exists = await env.exists(absolute, context)
        const current = exists.ok && exists.value ? await env.readTextFile(absolute, context) : undefined
        const before = current?.ok === true ? current.value : undefined
        if (patch.content !== undefined) {
          prepared.push({ requested: patch.path, absolute, before, after: patch.content })
          continue
        }
        if (before === undefined) return toolError("invalid_arguments", `${patch.path} 不存在，无法做片段替换；要新建请用 content。`)
        const result = applyEdits(before, patch.edits ?? [])
        if (!result.ok) return toolError("invalid_arguments", `${patch.path}：${result.reason}`)
        prepared.push({ requested: patch.path, absolute, before, after: result.text })
      }

      // 3. 落盘：写临时文件 → 统一 rename；中途失败回滚已替换的文件
      const { randomUUID } = await import("node:crypto")
      const { rename, rm, writeFile } = await import("node:fs/promises")
      const staged: { target: string; temporary: string; before: string | undefined }[] = []
      try {
        for (const item of prepared) {
          const temporary = `${item.absolute}.pi-patch-${randomUUID()}`
          await writeFile(temporary, item.after, { encoding: "utf8" })
          staged.push({ target: item.absolute, temporary, before: item.before })
        }
      } catch (error) {
        await Promise.all(staged.map(item => rm(item.temporary, { force: true }).catch(() => undefined)))
        return toolError("search_failed", `准备写入失败，未改动任何文件：${error instanceof Error ? error.message : String(error)}`)
      }

      const done: typeof staged = []
      try {
        for (const item of staged) {
          await rename(item.temporary, item.target)
          done.push(item)
        }
      } catch (error) {
        // 回滚：把已经替换掉的文件写回旧内容（旧内容上文里都有）；临时文件清掉
        await Promise.all(done.map(async item => {
          if (item.before === undefined) await rm(item.target, { force: true }).catch(() => undefined)
          else await writeFile(item.target, item.before, { encoding: "utf8" }).catch(() => undefined)
        }))
        await Promise.all(staged.map(item => rm(item.temporary, { force: true }).catch(() => undefined)))
        return toolError("search_failed", `写入失败，已回滚：${error instanceof Error ? error.message : String(error)}`)
      }

      // 不在这里生成 diff：改动的 diff 由「本轮改动」卡片用 git 现算，避免两套格式
      const files = prepared.map(item => ({
        path: item.requested,
        created: item.before === undefined,
        lines: item.after.split("\n").length,
      }))
      return {
        output: [{
          type: "text" as const,
          text: `已修改 ${String(prepared.length)} 个文件：\n${files.map(item => `- ${item.path}${item.created ? "（新建）" : ""}`).join("\n")}`,
        }],
        details: { files },
      }
    },
  })
}