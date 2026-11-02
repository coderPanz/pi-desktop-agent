import assert from "node:assert/strict" // node 断言库
import { existsSync } from "node:fs" // 检查文件是否存在
import { mkdtemp, rm } from "node:fs/promises" // 创建临时目录和删除目录
import { tmpdir } from "node:os" // 获取临时目录
import path from "node:path" // 路径处理库
import { test } from "node:test" // node 测试库

import { ensureWorkspacePaths, workspacePaths } from "./paths.ts"

test("默认布局挂在根目录下", () => {
  const root = "/tmp/pi-data"
  const paths = workspacePaths(root)

  assert.equal(paths.root, root)
  assert.equal(paths.workspace, path.join(root, "workspace"))
  assert.equal(paths.tools, path.join(root, "tools"))
  assert.equal(paths.logs, path.join(root, "logs"))
  assert.equal(paths.db, path.join(root, "session.sqlite"))
})

test("根可以是相对路径，解析成绝对路径", () => {
  const paths = workspacePaths("./.data")
  assert.equal(paths.root, path.resolve("./.data"))
  assert.ok(path.isAbsolute(paths.db))
})

test("工作区可指向根外，库文件名可改", () => {
  const paths = workspacePaths("/tmp/pi-data", {
    workspace: "/tmp/other-workspace",
    dbFile: "custom.sqlite",
  })

  assert.equal(paths.workspace, "/tmp/other-workspace")
  assert.equal(paths.db, path.join("/tmp/pi-data", "custom.sqlite"))
})

test("相对的工作区按根解析", () => {
  const paths = workspacePaths("/tmp/pi-data", { workspace: "sandbox" })
  assert.equal(paths.workspace, path.join("/tmp/pi-data", "sandbox"))
})

test("ensureWorkspacePaths 建出三个目录，且可重复调用", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-core-paths-"))
  try {
    const paths = workspacePaths(root)
    await ensureWorkspacePaths(paths)
    await ensureWorkspacePaths(paths)

    assert.equal(existsSync(paths.workspace), true)
    assert.equal(existsSync(paths.tools), true)
    assert.equal(existsSync(paths.logs), true)
    // 只建目录，不建库文件：库由 storage 层负责。
    assert.equal(existsSync(paths.db), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
