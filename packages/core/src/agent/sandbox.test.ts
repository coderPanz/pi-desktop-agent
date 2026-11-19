/**
 * 沙箱用例：真文件系统、真子进程（macOS 的 Seatbelt）。非 macOS 直接跳过。
 *
 * 验的是四件「挡不住就白做」的事：写工作区外被拒、软链绕过被拒、子进程继承策略、网络被拒；
 * 外加「关掉沙箱」确实还原成无沙箱行为，证明开关是接上的。
 */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"

import { createNodeEnv, createNodeEnvFactory } from "./env.ts"
import { prepareSandbox, SANDBOX_EXEC, sandboxModeFromEnv, seatbeltAvailable, seatbeltProfile } from "./sandbox.ts"

const ctx = BACKGROUND_CONTEXT
const macOnly = process.platform === "darwin" && seatbeltAvailable()

/**
 * 临时工作区 + 外部目录；用例结束整个删掉。
 *
 * 注意：`root` 放在**家目录**下而不是 `os.tmpdir()` 里——沙箱允许写临时目录（工具都要用），
 * 把「工作区外」也放进 TMPDIR 就测不出边界了。
 */
function fixture(): { readonly root: string; readonly workspace: string; readonly outside: string; readonly close: () => void } {
  const root = mkdtempSync(path.join(homedir(), ".pi-sandbox-test-"))
  const workspace = path.join(root, "ws")
  const outside = path.join(root, "outside")
  mkdirSync(workspace, { recursive: true })
  mkdirSync(outside, { recursive: true })
  return { root, workspace, outside, close: () => { rmSync(root, { recursive: true, force: true }) } }
}

/** 跑一条命令，返回退出码与输出（stdout/stderr 合起来找关键字）。 */
async function run(workspace: string, command: string | readonly string[], options: { readonly sandbox?: "seatbelt" | "off" } = {}): Promise<{ code: number; output: string }> {
  const env = createNodeEnv(workspace, { workspace, ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }) })
  try {
    const chunks: string[] = []
    const result = await env.exec(command, { onOutput: text => { chunks.push(text) } }, ctx)
    assert.equal(result.ok, true, result.ok ? "" : `${result.error.code}: ${result.error.message}`)
    return { code: result.value.exitCode, output: chunks.join("") }
  } finally {
    await env.cleanup(ctx)
  }
}

test("模式推导：macOS 默认 seatbelt，其它平台默认 off，显式值优先", () => {
  assert.equal(sandboxModeFromEnv({}, "darwin"), "seatbelt")
  assert.equal(sandboxModeFromEnv({}, "linux"), "off")
  assert.equal(sandboxModeFromEnv({ PI_SANDBOX: "off" }, "darwin"), "off")
  assert.equal(sandboxModeFromEnv({ PI_SANDBOX: "seatbelt" }, "linux"), "seatbelt")
  assert.throws(() => sandboxModeFromEnv({ PI_SANDBOX: "bubblewrap" }, "darwin"), /PI_SANDBOX/u)
})

test("profile：写默认拒绝、工作区与临时目录用 -D 传参（防路径注入），网络按策略生成", () => {
  const deny = seatbeltProfile("deny")
  assert.match(deny, /\(deny file-write\*\)/u)
  assert.ok(deny.includes('(subpath (param "WS"))'), "工作区用 -D 参数，不拼字符串")
  assert.ok(deny.includes("(deny network*)"))
  assert.ok(!seatbeltProfile("allow").includes("(deny network*)"), "allow 时不写网络规则")
})

