import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import test from "node:test"
import type { TestContext } from "node:test"
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context"
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node"
import type { ConversationId } from "@earendil-works/pi-durable"
import type { ExecutionEnv, ShellExecOptions } from "@earendil-works/pi-durable/env"

import { createNodeEnv, createNodeEnvFactory } from "./env.ts"
import {
  prepareSandbox, SANDBOX_EXEC, sandboxCommand, sandboxModeFromEnv,
  sandboxNetworkFromEnv, seatbeltProfile, withSandbox,
} from "./sandbox.ts"

const macOS = { skip: process.platform !== "darwin", timeout: 15_000 }

function fixture(t: TestContext) {
  // 拒绝写入的目标不能在 TMP 白名单里；只操作自行创建的随机目录，不碰真实密钥。
  const root = fs.mkdtempSync(path.join(os.homedir(), ".pi-seatbelt-test-"))
  const workspace = path.join(root, "work ' $ 中文")
  const home = path.join(root, "home")
  fs.mkdirSync(workspace)
  fs.mkdirSync(home)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, workspace, home }
}

function pretendAvailable(t: TestContext) {
  const access = fs.accessSync
  t.mock.method(fs, "accessSync", (target: fs.PathLike, mode?: number) => {
    if (target !== SANDBOX_EXEC) access(target, mode)
  })
}

async function run(env: ExecutionEnv, command: string | readonly string[], options: ShellExecOptions = {}) {
  let output = ""
  const result = await env.exec(command, {
    timeout: 5, ...options, onOutput: text => { output += text },
  }, BACKGROUND_CONTEXT)
  if (!result.ok) assert.fail(`${result.error.message}: ${output}`)
  return { exitCode: result.value.exitCode, output }
}

function environment(t: TestContext, workspace: string) {
  const env = createNodeEnv(workspace, { workspace, sandbox: "seatbelt", shellPath: "/bin/sh" })
  t.after(() => env.cleanup(BACKGROUND_CONTEXT))
  return env
}

test("模式与网络默认值、非法模式", () => {
  assert.equal(sandboxModeFromEnv({}, "darwin"), "seatbelt")
  assert.equal(sandboxModeFromEnv({}, "linux"), "off")
  assert.equal(sandboxModeFromEnv({ PI_SANDBOX: "off" }, "darwin"), "off")
  assert.throws(() => sandboxModeFromEnv({ PI_SANDBOX: "wrong" }), /只接受/)
  assert.equal(sandboxNetworkFromEnv({}), "deny")
  assert.equal(sandboxNetworkFromEnv({ PI_SANDBOX_NET: "allow" }), "allow")
  assert.match(seatbeltProfile("deny"), /\(deny network\*\)/)
  assert.doesNotMatch(seatbeltProfile("allow"), /\(deny network\*\)/)
})

test("字符串与 argv 都带前缀；非登录 shell，zsh 禁用用户启动文件", () => {
  const sandbox = { prefix: [SANDBOX_EXEC, "-f", "/profile.sb"], dispose() {} }
  assert.deepEqual(sandboxCommand(sandbox, "echo ok", "/bin/zsh"), [
    ...sandbox.prefix, "/bin/zsh", "-f", "-c", "echo ok",
  ])
  assert.deepEqual(sandboxCommand(sandbox, "echo ok", "/bin/sh"), [
    ...sandbox.prefix, "/bin/sh", "-c", "echo ok",
  ])
  assert.deepEqual(sandboxCommand(sandbox, ["/bin/echo", "a b"], "/bin/sh"), [
    ...sandbox.prefix, "/bin/echo", "a b",
  ])
})

test("准备策略采用真实目录，私有权限，重复 dispose 安全", t => {
  pretendAvailable(t)
  const { root, workspace } = fixture(t)
  const link = path.join(root, "workspace-link")
  fs.symlinkSync(workspace, link)
  const sandbox = prepareSandbox({ workspace: link })
  t.after(() => sandbox.dispose())
  const profile = sandbox.prefix.at(-1)!
  assert.ok(sandbox.prefix.includes(`WS=${fs.realpathSync(workspace)}`))
  assert.ok(sandbox.prefix.includes(`TMP=${fs.realpathSync(os.tmpdir())}`))
  assert.equal(fs.statSync(profile).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.dirname(profile)).mode & 0o777, 0o700)
  sandbox.dispose()
  sandbox.dispose()
  assert.equal(fs.existsSync(profile), false)
})

