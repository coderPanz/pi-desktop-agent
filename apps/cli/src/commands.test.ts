import assert from "node:assert/strict"
import { test } from "node:test"

import { CommandError, parseCommand } from "./commands.ts"

test("空行与纯空白不算输入", () => {
  assert.equal(parseCommand(""), undefined)
  assert.equal(parseCommand("   \n\t"), undefined)
})

test("普通文本提交给模型", () => {
  assert.deepEqual(parseCommand("帮我看下 package.json"), {
    kind: "send",
    text: "帮我看下 package.json",
  })
})

test("无参数命令", () => {
  for (const [line, kind] of [
    ["/new", "new"],
    ["/list", "list"],
    ["/fork", "fork"],
    ["/abort", "abort"],
    ["/inspect", "inspect"],
    ["/help", "help"],
    ["/quit", "quit"],
  ] as const) {
    assert.equal(parseCommand(line)?.kind, kind)
  }
})

test("命令大小写不敏感，前导空白忽略", () => {
  assert.equal(parseCommand("   /NEW  ")?.kind, "new")
})

test("/switch 需要正整数 id", () => {
  assert.deepEqual(parseCommand("/switch 12"), { kind: "switch", id: 12 })
  assert.throws(() => parseCommand("/switch"), CommandError)
  assert.throws(() => parseCommand("/switch abc"), CommandError)
  assert.throws(() => parseCommand("/switch -1"), CommandError)
})

test("/reset 与 /compact 的可选说明会被带上", () => {
  assert.deepEqual(parseCommand("/reset"), { kind: "reset", handoff: undefined })
  assert.deepEqual(parseCommand("/reset 接手这个任务"), {
    kind: "reset",
    handoff: "接手这个任务",
  })
  assert.deepEqual(parseCommand("/compact"), { kind: "compact", instructions: undefined })
  assert.deepEqual(parseCommand("/compact 只留结论"), {
    kind: "compact",
    instructions: "只留结论",
  })
})

test("不接受参数的命令收到参数就报错", () => {
  assert.throws(() => parseCommand("/new 额外"), CommandError)
  assert.throws(() => parseCommand("/list 1"), CommandError)
})

test("未知命令报错而不是当成消息发出去", () => {
  assert.throws(() => parseCommand("/nope"), CommandError)
})