test("prepareSandbox：profile 落盘 0600，dispose 后目录消失", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-sandbox-probe-"))
  try {
    const sandbox = prepareSandbox({ workspace: dir })
    const profilePath = sandbox.prefix[sandbox.prefix.indexOf("-f") + 1] as string
    assert.equal(existsSync(profilePath), true)
    assert.equal(statSync(profilePath).mode & 0o777, 0o600, "只有本人可读")
    assert.ok(readFileSync(profilePath, "utf8").includes('(subpath (param "WS"))'), "工作区走 -D 参数")
    assert.equal(sandbox.prefix[0], SANDBOX_EXEC)
    // macOS 上 TMPDIR 是 /var → /private/var 的软链，前缀里必须是归一化后的真实路径
    assert.ok(sandbox.prefix.some(part => part.startsWith("WS=")), "带 WS 参数")
    assert.ok(sandbox.prefix.some(part => part === `WS=${realpathSync(dir)}`), "工作区取真实路径")
    sandbox.dispose()
    assert.equal(existsSync(path.dirname(profilePath)), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("沙箱内：工作区可写，工作区外被拒（含软链绕过）", { skip: macOnly ? false : "非 macOS 或缺少 sandbox-exec" }, async () => {
  const { workspace, outside, close } = fixture()
  try {
    const inside = await run(workspace, `echo ok > ${workspace}/a.txt`)
    assert.equal(inside.code, 0)
    assert.equal(readFileSync(`${workspace}/a.txt`, "utf8").trim(), "ok")

    const denied = await run(workspace, `echo bad > ${outside}/b.txt`)
    assert.notEqual(denied.code, 0)
    assert.match(denied.output, /not permitted|Operation not permitted/u)
    assert.equal(existsSync(`${outside}/b.txt`), false)

    // 工作区里放一个指向外部的软链：内核按解析后的路径判定，写不出去
    symlinkSync(outside, path.join(workspace, "link"))
    const throughLink = await run(workspace, `echo bad > ${workspace}/link/c.txt`)
    assert.notEqual(throughLink.code, 0)
    assert.equal(existsSync(`${outside}/c.txt`), false)

    // 改 shell 启动脚本（持久化）同样不行
    const rc = await run(workspace, "echo evil >> ~/.pi-sandbox-test-rc")
    assert.notEqual(rc.code, 0)
  } finally {
    close()
  }
})

test("沙箱内：子进程继承策略，argv 形式也包住", { skip: macOnly ? false : "非 macOS 或缺少 sandbox-exec" }, async () => {
  const { workspace, outside, close } = fixture()
  try {
    const nested = await run(workspace, `sh -c 'sh -c "echo bad > ${outside}/nested.txt"'`)
    assert.notEqual(nested.code, 0)
    assert.equal(existsSync(`${outside}/nested.txt`), false)

    const argv = await run(workspace, ["sh", "-c", `echo bad > ${outside}/argv.txt`])
    assert.notEqual(argv.code, 0)
    assert.equal(existsSync(`${outside}/argv.txt`), false)
  } finally {
    close()
  }
})

test("沙箱内：网络默认被拒", { skip: macOnly ? false : "非 macOS 或缺少 sandbox-exec" }, async () => {
  const { workspace, close } = fixture()
  try {
    const probe = `node -e 'require("net").connect(80,"1.1.1.1").on("connect",()=>{console.log("OPEN");process.exit(0)}).on("error",e=>{console.log("ERR",e.code);process.exit(0)})'`
    const result = await run(workspace, probe)
    assert.ok(result.output.includes("ERR"), `连不出去：${result.output}`)
    assert.ok(!result.output.includes("OPEN"))
  } finally {
    close()
  }
})

test("PI_SANDBOX=off：不装沙箱（排障开关确实通到执行层）", async () => {
  const { workspace, outside, close } = fixture()
  try {
    const result = await run(workspace, `echo ok > ${outside}/free.txt`, { sandbox: "off" })
    assert.equal(result.code, 0)
    assert.equal(existsSync(`${outside}/free.txt`), true, "关掉沙箱后能写出去，证明开关接上了")
  } finally {
    close()
  }
})

test("工厂接线：HarnessOptions.env 出来的环境同样带沙箱", { skip: macOnly ? false : "非 macOS 或缺少 sandbox-exec" }, async () => {
  const { workspace, outside, close } = fixture()
  const env = createNodeEnvFactory({ workspace })({ cwd: workspace } as never, ctx)
  try {
    const blocked = await env.exec(`echo bad > ${outside}/factory.txt`, undefined, ctx)
    assert.notEqual(blocked.ok ? blocked.value.exitCode : -1, 0)
    assert.equal(existsSync(`${outside}/factory.txt`), false)

    const allowed = await env.exec(`echo ok > ${workspace}/factory.txt`, undefined, ctx)
    assert.equal(allowed.ok ? allowed.value.exitCode : -1, 0)
  } finally {
    await env.cleanup(ctx)
    close()
  }
})

test("工作区本身是软链时，按真实路径匹配（否则沙箱里连工作区都写不了）", { skip: macOnly ? false : "非 macOS 或缺少 sandbox-exec" }, async () => {
  const { root, workspace, close } = fixture()
  try {
    const link = path.join(root, "ws-link")
    symlinkSync(workspace, link)
    const env = createNodeEnv(link, { workspace: link })
    try {
      const result = await env.exec(`echo ok > ${link}/through-link.txt`, undefined, ctx)
      assert.equal(result.ok ? result.value.exitCode : -1, 0, "软链工作区里的写要放行")
      assert.equal(existsSync(`${workspace}/through-link.txt`), true)
    } finally {
      await env.cleanup(ctx)
    }
  } finally {
    close()
  }
})
