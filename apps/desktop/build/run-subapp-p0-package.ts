/**
 * 运行 P0.3 真实生产包验证。
 *
 * 前置：`pnpm package:dir` 已在 apps/desktop/release 下生成 macOS `.app`。
 */
import assert from "node:assert/strict"
import { mkdtemp, readdir, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const appRoot = fileURLToPath(new URL("..", import.meta.url))
const releaseRoot = path.join(appRoot, "release")
const productExecutable = "Pi Agent Desktop"

async function appBundles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const found: string[] = []
  for (const entry of entries) {
    const target = path.join(root, entry.name)
    if (entry.isDirectory() && entry.name.endsWith(".app")) {
      found.push(target)
      continue
    }
    if (entry.isDirectory()) found.push(...await appBundles(target))
  }
  return found
}

async function newestBundle(): Promise<string> {
  const bundles = await appBundles(releaseRoot)
  assert.ok(bundles.length > 0, `未在 ${releaseRoot} 找到 macOS .app；请先运行 pnpm package:dir。`)
  const sorted = await Promise.all(bundles.map(async bundle => ({ bundle, mtime: (await stat(bundle)).mtimeMs })))
  sorted.sort((left, right) => right.mtime - left.mtime)
  const newest = sorted[0]
  if (newest === undefined) throw new Error(`未在 ${releaseRoot} 找到可用 macOS .app。`)
  return newest.bundle
}

async function run(executable: string, dataDir: string): Promise<{ code: number | null; output: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, [], {
      env: {
        ...process.env,
        PI_SUBAPP_P0_PACKAGE_IMPORT: "1",
        PI_DATA_DIR: dataDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let output = ""
    child.stdout.on("data", chunk => { output += String(chunk) })
    child.stderr.on("data", chunk => { output += String(chunk) })
    child.once("error", reject)
    child.once("exit", code => resolve({ code, output }))
  })
}

const bundle = await newestBundle()
const executable = path.join(bundle, "Contents", "MacOS", productExecutable)
const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-subapp-p0-package-"))
try {
  const result = await run(executable, dataDir)
  process.stdout.write(result.output)
  assert.equal(result.code, 0, `生产包 probe 退出码为 ${String(result.code)}`)
  assert.match(result.output, /\[subapp-p0-package\] PASS/)
  assert.match(result.output, /app\.asar/)
  console.log(`✓ P0.3 生产包动态导入｜${bundle}`)
} finally {
  await rm(dataDir, { recursive: true, force: true })
}