test("缺失启动器、无效工作区、文件冒充目录、文件系统根都拒绝准备", t => {
  const { root, workspace } = fixture(t)
  const unavailable = t.mock.method(fs, "accessSync", () => { throw new Error("missing") })
  assert.throws(() => prepareSandbox({ workspace }), /找不到/)
  assert.throws(() => createNodeEnv(workspace, { sandbox: "seatbelt" }), /找不到/)
  unavailable.mock.restore()
  pretendAvailable(t)
  assert.throws(() => prepareSandbox({ workspace: path.join(root, "missing") }), /真实路径/)
  const file = path.join(root, "not-directory")
  fs.writeFileSync(file, "fixture")
  assert.throws(() => prepareSandbox({ workspace: file }), /真实路径/)
  assert.throws(() => prepareSandbox({ workspace: path.parse(root).root }), /根目录/)
})

test("凭证目录断链或无法确认真实路径时拒绝准备", t => {
  pretendAvailable(t)
  const { workspace, home } = fixture(t)
  t.mock.method(os, "homedir", () => home)
  const link = path.join(home, ".ssh")
  fs.symlinkSync(path.join(home, "missing"), link)
  assert.throws(() => prepareSandbox({ workspace }), /凭证目录的真实路径/)
  fs.unlinkSync(link)
  const realpath = fs.realpathSync
  t.mock.method(fs, "realpathSync", (target: fs.PathLike) => {
    if (target === link) throw Object.assign(new Error("denied"), { code: "EACCES" })
    return realpath(target)
  })
  assert.throws(() => prepareSandbox({ workspace }), /凭证目录的真实路径/)
})

test("策略写入失败不留下临时目录，清理错误也不吞掉原始错误", t => {
  pretendAvailable(t)
  const { workspace } = fixture(t)
  const mkdtemp = fs.mkdtempSync
  let directory = ""
  t.mock.method(fs, "mkdtempSync", (prefix: string) => {
    directory = mkdtemp(prefix)
    return directory
  })
  const writeError = new Error("profile write failed")
  t.mock.method(fs, "writeFileSync", () => { throw writeError })
  assert.throws(() => prepareSandbox({ workspace }), error => error === writeError)
  assert.equal(fs.existsSync(directory), false)
  const removal = t.mock.method(fs, "rmSync", () => { throw new Error("remove failed") })
  assert.throws(() => prepareSandbox({ workspace }), error =>
    error instanceof AggregateError && error.errors[0] === writeError && error.errors.length === 2)
  removal.mock.restore()
  fs.rmSync(directory, { recursive: true, force: true })
})

test("清理先结束进程，任一阶段失败仍执行另一项，并保留两项错误", async t => {
  const inner = new NodeExecutionEnv({ cwd: os.tmpdir() })
  const calls: string[] = []
  const innerError = new Error("inner failed")
  const disposeError = new Error("dispose failed")
  const cleanup = t.mock.method(inner, "cleanup", async () => { calls.push("inner") })
  const sandbox = { prefix: [], dispose() { calls.push("dispose"); throw disposeError } }
  const env = withSandbox(inner, sandbox, "/bin/sh")
  await assert.rejects(env.cleanup(BACKGROUND_CONTEXT), error => error === disposeError)
  assert.deepEqual(calls, ["inner", "dispose"])
  cleanup.mock.restore()
  t.mock.method(inner, "cleanup", async () => { throw innerError })
  await assert.rejects(env.cleanup(BACKGROUND_CONTEXT), error =>
    error instanceof AggregateError && error.errors[0] === innerError && error.errors[1] === disposeError)
  const other = withSandbox(inner, { prefix: [], dispose() { calls.push("after-failure") } }, "/bin/sh")
  await assert.rejects(other.cleanup(BACKGROUND_CONTEXT), error => error === innerError)
  assert.equal(calls.at(-1), "after-failure")
})

test("macOS：工作区正常创建、改名、删除；工厂及 argv 接线生效", macOS, async t => {
  const { workspace } = fixture(t)
  const env = createNodeEnvFactory({ workspace, sandbox: "seatbelt", shellPath: "/bin/sh" })({
    cwd: workspace, conversationId: 1 as ConversationId,
    read: {
      snapshot() { throw new Error("工厂不应读取文档") },
      snapshotAsOf() { throw new Error("工厂不应读取文档") },
    },
  }, BACKGROUND_CONTEXT)
  t.after(() => env.cleanup(BACKGROUND_CONTEXT))
  assert.equal((await run(env, "printf ok > a; mv a b; cat b; rm b")).exitCode, 0)
  assert.equal(fs.existsSync(path.join(workspace, "b")), false)
  assert.deepEqual(await run(env, ["/bin/echo", "a b"]), { exitCode: 0, output: "a b\n" })
})

