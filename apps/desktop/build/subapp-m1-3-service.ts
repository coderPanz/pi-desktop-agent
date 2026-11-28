/** M1-3 回归：SubappService 预览、安装、启停与启动恢复。 */
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { createModels } from "@earendil-works/pi-ai"
import type { SubappProposal } from "@pi/shared-types"
import { createPiRegistry, createStorage, ensureWorkspacePaths, openHarness, workspacePaths } from "@pi/core"
import { SubappService } from "../src/main/subapps/service.ts"

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

const candidate = {
  manifest: {
    schemaVersion: 1 as const,
    slug: "md-count",
    title: "Markdown 计数",
    requestedCapabilities: {
      tools: ["user.md_count.count"],
      readPaths: ["<workspace>"],
      writePaths: [],
      network: false,
      runsCommands: false,
    },
  },
  files: { tool },
}

const root = await mkdtemp(path.join(os.tmpdir(), "pi-subapp-m1-3-service-"))
try {
  const paths = workspacePaths(root)
  await ensureWorkspacePaths(paths)
  const registry = createPiRegistry()
  const opened = await openHarness(await createStorage({ kind: "memory" }), {
    models: createModels(),
    registry,
  })
  try {
    const changes: string[] = []
    const proposals: SubappProposal[] = []
    const service = new SubappService({
      paths,
      harness: opened.harness,
      registry,
      onChanged: change => changes.push(`${change.slug}:${change.removed === true ? "removed" : change.status ?? "unknown"}`),
      onProposed: proposal => proposals.push(proposal),
    })
    const agent = await opened.root.agent(BACKGROUND_CONTEXT)
    assert.ok(agent.tools.some(tool => tool.name === "subapp.propose"))
    assert.ok(agent.sections.some(section => section.key === "subapps"))
    const proposalTool = registry.snapshot().tools().find(({ tool }) => tool.name === "subapp.propose")?.tool
    assert.ok(proposalTool)
    const proposed = await proposalTool.execute(candidate, {} as never, BACKGROUND_CONTEXT)
    assert.equal(proposed.isError, undefined)
    const proposal = proposals[0]
    assert.ok(proposal)
    const preview = await service.preview(proposal.candidateId, "renderer-1")
    assert.equal(preview.smoke.status, "passed")
    const installed = await service.install({ installToken: preview.installToken, sender: "renderer-1" })
    assert.equal(installed.status, "ready")
    assert.equal(registry.snapshot().extension("subapps:md-count")?.name, "subapps:md-count")

    await service.setEnabled("md-count", false)
    assert.equal(registry.snapshot().extension("subapps:md-count"), undefined)
    await service.setEnabled("md-count", true)
    assert.equal(registry.snapshot().extension("subapps:md-count")?.name, "subapps:md-count")

    const restoredRegistry = createPiRegistry()
    const restored = new SubappService({ paths, harness: opened.harness, registry: restoredRegistry })
    await restored.restore()
    assert.equal(restoredRegistry.snapshot().extension("subapps:md-count")?.name, "subapps:md-count")

    await service.remove("md-count")
    assert.equal(registry.snapshot().extension("subapps:md-count"), undefined)
    assert.deepEqual(await service.list(), [])
    assert.deepEqual(changes, ["md-count:ready", "md-count:disabled", "md-count:ready", "md-count:removed"])
  } finally {
    await opened.harness.close(BACKGROUND_CONTEXT)
  }
  console.log("✓ M1-3 子应用服务｜预览、安装、启停与启动恢复通过")
} finally {
  await rm(root, { recursive: true, force: true })
}
