import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

// 子进程隔离环境变量，验证 Node 的真实 .env 解析和优先级，而不是 mock loader。
test("桌面加载指定 .env，导出的环境变量优先且不依赖 cwd", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-env-"))
  try {
    const file = path.join(dir, ".env")
    await writeFile(file, "PI_ENV_TEST_MODEL='from-file'\nPI_ENV_TEST_KEY=local-test-key\n")
    const moduleUrl = new URL("./config.ts", import.meta.url).href
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { loadDesktopEnv } from ${JSON.stringify(moduleUrl)};
      process.chdir(${JSON.stringify(dir)});
      loadDesktopEnv(${JSON.stringify(file)});
      console.log(JSON.stringify({model: process.env.PI_ENV_TEST_MODEL, key: process.env.PI_ENV_TEST_KEY}));
    `], { env: { ...process.env, PI_ENV_TEST_MODEL: "exported", PI_ENV_TEST_KEY: undefined }, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), { model: "exported", key: "local-test-key" })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("缺少 .env 不阻止启动，其他读取错误不会被吞掉", async () => {
  const { loadDesktopEnv } = await import("./config.ts")
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-env-"))
  try {
    assert.doesNotThrow(() => loadDesktopEnv(path.join(dir, "missing.env")))
    // Node 不同版本读取目录的错误码不同，关键是不能像 ENOENT 一样吞掉。
    assert.throws(() => loadDesktopEnv(dir))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
