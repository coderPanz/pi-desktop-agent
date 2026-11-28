import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import type { TestContext } from "node:test"
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context"
import type { Context } from "@earendil-works/chord"
import { err, FileError } from "@earendil-works/pi-durable/env"
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node"

import { createPathGuard } from "./guard.ts"
import { isInside, normalizeToolPath, resolveInside } from "./paths.ts"

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-guard-test-"))
  const workspace = path.join(root, "workspace")
  fs.mkdirSync(workspace)
  const env = new NodeExecutionEnv({ cwd: workspace })
  t.after(async () => {
    await env.cleanup(BACKGROUND_CONTEXT)
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, workspace, env, guard: createPathGuard(workspace) }
}

test("词法边界、相邻前缀、工具路径归一化", () => {
  const root = path.resolve("workspace")
  assert.equal(isInside(root, `${root}-outside/file`), false)
  assert.equal(isInside(root, path.join(root, "..foo")), true)
  assert.equal(isInside(root, path.join(root, "..", "outside")), false)
  assert.equal(normalizeToolPath("@a\u00a0b"), "a b")
  assert.equal(resolveInside(root, "../outside", root).ok, false)
})

test("已有文件、待创建文件和深层新目录可用，不依赖固定的八层上限", async t => {
  const { workspace, env, guard } = fixture(t)
  fs.writeFileSync(path.join(workspace, "existing"), "ok")
  for (const target of ["existing", "new", `${"a/".repeat(12)}new`]) {
    assert.equal((await guard(target, env, BACKGROUND_CONTEXT)).ok, true, target)
  }
  assert.equal((await guard("../outside", env, BACKGROUND_CONTEXT)).ok, false)
})

test("有效工作区软链及指向内部的软链可用，指向外部或不存在外部目标的软链拒绝", async t => {
  const { root, workspace, env, guard } = fixture(t)
  fs.symlinkSync(workspace, path.join(workspace, "inside"))
  fs.symlinkSync(root, path.join(workspace, "outside"))
  fs.symlinkSync(path.join(root, "missing"), path.join(workspace, "dangling"))
  assert.equal((await guard("inside/new", env, BACKGROUND_CONTEXT)).ok, true)
  for (const target of ["outside/new", "dangling", "dangling/nested/new"]) {
    assert.equal((await guard(target, env, BACKGROUND_CONTEXT)).ok, false, target)
  }
  const linkedRoot = path.join(root, "linked-workspace")
  fs.symlinkSync(workspace, linkedRoot)
  const linkedEnv = new NodeExecutionEnv({ cwd: linkedRoot })
  assert.equal((await createPathGuard(linkedRoot)("new", linkedEnv, BACKGROUND_CONTEXT)).ok, true)
})

test("根失效、根不是目录或请求取消时拒绝，不继续信任缓存", async t => {
  const { root, workspace, env, guard } = fixture(t)
  assert.equal((await guard("new", env, BACKGROUND_CONTEXT)).ok, true)
  const canonical = env.canonicalPath.bind(env)
  t.mock.method(env, "canonicalPath", (target: string, context: Context) => target === workspace
    ? Promise.resolve(err(new FileError("permission_denied", "denied")))
    : canonical(target, context))
  assert.equal((await guard("new", env, BACKGROUND_CONTEXT)).ok, false)
  const file = path.join(root, "file")
  fs.writeFileSync(file, "not a directory")
  assert.equal((await createPathGuard(file)(file, env, BACKGROUND_CONTEXT)).ok, false)
  const { context, cancel } = withCancel(BACKGROUND_CONTEXT)
  cancel()
  assert.equal((await guard("new", env, context)).ok, false)
  assert.equal((await createPathGuard(path.join(root, "missing"))("new", env, BACKGROUND_CONTEXT)).ok, false)
})

for (const code of ["permission_denied", "unknown", "aborted", "not_directory"] as const) {
  test(`目标解析发生 ${code} 时拒绝，不向上寻找一个看起来合法的父目录`, async t => {
    const { workspace, env, guard } = fixture(t)
    const target = path.join(workspace, "new")
    const canonical = env.canonicalPath.bind(env)
    t.mock.method(env, "canonicalPath", (requested: string, context: Context) => requested === target
      ? Promise.resolve(err(new FileError(code, "cannot resolve")))
      : canonical(requested, context))
    assert.equal((await guard("new", env, BACKGROUND_CONTEXT)).ok, false)
  })
}

test("realpath 报不存在但 lstat 失败时同样拒绝", async t => {
  const { workspace, env, guard } = fixture(t)
  const info = env.fileInfo.bind(env)
  t.mock.method(env, "fileInfo", (target: string, context: Context) => target === path.join(workspace, "new")
    ? Promise.resolve(err(new FileError("permission_denied", "lstat denied")))
    : info(target, context))
  assert.equal((await guard("new", env, BACKGROUND_CONTEXT)).ok, false)
})
