import assert from "node:assert/strict"
import path from "node:path"
import { test } from "node:test"

import { isInside, normalizeToolPath, resolveInside } from "./paths.ts"

const ROOT = path.resolve("/tmp/pi-workspace")

test("根自身算在内部", () => {
  assert.equal(isInside(ROOT, ROOT), true)
})

test("子孙路径算在内部", () => {
  assert.equal(isInside(ROOT, path.join(ROOT, "src/index.ts")), true)
})

test("同名前缀的兄弟目录不算内部", () => {
  // `/tmp/pi-workspace2` 在 `startsWith` 下会被误判成「在 /tmp/pi-workspace 里」。
  assert.equal(isInside(ROOT, `${ROOT}2/secret.txt`), false)
})

test("以 `..` 开头的普通文件名仍然算内部", () => {
  assert.equal(isInside(ROOT, path.join(ROOT, "..foo")), true)
})

test("`..` 越出根即外部", () => {
  assert.equal(isInside(ROOT, path.join(ROOT, "..")), false)
  assert.equal(isInside(ROOT, path.join(ROOT, "../other/secret.txt")), false)
})

test("相对路径按 cwd 解析", () => {
  const verdict = resolveInside(ROOT, "src/app.ts", ROOT)
  assert.deepEqual(verdict, { ok: true, absolute: path.join(ROOT, "src/app.ts") })
})

test("相对路径里的 `..` 站在 cwd 上算", () => {
  const inside = resolveInside(ROOT, "src/../lib/x.ts", ROOT)
  assert.equal(inside.ok, true)

  const outside = resolveInside(ROOT, "../escape.txt", ROOT)
  assert.equal(outside.ok, false)
})

test("绝对路径在内部放行、在外部拒绝", () => {
  assert.equal(resolveInside(ROOT, path.join(ROOT, "a.txt"), ROOT).ok, true)

  const outside = resolveInside(ROOT, "/etc/passwd", ROOT)
  assert.equal(outside.ok, false)
  assert.match(outside.ok ? "" : outside.reason, /工作区/)
})

test("cwd 落在根外时相对路径也判外部", () => {
  const verdict = resolveInside(ROOT, "a.txt", "/tmp")
  assert.equal(verdict.ok, false)
})

test("`@` 前缀与相应宽度空格先归一化", () => {
  assert.equal(normalizeToolPath("@src/a.ts"), "src/a.ts")
  assert.equal(normalizeToolPath("src\u00A0a.ts"), "src a.ts")
  // 归一化必须和解软链/打开文件时一致，否则边界检查看的是另一个字符串。
  assert.equal(resolveInside(ROOT, "@src/a.ts", ROOT).ok, true)
})
