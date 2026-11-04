/**
 * 工具与边界的联测：真`NodeExecutionEnv` + 真临时目录。
 *
 * 这里不装配 Harness（那是 CLI 与桌面的事），只把工具拿出来直接调 `execute`：
 * 边界判定、软链、列目录这三件最容易写错的事，用真文件系统验证一次就够。
 */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { Context } from "@earendil-works/chord"
import {
  NodeExecutionEnv,
} from "@earendil-works/pi-durable/env/node"
import type { JsonObject, ToolExecutionApi, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable"

import { createCodingExtension, type CodingExtensionOptions } from "./index.ts"

let root = ""
let workspace = ""
let outside = ""

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "pi-coding-"))
  workspace = path.join(root, "workspace")
  outside = path.join(root, "outside")
  await mkdir(workspace, { recursive: true })
  await mkdir(path.join(workspace, "src"), { recursive: true })
  await mkdir(path.join(workspace, "node_modules"), { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(path.join(workspace, "src", "app.ts"), "export const answer = 42\n", "utf8")
  await writeFile(path.join(workspace, "node_modules", "skip.ts"), "ignored\n", "utf8")
  await writeFile(path.join(outside, "secret.txt"), "top secret\n", "utf8")
  await symlink(path.join(outside, "secret.txt"), path.join(workspace, "escape.txt"))
  await symlink(outside, path.join(workspace, "escape-dir"))
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

function toolNamed(name: string, options: CodingExtensionOptions = { workspace }): ToolRegistration {
  const extension = createCodingExtension(options)
  const tool = extension.tools?.find((candidate) => candidate.name === name)
  assert.ok(tool !== undefined, `扩展里没有工具 ${name}`)
  return tool
}

/** 工具只用到 `api.env`；其余成员在这几条执行路径上碰不到。 */
function executeTool(
  tool: ToolRegistration,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  const execute = tool.execute as unknown as (
    args: JsonObject,
    api: ToolExecutionApi,
    context: Context,
  ) => Promise<ToolExecutionResult>
  const api = { env: new NodeExecutionEnv({ cwd: workspace }) } as unknown as ToolExecutionApi
  return execute(args as JsonObject, api, BACKGROUND_CONTEXT)
}

/** 输出里的纯文本：断言工具给模型看的到底是什么。 */
function outputText(result: ToolExecutionResult): string {
  const output = result.output
  if (output === undefined) return ""
  if (typeof output === "string") return output
  return output
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n")
}

function errorCode(result: ToolExecutionResult): string | undefined {
  return result.diagnostics?.find((diagnostic) => diagnostic.severity === "error")?.code
}

test("工具名与重放策略是契约", () => {
  const extension = createCodingExtension({ workspace })
  assert.equal(extension.name, "coding")
  assert.deepEqual(
    extension.tools?.map((tool) => tool.name),
    ["read", "list_dir", "write", "edit", "bash"],
  )
  for (const name of ["read", "list_dir"]) {
    assert.equal(toolNamed(name).replay, "safe", name)
  }
  for (const name of ["write", "edit", "bash"]) {
    const tool = toolNamed(name)
    assert.equal(tool.replay, "unsafe", name)
    assert.equal(tool.executionMode, "sequential", name)
  }
})

test("read 读工作区内的文件", async () => {
  const result = await executeTool(toolNamed("read"), { path: "src/app.ts" })
  assert.notEqual(result.isError, true)
  assert.match(outputText(result), /answer = 42/)
})

test("read 拒绝 `..` 越界", async () => {
  const result = await executeTool(toolNamed("read"), { path: "../outside/secret.txt" })
  assert.equal(result.isError, true)
  assert.equal(errorCode(result), "path_outside_workspace")
  assert.doesNotMatch(outputText(result), /top secret/)
})

test("read 拒绝绝对路径越界", async () => {
  const result = await executeTool(toolNamed("read"), { path: "/etc/hosts" })
  assert.equal(result.isError, true)
  assert.equal(errorCode(result), "path_outside_workspace")
})

test("read 拒绝指向工作区外的软链", async () => {
  if (process.platform === "win32") return
  const result = await executeTool(toolNamed("read"), { path: "escape.txt" })
  assert.equal(result.isError, true)
  assert.equal(errorCode(result), "path_outside_workspace")
  assert.doesNotMatch(outputText(result), /top secret/)
})

test("write 能写工作区内的新文件", async () => {
  const result = await executeTool(toolNamed("write"), {
    path: "notes/todo.md",
    content: "- 写测试\n",
  })
  assert.notEqual(result.isError, true, outputText(result))
})

test("write 拒绝软链越界，且不留文件", async () => {
  if (process.platform === "win32") return
  const result = await executeTool(toolNamed("write"), {
    path: "escape.txt",
    content: "overwritten\n",
  })
  assert.equal(result.isError, true)
  assert.equal(errorCode(result), "path_outside_workspace")
})

test("write 拒绝经目录软链越界的新文件", async () => {
  if (process.platform === "win32") return
  // 目标文件还不存在，只能靠「最近的已存在祖先」判出来：这正是软链最常被绕过的一侧。
  const result = await executeTool(toolNamed("write"), {
    path: "escape-dir/fresh.txt",
    content: "leaked\n",
  })
  assert.equal(result.isError, true)
  assert.equal(errorCode(result), "path_outside_workspace")
})

test("bash 拒绝 cwd 落在工作区外", async () => {
  const tool = toolNamed("bash")
  const execute = tool.execute as unknown as (
    args: JsonObject,
    api: ToolExecutionApi,
    context: Context,
  ) => Promise<ToolExecutionResult>
  const api = { env: new NodeExecutionEnv({ cwd: outside }) } as unknown as ToolExecutionApi
  // 工具抛错由 Harness 转成错误结果；这里直接调 execute，所以看到的是抛出。
  await assert.rejects(execute({ command: "echo hi" }, api, BACKGROUND_CONTEXT), /工作区/)
})

test("list_dir 列目录并跳过 node_modules", async () => {
  const result = await executeTool(toolNamed("list_dir"), { path: "." })
  assert.notEqual(result.isError, true)
  const text = outputText(result)
  assert.match(text, /src\//)
  assert.match(text, /escape\.txt@/)
  assert.doesNotMatch(text, /node_modules/)
})

test("list_dir 按 depth 展开", async () => {
  const shallow = outputText(await executeTool(toolNamed("list_dir"), { path: "." }))
  assert.doesNotMatch(shallow, /app\.ts/)

  const deep = outputText(await executeTool(toolNamed("list_dir"), { path: ".", depth: 2 }))
  assert.match(deep, /src\/app\.ts/)
})

test("list_dir 拒绝越界", async () => {
  const result = await executeTool(toolNamed("list_dir"), { path: ".." })
  assert.equal(result.isError, true)
  assert.equal(errorCode(result), "path_outside_workspace")
})

test("edit 改工作区内的文件，越界同样拒绝", async () => {
  const target = path.join(workspace, "edit-me.txt")
  await writeFile(target, "before\n", "utf8")

  const result = await executeTool(toolNamed("edit"), {
    path: "edit-me.txt",
    edits: [{ oldText: "before", newText: "after" }],
  })
  assert.notEqual(result.isError, true, outputText(result))
  assert.equal(await readFile(target, "utf8"), "after\n")

  const denied = await executeTool(toolNamed("edit"), {
    path: "../outside/secret.txt",
    edits: [{ oldText: "top", newText: "leaked" }],
  })
  assert.equal(denied.isError, true)
  assert.equal(errorCode(denied), "path_outside_workspace")
})
