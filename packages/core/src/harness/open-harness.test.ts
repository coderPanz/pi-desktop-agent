import assert from "node:assert/strict"
import { test } from "node:test"
import type { TestContext } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context"
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai"
import { AgentDoc, MemoryStorage } from "@earendil-works/pi-durable"

import { HarnessHost } from "./host.ts"
import { createPiRegistry } from "./registry.ts"
import { SessionManager } from "../session/manager.ts"
import { createStorage } from "../storage/create-storage.ts"

async function fileStorage(t: TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-root-test-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return () => createStorage({ kind: "file", file: path.join(dir, "session.sqlite") })
}

function modelFixture() {
  const faux = fauxProvider({ models: [{ id: "test-model" }], tokensPerSecond: Infinity })
  const models = createModels()
  models.setProvider(faux.provider)
  const model = faux.getModel()
  return { faux, models, ref: { provider: model.provider, modelId: model.id } }
}

test("已有 root 缺模型时补配置，保留历史和其他 agent 字段", async (t) => {
  const openStorage = await fileStorage(t)
  const storage = await openStorage()
  const { faux, models, ref } = modelFixture()
  const registry = createPiRegistry()
  const first = await HarnessHost.open({ storage, models, registry })
  await first.root.configure({ instructions: "保存的指令" }, ctx)
  await first.root.submit({ type: "write", entry: { kind: "test.note", data: { n: 1 } } }, ctx)
  await first.close()

  const second = await HarnessHost.open({ storage: await openStorage(), models, registry, agent: { model: ref, instructions: "不应覆盖" } })
  try {
    const agent = await second.harness.snapshot(AgentDoc, second.root.id, ctx)
    assert.deepEqual(agent?.model, ref)
    assert.equal(agent?.instructions, "保存的指令")
    assert.equal((await second.root.entries({}, 10, undefined, ctx)).items[0]?.kind, "test.note")
    faux.setResponses([fauxAssistantMessage("ROOT_OK")])
    const result = await (await second.root.submit({ type: "input", content: "hello" }, ctx)).wait(ctx)
    assert.equal(result.status, "done")
  } finally {
    await second.close()
  }
})

test("重开 root 不覆盖已保存的模型选择", async (t) => {
  const openStorage = await fileStorage(t)
  const storage = await openStorage()
  const { models, ref } = modelFixture()
  const registry = createPiRegistry()
  const first = await HarnessHost.open({ storage, models, registry, agent: { model: ref } })
  await first.close()
  const second = await HarnessHost.open({ storage: await openStorage(), models, registry, agent: { model: { provider: "other", modelId: "other" } } })
  try {
    assert.deepEqual((await second.harness.snapshot(AgentDoc, second.root.id, ctx))?.model, ref)
  } finally {
    await second.close()
  }
})

test("新建会话有 root 模型且实际得到回答，显式 agent 覆盖按嵌套结构生效", async () => {
  const storage = new MemoryStorage()
  const { faux, models, ref } = modelFixture()
  const host = await HarnessHost.open({ storage, models, registry: createPiRegistry(), agent: { model: ref } })
  const manager = await SessionManager.open({ harness: host.harness, storage })
  try {
    const created = await manager.create(ctx)
    const view = await host.harness.snapshot(AgentDoc, created.id, ctx)
    assert.deepEqual(view?.model, ref)
    assert.equal((await created.entries({}, 10, undefined, ctx)).items.length, 0)
    await manager.select(created.id, ctx)
    faux.setResponses([fauxAssistantMessage("NEW_OK")])
    const submission = await manager.submit("hello", ctx)
    assert.equal((await submission.wait(ctx)).status, "done")
    assert.equal(faux.state.callCount, 1)

    const inherited = await manager.create(ctx, { agent: { model: undefined, instructions: "仅覆盖指令" } })
    assert.deepEqual((await host.harness.snapshot(AgentDoc, inherited.id, ctx))?.model, ref)

    const overridden = await manager.create(ctx, { agent: { model: null, instructions: "独立配置", thinkingLevel: "off" } })
    const overrideAgent = await host.harness.snapshot(AgentDoc, overridden.id, ctx)
    assert.equal(overrideAgent?.model, undefined)
    assert.equal(overrideAgent?.instructions, "独立配置")
    assert.equal(overrideAgent?.thinkingLevel, "off")
    assert.deepEqual((await host.harness.snapshot(AgentDoc, host.root.id, ctx))?.model, ref)
  } finally {
    await host.close()
  }
})
