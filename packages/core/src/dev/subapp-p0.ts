/**
 * 子应用 P0 可重复验证：registry 热装卸、session 文档持久化、运行时 ESM 导入、Seatbelt smoke 边界。
 *
 * 运行：pnpm p0:subapps
 *
 * 这不是子应用运行时；它刻意把 SDK 与现有沙箱的实际行为打印出来，作为 M1 开工门槛。
 */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { createModels } from "@earendil-works/pi-ai"
import { defineDoc, defineExtension } from "@earendil-works/pi-durable"

import { createNodeEnv } from "../agent/env.ts"
import { createPiRegistry } from "../harness/registry.ts"
import { openHarness } from "../harness/open-harness.ts"
import { createStorage } from "../storage/create-storage.ts"

type ProbeDocValue = { items: string[] }

const ProbeDoc = defineDoc({
  kind: "dev.subapp-p0",
  version: 1,
  scope: "session",
  initial: (): ProbeDocValue => ({ items: [] }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 1,
})

function line(label: string, detail: string): void {
  console.log(`✓ ${label}｜${detail}`)
}

async function registryProbe(): Promise<void> {
  const registry = createPiRegistry()
  const extension = defineExtension({ name: "subapps:p0-probe" })
  let publications = 0
  const stop = registry.subscribe(() => { publications += 1 })
  try {
    assert.equal(registry.snapshot().extension(extension.name), undefined)
    registry.install(extension)
    assert.equal(registry.snapshot().extension(extension.name), extension)
    registry.uninstall(extension)
    assert.equal(registry.snapshot().extension(extension.name), undefined)
    assert.equal(publications, 2)
    line("P0.1 registry 热装卸", "install/uninstall 会同步发布新的 snapshot")
  } finally {
    stop()
  }
}

async function documentProbe(root: string): Promise<void> {
  const file = path.join(root, "p0.sqlite")
  const first = await openHarness(await createStorage({ kind: "file", file }), {
    models: createModels(),
    registry: createPiRegistry(),
  })
  try {
    await first.harness.commit(async tx => {
      const doc = await tx.doc(ProbeDoc)
      doc.items.push("persisted")
    }, BACKGROUND_CONTEXT)
  } finally {
    await first.harness.close(BACKGROUND_CONTEXT)
  }

  const second = await openHarness(await createStorage({ kind: "file", file }), {
    models: createModels(),
    registry: createPiRegistry(),
  })
  try {
    let items: string[] | undefined
    await second.harness.commit(async tx => {
      items = [...(await tx.doc(ProbeDoc)).items]
    }, BACKGROUND_CONTEXT)
    assert.deepEqual(items, ["persisted"])
    line("P0.2 session 文档", "defineDoc + commit 在 SQLite 重开后可读回")
  } finally {
    await second.harness.close(BACKGROUND_CONTEXT)
  }
}

async function dynamicImportProbe(root: string): Promise<void> {
  const file = path.join(root, "tool.mjs")
  await writeFile(file, "export default () => 'v1'\n", "utf8")
  const first = await import(`${pathToFileURL(file).href}?v=1`) as { default: () => string }
  assert.equal(first.default(), "v1")

  await writeFile(file, "export default () => 'v2'\n", "utf8")
  const second = await import(`${pathToFileURL(file).href}?v=2`) as { default: () => string }
  assert.equal(second.default(), "v2")
  line("P0.3 开发态动态 ESM", "版本 query 可绕过 Node ESM 缓存")
}

async function sandboxProbe(root: string): Promise<void> {
  const workspace = path.join(root, "workspace")
  const hostOnly = await mkdtemp(path.join(os.homedir(), "pi-subapp-p0-outside-"))
  await mkdir(workspace, { recursive: true })
  const env = createNodeEnv(workspace, {
    workspace,
    sandbox: "seatbelt",
    sandboxNetwork: "deny",
  })

  try {
    await writeFile(path.join(workspace, ".keep"), "", "utf8")
    const inside = path.join(workspace, "inside.txt")
    const outside = path.join(hostOnly, "outside.txt")
    const shellWrite = await env.exec(["/bin/sh", "-c", `printf inside > ${JSON.stringify(inside)}`], { timeout: 10_000 }, BACKGROUND_CONTEXT)
    assert.equal(shellWrite.ok, true)
    if (!shellWrite.ok) throw new Error("工作区内 shell 写入未能启动")
    assert.equal(shellWrite.value.exitCode, 0)
    assert.equal(await readFile(inside, "utf8"), "inside")

    const denied = await env.exec(["/bin/sh", "-c", `printf outside > ${JSON.stringify(outside)}`], { timeout: 10_000 }, BACKGROUND_CONTEXT)
    assert.equal(denied.ok, true)
    if (!denied.ok) throw new Error("工作区外 shell 写入未能启动")
    assert.notEqual(denied.value.exitCode, 0)

    const deniedNetwork = await env.exec(["/usr/bin/curl", "--connect-timeout", "2", "--max-time", "3", "https://example.com"], { timeout: 5_000 }, BACKGROUND_CONTEXT)
    assert.equal(deniedNetwork.ok, true)
    if (!deniedNetwork.ok) throw new Error("网络验证命令未能启动")
    assert.notEqual(deniedNetwork.value.exitCode, 0)

    // 现有 withSandbox 仅包装 exec；此断言证明不能把它当成 api.env 文件方法的隔离层。
    const directOutside = path.join(hostOnly, "direct-outside.txt")
    const directWrite = await env.writeFile(directOutside, "direct", BACKGROUND_CONTEXT)
    assert.equal(directWrite.ok, true)
    assert.equal(await readFile(directOutside, "utf8"), "direct")

    line("P0.4 Seatbelt smoke 边界", "exec 的工作区外写入和网络均被拒绝；ExecutionEnv.writeFile 不受现有 shell 沙箱约束")
  } finally {
    await env.cleanup(BACKGROUND_CONTEXT)
    await rm(hostOnly, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-subapp-p0-"))
  try {
    await registryProbe()
    await documentProbe(root)
    await dynamicImportProbe(root)
    await sandboxProbe(root)
    console.log("\nP0 本地 probes 通过：M1 smoke 必须使用实际受限子进程，不能仅复用现有 api.env 文件方法。生产包动态导入另由 pnpm p0:subapps:package 验证。")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

await main()
