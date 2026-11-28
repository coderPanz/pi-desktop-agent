/** M1-1 基础契约验证：版本目录原子发布、checksum 与安装状态机。 */
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { createModels } from "@earendil-works/pi-ai"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { AppSubappsDoc } from "@pi/shared-docs"
import type { InstalledSubappManifest } from "@pi/shared-types"
import { createPiRegistry, createStorage, ensureWorkspacePaths, openHarness, workspacePaths } from "@pi/core"
import {
  commitStagedSubappVersion,
  discardStagedSubappVersion,
  stageSubappVersion,
  subappChecksum,
  subappVersionDirectory,
} from "../src/main/subapps/files.ts"
import { transitionSubappInstall } from "../src/main/subapps/install-state.ts"

const root = await mkdtemp(path.join(os.tmpdir(), "pi-subapp-m1-1-"))
try {
  const paths = workspacePaths(root)
  await ensureWorkspacePaths(paths)
  const tool = "export default () => 'ok'\n"
  const ui = '{"v":1}\n'
  const manifest: InstalledSubappManifest = {
    schemaVersion: 1,
    slug: "md-count",
    title: "Markdown 计数",
    version: 1,
    createdAt: Date.now(),
    requestedCapabilities: {
      tools: ["user.md_count.count"],
      readPaths: ["<workspace>"],
      writePaths: [],
      network: false,
      runsCommands: false,
    },
    enforcement: "m1-local-confirmed",
    checksum: subappChecksum(tool, ui),
  }

  const staged = await stageSubappVersion({ paths, manifest, files: { tool, ui } })
  assert.notEqual(staged.directory, staged.target)
  const committed = await commitStagedSubappVersion(staged)
  assert.equal(committed, subappVersionDirectory(paths, manifest.slug, manifest.version))
  assert.equal(await readFile(path.join(committed, "tool.mjs"), "utf8"), tool)
  assert.equal(await readFile(path.join(committed, "ui.json"), "utf8"), ui)

  await assert.rejects(
    stageSubappVersion({
      paths,
      manifest: { ...manifest, version: 2, checksum: "sha256:not-the-content" },
      files: { tool },
    }),
    /checksum/,
  )

  const discarded = await stageSubappVersion({
    paths,
    manifest: { ...manifest, version: 2, checksum: subappChecksum(tool) },
    files: { tool },
  })
  await discardStagedSubappVersion(discarded)

  let state = transitionSubappInstall({ phase: "draft", slug: manifest.slug }, "checked")
  state = transitionSubappInstall(state, "smoke-passed")
  state = transitionSubappInstall(state, "confirmed", { version: 1 })
  assert.equal(state.phase, "confirmed")
  assert.equal(state.version, 1)
  assert.throws(() => transitionSubappInstall({ phase: "draft", slug: manifest.slug }, "ready"), /不能从/)

  const opened = await openHarness(await createStorage({ kind: "file", file: paths.db }), {
    models: createModels(),
    registry: createPiRegistry(),
  })
  try {
    await opened.harness.commit(async tx => {
      const doc = await tx.doc(AppSubappsDoc)
      doc.items.push({
        slug: manifest.slug,
        title: manifest.title,
        version: manifest.version,
        enabled: true,
        status: "ready",
        requestedCapabilities: manifest.requestedCapabilities,
        enforcement: manifest.enforcement,
        smoke: "passed",
        installedAt: manifest.createdAt,
      })
    }, BACKGROUND_CONTEXT)
    await opened.harness.commit(async tx => {
      const doc = await tx.doc(AppSubappsDoc)
      assert.equal(doc.items[0]?.slug, manifest.slug)
      assert.equal(doc.items[0]?.status, "ready")
    }, BACKGROUND_CONTEXT)
  } finally {
    await opened.harness.close(BACKGROUND_CONTEXT)
  }

  console.log("✓ M1-1 子应用基础设施｜版本目录、checksum、暂存清理、状态机与 app.subapps 文档通过")
} finally {
  await rm(root, { recursive: true, force: true })
}
