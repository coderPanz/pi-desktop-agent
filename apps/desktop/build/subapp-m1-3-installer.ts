/** M1-3 回归：版本目录 → loader → registry → app.subapps 的切换。 */
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { createModels } from "@earendil-works/pi-ai"
import { AppSubappsDoc } from "@pi/shared-docs"
import type { InstalledSubappManifest } from "@pi/shared-types"
import { createPiRegistry, createStorage, ensureWorkspacePaths, openHarness, workspacePaths } from "@pi/core"
import { SubappInstaller } from "../src/main/subapps/installer.ts"
import { stageSubappVersion, subappChecksum } from "../src/main/subapps/files.ts"

const tool = `export default function create({ Type, defineTool }) {
  return {
    tools: [defineTool({
      name: "user.md_count.count",
      description: "统计 Markdown 文件数",
      parameters: Type.Object({}),
      async execute() { return { output: [] } },
    })],
    actions: {},
  }
}
`

function manifest(version: number): InstalledSubappManifest {
  return {
    schemaVersion: 1,
    slug: "md-count",
    title: "Markdown 计数",
    version,
    createdAt: Date.now(),
    requestedCapabilities: {
      tools: ["user.md_count.count"],
      readPaths: ["<workspace>"],
      writePaths: [],
      network: false,
      runsCommands: false,
    },
    enforcement: "m1-local-confirmed",
    checksum: subappChecksum(tool),
  }
}

const root = await mkdtemp(path.join(os.tmpdir(), "pi-subapp-m1-3-"))
try {
  const paths = workspacePaths(root)
  await ensureWorkspacePaths(paths)
  const registry = createPiRegistry()
  const opened = await openHarness(await createStorage({ kind: "memory" }), {
    models: createModels(),
    registry,
  })
  try {
    const installer = new SubappInstaller({ paths, harness: opened.harness, registry })
    const firstManifest = manifest(1)
    const first = await installer.installStaged({
      staged: await stageSubappVersion({ paths, manifest: firstManifest, files: { tool } }),
      manifest: firstManifest,
      smoke: { status: "passed", durationMs: 1 },
    })
    assert.equal(first.version, 1)
    assert.ok(registry.snapshot().extension("subapps:md-count"))
    assert.deepEqual(registry.snapshot().tools().map(({ tool }) => tool.name), ["user.md_count.count"])

    const secondManifest = manifest(2)
    const second = await installer.installStaged({
      staged: await stageSubappVersion({ paths, manifest: secondManifest, files: { tool } }),
      manifest: secondManifest,
      smoke: { status: "passed", durationMs: 1 },
    })
    assert.equal(second.version, 2)
    assert.equal(second.previousVersion, 1)
    assert.deepEqual(registry.snapshot().tools().map(({ tool }) => tool.name), ["user.md_count.count"])

    await opened.harness.commit(async tx => {
      const doc = await tx.doc(AppSubappsDoc)
      assert.equal(doc.items.length, 1)
      assert.equal(doc.items[0]?.version, 2)
      assert.equal(doc.items[0]?.previousVersion, 1)
    }, BACKGROUND_CONTEXT)
  } finally {
    await opened.harness.close(BACKGROUND_CONTEXT)
  }
  console.log("✓ M1-3 安装切换｜版本发布、registry 热替换与 app.subapps 升级记录通过")
} finally {
  await rm(root, { recursive: true, force: true })
}
