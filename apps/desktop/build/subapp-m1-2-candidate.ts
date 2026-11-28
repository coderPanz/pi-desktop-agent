/** M1-2 回归：CandidateStore、静态规则与 Seatbelt smoke。 */
import assert from "node:assert/strict"

import type { InstalledSubappManifest, SubappManifestDraft } from "@pi/shared-types"
import { CandidateStore } from "../src/main/subapps/candidates.ts"
import { subappChecksum } from "../src/main/subapps/files.ts"
import { runSubappSmoke } from "../src/main/subapps/smoke-runner.ts"
import { validateM1Candidate } from "../src/main/subapps/static-validator.ts"

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

const draft: SubappManifestDraft = {
  schemaVersion: 1,
  slug: "md-count",
  title: "Markdown 计数",
  requestedCapabilities: {
    tools: ["user.md_count.count"],
    readPaths: ["<workspace>"],
    writePaths: [],
    network: false,
    runsCommands: false,
  },
}

const validation = validateM1Candidate(draft, { tool })
assert.equal(validation.ok, true)
assert.equal(validateM1Candidate(draft, { tool: "export default () => process.cwd()" }).ok, false)
assert.equal(validateM1Candidate({ ...draft, ui: { kind: "dsl", dslVersion: 1 } }, { tool }).ok, false)

let now = 1_000
const store = new CandidateStore({ now: () => now, candidateTtlMs: 1_000, tokenTtlMs: 100 })
const candidate = store.create({ manifest: draft, files: { tool } })
const manifest: InstalledSubappManifest = {
  ...draft,
  version: 1,
  createdAt: now,
  enforcement: "m1-local-confirmed",
  checksum: subappChecksum(tool),
}
store.setPreview({
  candidateId: candidate.id,
  manifest,
  staticChecks: validation.checks,
  smoke: { status: "passed", durationMs: 1 },
})
const preview = store.preview(candidate.id, "trusted-renderer")
assert.equal(preview.manifest.checksum, manifest.checksum)
assert.throws(() => store.consumeInstallToken(preview.installToken, "other-renderer"), /token/)
const accepted = store.consumeInstallToken(store.preview(candidate.id, "trusted-renderer").installToken, "trusted-renderer")
assert.equal(accepted.sourceHash, candidate.sourceHash)
const expiringToken = store.preview(candidate.id, "trusted-renderer").installToken
now += 101
assert.throws(() => store.consumeInstallToken(expiringToken, "trusted-renderer"), /token|过期/)

const smoke = await runSubappSmoke(tool)
assert.equal(smoke.status, "passed")
const failedSmoke = await runSubappSmoke("export default function create() { throw new Error('broken') }")
assert.equal(failedSmoke.status, "failed")

console.log("✓ M1-2 候选与 smoke｜token 绑定、静态规则、Seatbelt 子进程 smoke 通过")
