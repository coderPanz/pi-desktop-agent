import assert from "node:assert/strict"
import { test } from "node:test"

import { DEFAULT_DATA_DIR, parseArgs, UsageError } from "./args.ts"

test("默认进入 REPL，数据根是 .data", () => {
  const args = parseArgs([])
  assert.equal(args.mode, "repl")
  assert.equal(args.memory, false)
  assert.equal(args.dataDir, DEFAULT_DATA_DIR)
  assert.equal(args.conversationId, undefined)
  assert.equal(args.prompt, undefined)
})

test("--memory 不写文件", () => {
  assert.equal(parseArgs(["--memory"]).memory, true)
})

test("--data-dir 改数据根", () => {
  const args = parseArgs(["--data-dir", "/tmp/pi-test"])
  assert.equal(args.dataDir, "/tmp/pi-test")
})

test("--memory 与 --data-dir 互斥", () => {
  assert.throws(() => parseArgs(["--memory", "--data-dir", "/tmp/x"]), UsageError)
})

test("--conv 与 --partial-interval-ms 按正整数解析", () => {
  const args = parseArgs(["--conv", "3", "--partial-interval-ms", "500"])
  assert.equal(args.conversationId, 3)
  assert.equal(args.partialIntervalMs, 500)
})

test("非法数字参数报错而不是静默回落", () => {
  assert.throws(() => parseArgs(["--conv", "abc"]), UsageError)
  assert.throws(() => parseArgs(["--conv", "0"]), UsageError)
  assert.throws(() => parseArgs(["--partial-interval-ms", "-5"]), UsageError)
})

test("-p / --prompt 进入一次性模式", () => {
  const short = parseArgs(["-p", "你好"])
  assert.equal(short.mode, "once")
  assert.equal(short.prompt, "你好")

  const long = parseArgs(["--prompt", "你好"])
  assert.equal(long.mode, "once")
})

test("-h / --help 只打印帮助，优先级高于一次性模式", () => {
  assert.equal(parseArgs(["-h"]).mode, "help")
  assert.equal(parseArgs(["--help", "-p", "x"]).mode, "help")
})

test("未知参数与缺取值都抛 UsageError", () => {
  assert.throws(() => parseArgs(["--nope"]), UsageError)
  assert.throws(() => parseArgs(["--data-dir"]), UsageError)
  assert.throws(() => parseArgs(["-p"]), UsageError)
})