test("macOS：工作区外写、软链写、多层子进程写均拒绝；显式 off 不拦写", macOS, async t => {
  const { root, workspace } = fixture(t)
  const outside = path.join(root, "outside.txt")
  const env = environment(t, workspace)
  fs.symlinkSync(root, path.join(workspace, "escape"))
  for (const command of [
    ["/bin/sh", "-c", 'printf bad > "$1"', "sh", outside],
    "printf bad > escape/outside.txt",
    ["/bin/sh", "-c", 'exec /bin/sh -c \'printf bad > "$1"\' sh "$1"', "sh", outside],
  ]) {
    assert.notEqual((await run(env, command)).exitCode, 0)
    assert.equal(fs.existsSync(outside), false)
  }
  const off = createNodeEnv(workspace, { sandbox: "off", shellPath: "/bin/sh" })
  t.after(() => off.cleanup(BACKGROUND_CONTEXT))
  assert.equal((await run(off, ["/bin/sh", "-c", 'printf ok > "$1"', "sh", outside])).exitCode, 0)
})

test("macOS：外部已有文件不能删除、改名、改权限或通过硬链接修改", macOS, async t => {
  const { root, workspace } = fixture(t)
  const outside = path.join(root, "keep.txt")
  fs.writeFileSync(outside, "original", { mode: 0o600 })
  const env = environment(t, workspace)
  for (const operation of [
    'fs.unlinkSync(process.argv[1])',
    'fs.renameSync(process.argv[1], "moved")',
    'fs.chmodSync(process.argv[1], 0o777)',
    'fs.linkSync(process.argv[1], "hard-link"); fs.writeFileSync("hard-link", "modified")',
  ]) {
    const result = await run(env, [process.execPath, "-e", `
      const fs = require("node:fs");
      try { ${operation} } catch (error) { console.log(error.code); process.exitCode = 1 }
    `, outside])
    assert.notEqual(result.exitCode, 0, operation)
    assert.equal(fs.readFileSync(outside, "utf8"), "original")
    assert.equal(fs.statSync(outside).mode & 0o777, 0o600)
  }
})

test("macOS：常见凭证与 dotenv 不可读取，普通文件和示例可读，软链不能绕过", macOS, async t => {
  const { root, workspace, home } = fixture(t)
  t.mock.method(os, "homedir", () => home)
  const sensitive = [".ssh", ".aws", ".gnupg", ".azure", ".kube", ".config/gcloud", ".config/gh"]
  const cloud = path.join(root, "cloud-store")
  fs.mkdirSync(cloud)
  fs.symlinkSync(cloud, path.join(home, ".aws"))
  for (const directory of sensitive) {
    const file = path.join(home, directory, ".env.example")
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, "fake-secret")
  }
  const env = environment(t, workspace)
  for (const directory of sensitive) {
    const file = path.join(home, directory, ".env.example")
    const result = await run(env, ["/bin/cat", file])
    assert.notEqual(result.exitCode, 0, directory)
    assert.doesNotMatch(result.output, /fake-secret/)
  }
  for (const name of [".env", ".env.local", ".env.production"]) {
    const file = path.join(workspace, name)
    fs.writeFileSync(file, "fake-secret")
    assert.notEqual((await run(env, ["/bin/cat", file])).exitCode, 0, name)
  }
  fs.symlinkSync(path.join(workspace, ".env"), path.join(workspace, "ordinary-link"))
  assert.notEqual((await run(env, "cat ordinary-link")).exitCode, 0)
  fs.writeFileSync(path.join(workspace, ".env.example"), "example")
  assert.deepEqual(await run(env, "cat .env.example"), { exitCode: 0, output: "example" })
  fs.writeFileSync(path.join(workspace, "ordinary.txt"), "ordinary")
  assert.equal((await run(env, "cat ordinary.txt")).output, "ordinary")
  assert.notEqual((await run(env, ["/bin/cat", path.join(cloud, ".env.example")])).exitCode, 0)
  fs.unlinkSync(path.join(workspace, ".env.example"))
  fs.symlinkSync(path.join(workspace, ".env"), path.join(workspace, ".env.example"))
  assert.notEqual((await run(env, "cat .env.example")).exitCode, 0)
})

