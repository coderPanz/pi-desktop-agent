import assert from "node:assert/strict"
import os from "node:os"
import test from "node:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"

import { createNodeEnv } from "./env.ts"
import { safeShellEnvironment } from "./shell-env.ts"

const SECRET_KEY = "ANTHROPIC_API_KEY"

test("命令环境采用允许清单，过滤凭证与解释器启动钩子", () => {
  assert.deepEqual(safeShellEnvironment({
    PATH: "/bin", HOME: "/home/test", LANG: "C", SystemRoot: "C:\\Windows",
    ANTHROPIC_API_KEY: "fake-secret", AWS_SECRET_ACCESS_KEY: "fake-aws",
    HTTPS_PROXY: "http://user:password@proxy", NODE_OPTIONS: "--inspect",
    BASH_ENV: "/startup.sh", ENV: "/startup.sh", ZDOTDIR: "/startup",
  }, { PATH: "/usr/bin", TMPDIR: "/tmp" }), {
    PATH: "/usr/bin", HOME: "/home/test", LANG: "C", SystemRoot: "C:\\Windows", TMPDIR: "/tmp",
  })
})

test("即使关闭 Seatbelt，宿主、shellEnv、每次 exec 的凭证也不能自动进入子进程", async t => {
  const previous = process.env[SECRET_KEY]
  process.env[SECRET_KEY] = "fake-host-secret"
  t.after(() => {
    if (previous === undefined) delete process.env[SECRET_KEY]
    else process.env[SECRET_KEY] = previous
  })
  const env = createNodeEnv(os.tmpdir(), {
    sandbox: "off",
    shellEnv: { ANTHROPIC_API_KEY: "fake-base-secret", LANG: "C" },
  })
  t.after(() => env.cleanup(BACKGROUND_CONTEXT))
  let output = ""
  const result = await env.exec([process.execPath, "-e", `
    process.stdout.write(JSON.stringify({
      key: process.env.ANTHROPIC_API_KEY ?? null,
      hook: process.env.NODE_OPTIONS ?? null,
      lang: process.env.LANG,
      path: process.env.PATH,
    }))
  `], {
    env: { ANTHROPIC_API_KEY: "fake-exec-secret", NODE_OPTIONS: "--inspect", PATH: "/custom/bin" },
    inheritEnv: true,
    onOutput: text => { output += text },
  }, BACKGROUND_CONTEXT)
  assert.equal(result.ok, true)
  assert.deepEqual(JSON.parse(output), { key: null, hook: null, lang: "C", path: "/custom/bin" })
})

test("inheritEnv=false 不会重新注入宿主或 shellEnv，但显式变量仍经过过滤", async t => {
  const env = createNodeEnv(os.tmpdir(), { sandbox: "off", shellEnv: { LANG: "base-lang" } })
  t.after(() => env.cleanup(BACKGROUND_CONTEXT))
  let output = ""
  const result = await env.exec([process.execPath, "-e", `
    process.stdout.write(JSON.stringify({
      lang: process.env.LANG ?? null,
      term: process.env.TERM,
      key: process.env.ANTHROPIC_API_KEY ?? null,
    }))
  `], {
    inheritEnv: false,
    env: { TERM: "dumb", ANTHROPIC_API_KEY: "fake-secret" },
    onOutput: text => { output += text },
  }, BACKGROUND_CONTEXT)
  assert.equal(result.ok, true)
  assert.deepEqual(JSON.parse(output), { lang: null, term: "dumb", key: null })
})