test("macOS：临时目录可写，但受限命令不能修改、删除策略材料", macOS, async t => {
  const { workspace } = fixture(t)
  const sandbox = prepareSandbox({ workspace })
  const inner = new NodeExecutionEnv({ cwd: workspace })
  const env = withSandbox(inner, sandbox, "/bin/sh")
  t.after(() => env.cleanup(BACKGROUND_CONTEXT))
  const profile = sandbox.prefix.at(-1)!
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-seatbelt-output-"))
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }))
  const file = path.join(temporary, "allowed.txt")
  assert.equal((await run(env, ["/bin/sh", "-c", 'printf ok > "$1"', "sh", file])).exitCode, 0)
  const original = fs.readFileSync(profile, "utf8")
  assert.notEqual((await run(env, ["/bin/sh", "-c", 'printf bad > "$1"', "sh", profile])).exitCode, 0)
  assert.notEqual((await run(env, ["/bin/rm", "-rf", path.dirname(profile)])).exitCode, 0)
  assert.equal(fs.readFileSync(profile, "utf8"), original)
  const other = prepareSandbox({ workspace })
  t.after(() => other.dispose())
  assert.notEqual((await run(env, ["/bin/sh", "-c", 'printf bad > "$1"', "sh", other.prefix.at(-1)!])).exitCode, 0)
  // 从可信父进程破坏 profile，启动必须失败，原命令不能被降级执行。
  fs.writeFileSync(profile, "invalid profile")
  const marker = path.join(workspace, "must-not-run")
  assert.notEqual((await run(env, ["/usr/bin/touch", marker])).exitCode, 0)
  assert.equal(fs.existsSync(marker), false)
})

test("macOS：默认禁止本地网络，显式 allow 才可连接；不依赖外网", macOS, async t => {
  let requests = 0
  const server = http.createServer((_request, response) => { requests++; response.end("local-ok") })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const { workspace } = fixture(t)
  const command = [process.execPath, "-e", `
    require("node:http").get("http://127.0.0.1:${address.port}", response => {
      response.on("data", data => process.stdout.write(data))
    }).on("error", () => process.exit(23))
  `]
  const deny = environment(t, workspace)
  assert.equal((await run(deny, command)).exitCode, 23)
  assert.equal(requests, 0)
  const allow = createNodeEnv(workspace, { sandbox: "seatbelt", sandboxNetwork: "allow", shellPath: "/bin/sh" })
  t.after(() => allow.cleanup(BACKGROUND_CONTEXT))
  assert.deepEqual(await run(allow, command), { exitCode: 0, output: "local-ok" })
  assert.equal(requests, 1)
})

test("macOS：zsh 不加载用户 .zshenv，宿主凭证不进入沙箱命令", macOS, async t => {
  const { workspace, home } = fixture(t)
  fs.writeFileSync(path.join(home, ".zshenv"), 'export ANTHROPIC_API_KEY=fake-startup-secret\n')
  const env = createNodeEnv(workspace, {
    sandbox: "seatbelt", shellPath: "/bin/zsh",
    shellEnv: { HOME: home, ANTHROPIC_API_KEY: "fake-base-secret" },
  })
  t.after(() => env.cleanup(BACKGROUND_CONTEXT))
  assert.deepEqual(await run(env, 'printf "%s" "${ANTHROPIC_API_KEY-unset}"'), { exitCode: 0, output: "unset" })
})

for (const mode of ["timeout", "abort", "cleanup"] as const) {
  test(`macOS：${mode} 终止仍在同一进程组中的后代进程`, macOS, async t => {
    const { workspace } = fixture(t)
    const env = environment(t, workspace)
    const { context, cancel } = withCancel(BACKGROUND_CONTEXT)
    const marker = path.join(workspace, `survived-${mode}`)
    let ready!: () => void
    const started = new Promise<void>(resolve => { ready = resolve })
    const pending = env.exec([
      "/bin/sh", "-c",
      '( /bin/sleep 1; printf survived > "$1" ) & printf ready; wait', "sh", marker,
    ], {
      timeout: mode === "timeout" ? 0.3 : 5,
      onOutput: text => { if (text.includes("ready")) ready() },
    }, context)
    if (mode !== "timeout") {
      await started
      if (mode === "abort") cancel()
      else await env.cleanup(BACKGROUND_CONTEXT)
    }
    const result = await pending
    if (mode !== "cleanup") {
      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.error.code, mode === "abort" ? "aborted" : "timeout")
    }
    await delay(1200)
    assert.equal(fs.existsSync(marker), false)
  })
}
