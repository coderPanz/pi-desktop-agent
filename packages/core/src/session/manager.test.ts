/**
 * 测 SessionManager —— core 里「管会话」的那一层。
 *
 * 特点：跑起来不需要 API key，也不联网。
 * 因为这些用例都不去问模型，只验证本地行为：会话怎么建、怎么切、怎么分叉。
 *
 * 跑法：pnpm test
 */
import assert from "node:assert/strict" // 断言库，用于测试结果的断言
import { test } from "node:test" // 内置的测试模块，会打印测试结果

// chord 是底层库。BACKGROUND_CONTEXT 是一个默认的「执行上下文」——
// 调 Harness 的每个方法都要带一个 ctx（可以理解成传话用的信封），测试里统一用它。
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"

// pi-durable 是「存数据 + 跑任务」那一层：
//   MemoryStorage        —— 内存版存储，接口跟真数据库一样，但跑完就没了
//                           （所以用例之间不会互相污染，也不用手动删文件）
//   ROOT_CONVERSATION_ID —— 默认会话的固定编号（值是 1），程序一装好就有这样一个会话
import { MemoryStorage, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable"

// pi-ai 管模型。这里故意配成「空清单 + 内存凭证」：
//   createModels()          —— 建一个模型清单，但我们一个 provider 都没注册 → 清单是空的
//   InMemoryCredentialStore —— 凭证只放内存，没有真 key
// 两个加起来意味着：下面的测试永远不可能联网去问模型。
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai"

// 本仓库自己的两个零件：
//   createPiRegistry —— 建「注册表」，也就是登记工具/扩展的地方。
//                       扩展包现在还是空壳，所以装进去 0 个，但流程跟真跑时一致。
//   HarnessHost      —— 把「存储 + 模型 + 注册表」装成一套能用的运行环境，
//                       并负责关闭（close 调几次都只真关一次）。
import { createPiRegistry } from "../harness/registry.ts"
import { HarnessHost } from "../harness/host.ts"

// 被测对象。
// 路径带 .ts 后缀是因为这里直接跑 TypeScript 源码，不是编译后的 js。
import { SessionManager } from "./manager.ts"

/**
 * 搭一个最小的可用环境，后面每个用例都从这里开始。
 * 两个刻意的选择：
 *   - MemoryStorage：数据只存在内存里，跑完就没了，所以用例之间不会互相污染。
 *   - InMemoryCredentialStore：不放真 key，所以永远连不上模型 —— 这正是我们要的，
 *     测试只关心「本地记录对不对」，不关心模型说什么。
 *  */
async function openFixture() {
  const storage = new MemoryStorage() // 内存存储
  const models = createModels({ credentials: new InMemoryCredentialStore() }) // 空模型
  const registry = createPiRegistry() // 空注册表
  const host = await HarnessHost.open({ storage, models, registry }) // 创建 harness
  const manager = await SessionManager.open({ harness: host.harness, storage }) // 
  return { storage, host, manager }
}

// ctx 是每次调用都要带上的「执行上下文」，可以理解成传话用的信封。
// 测试里统一用这个默认的就行。
const ctx = BACKGROUND_CONTEXT

/**
 * 往当前会话里记一条笔记。
 * 关键在 type: "write" —— 它只是往聊天记录里写一笔，**不会触发模型回答**，没有 key、没有网络也能跑，换成 type: "input"，那就是真的提问了，必须接上模型。
 */
async function appendNote(
  manager: SessionManager,
  host: HarnessHost,
  data: { readonly n: number },
): Promise<void> {
  // Manager 只记着「现在在哪个会话」，不存会话对象本身，所以每次按 id 现取。
  const conversation = await host.harness.conversation(manager.conversationId, ctx)
  // assert.ok(x)：x 必须是「真值」（不为 null / undefined / 0 / ""）。
  assert.ok(conversation !== undefined)
  await conversation.submit({ type: "write", entry: { kind: "test.note", data } }, ctx)
}

// ---------------------------------------------------------------------------
// 默认会话
// ---------------------------------------------------------------------------

// 一装好就有个默认会话（叫 root），编号是固定的 ROOT_CONVERSATION_ID。
// 这里确认打开后就直接指着它，不用自己建。
test("起始会话是 root", async () => {
  const { host, manager } = await openFixture()
  // 每个用例结束都关掉，否则同一个进程里后面跑的用例会读到上一轮的残留。
  try {
    // assert.equal(a, b)：两边必须相等，用的是 === （严格相等，不会把 "1" 当成 1）。
    assert.equal(manager.conversationId, ROOT_CONVERSATION_ID) // 会话 id 和 初始化 id 相同
    assert.equal(host.root.id, ROOT_CONVERSATION_ID) // harness 根会话 id 和 初始化 id 相同 测试通过
  } finally {
    await manager.closeWatches()
    await host.close()
  }
})

// ---------------------------------------------------------------------------
// 新建、切换、列出
// ---------------------------------------------------------------------------

// 建一个新会话 → 切过去 → 再列出来，应该能看到两个。
test("新建 / 切换 / 列表", async () => {
  const { host, manager } = await openFixture()
  try {
    const created = await manager.create() // 创建一个新会话
    // assert.notEqual(a, b)：两边必须不相等。
    assert.notEqual(created.id, ROOT_CONVERSATION_ID)

    // 切换到新会话
    await manager.select(created.id)
    assert.equal(manager.conversationId, created.id) // 会话 id 和 新会话 id 相同 测试通过

    // 会话列表，默认按创建顺序
    const list = await manager.list()
    // assert.deepEqual(a, b)：递归比较
    assert.deepEqual(
      list.map((row) => row.id),
      [ROOT_CONVERSATION_ID, created.id],
    )
    // 两个会话都没在生成，也没有排队的消息。
    assert.deepEqual(
      list.map((row) => row.busy),
      [false, false],
    )
    assert.deepEqual(
      list.map((row) => row.queued),
      [0, 0],
    )

    // 999 是随便编的一个编号；断言它切不过去。
    // assert.rejects(...)：确认这段代码「应该报错」，而且错误信息要匹配第二个参数（这里是正则）。
    // 如果它没报错、或者报的是别的错，这条用例就算失败。
    await assert.rejects(
      async () => await manager.select(999 as typeof created.id),
      /会话不存在/,
    )
  } finally {
    await manager.closeWatches()
    await host.close()
  }
})

// ---------------------------------------------------------------------------
// 分叉（fork）
// ---------------------------------------------------------------------------

// 分叉 = 复制一份当前的对话接着聊，原来的那条不受影响。
// 这里确认三件事：新会话记得自己是从哪分出来的、能看到原来的记录、原会话内容还在。
test("fork 继承 parent 且不破坏原会话", async () => {
  const { storage, host, manager } = await openFixture()
  try {
    // 往当前会话里记一条 entry
    await appendNote(manager, host, { n: 1 })
    // 获取当前会话 id
    const original = manager.conversationId

    // 会话分叉
    const forked = await manager.fork()

    // 获取分叉会话记录
    const forkedRecord = await storage.conversation(forked.id, ctx)

    // 分叉会话的父会话 id 和 原会话 id 相同 测试通过
    assert.equal(forkedRecord?.parent?.conversationId, original)

    // fork 后能够找到父会话记录
    const forkedEntries = await forked.entries({ order: "descending" }, 10, undefined, ctx)
    assert.equal(forkedEntries.items[0]?.kind, "test.note")

    // 原会话里的笔记也还在。
    const originalEntries = await manager.entries()
    assert.equal(originalEntries[0]?.kind, "test.note")
  } finally {
    await manager.closeWatches()
    await host.close()
  }
})

// 空会话不能 fork
test("fork 在没有条目时显式失败", async () => {
  const { host, manager } = await openFixture()
  try {
    await assert.rejects(async () => await manager.fork(), /没有可 fork 的条目/)
  } finally {
    await manager.closeWatches()
    await host.close()
  }
})

// ---------------------------------------------------------------------------
// 清空上下文（reset）
// ---------------------------------------------------------------------------

// reset 从当前的「上下文从头开始」，不是删历史：会在记录里插一条 pi.reset 记号
// 后面聊的内容不再带 pi.reset 之前的上下文。给一段交接说明的话，它会变成新上下文的第一句话。
test("reset 写入 pi.reset 条目", async () => {
  const { host, manager } = await openFixture()
  try {
    await appendNote(manager, host, { n: 1 })
    await manager.reset(ctx, "交接说明")

    const entries = await manager.entries()
    assert.equal(entries[0]?.kind, "pi.reset")
    // 交接说明被当成用户说的话（role 是 user）。
    assert.equal(entries[0]?.model?.[0]?.role, "user")
  } finally {
    await manager.closeWatches()
    await host.close()
  }
})

// ---------------------------------------------------------------------------
// 忙不忙、有没有在排队
// ---------------------------------------------------------------------------

// 现在什么都没在生成，所以不忙；也没人排队，所以排队列表是空的。
// 空的时候返回空的列表，而不是「查不到」，调用方少一个判断。
test("空闲判定与 inbox", async () => {
  const { host, manager } = await openFixture()
  try {
    // 当前不忙
    assert.equal(await manager.isBusy(manager.conversationId), false)
    // 当前没有排队
    assert.deepEqual(await manager.inbox(), [])
  } finally {
    await manager.closeWatches()
    await host.close()
  }
})

// ---------------------------------------------------------------------------
// 盯着会话变化（view）
// ---------------------------------------------------------------------------

// view 是「订阅这个会话的变化」，每次订阅都会占资源
// 所以要确认：同一个会话只建一次订阅，切到别的会话再切回来，拿到的还是原来那个，而不是又新建了一个
test("view 按会话缓存：切走再切回仍是同一个 watch", async () => {
  const { host, manager } = await openFixture()
  try {
    const rootId = manager.conversationId
    const first = await manager.view()
    assert.equal(first.value.conversation.id, rootId)

    // 故意绕一圈：去别的会话再回来。
    const created = await manager.create()
    await manager.select(created.id)
    await manager.select(rootId)

    const again = await manager.view()
    // 这里的 assert.equal 特别要注意：它比的是「是不是同一个对象」。
    // 如果 view() 每次都新建一个订阅，内容虽然看着一样，这里也会失败——而这正是我们要防的。
    assert.equal(again, first)
    assert.equal(again.value.conversation.id, rootId)
  } finally {
    await manager.closeWatches()
    await host.close()
  }
})

// ---------------------------------------------------------------------------
// 消息太多时怎么排队
// ---------------------------------------------------------------------------

// 默认是「一次只放一条」（one-at-a-time），这样顺序最可预测。
// 也可以只改其中一个设置，另一个保持不变。
test("queue modes 默认 one-at-a-time，可改", async () => {
  const { host, manager } = await openFixture()
  try {
    assert.deepEqual(manager.modes, {
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
    })

    manager.setModes({ steeringMode: "all" })
    assert.equal(manager.modes.steeringMode, "all")
    assert.equal(manager.modes.followUpMode, "one-at-a-time")
  } finally {
    await manager.closeWatches()
    await host.close()
  }
})

// ---------------------------------------------------------------------------
// 关闭
// ---------------------------------------------------------------------------

// 关两次不应该报错：程序退出时「正常收尾」和「用户按 Ctrl+C」会各调一次关闭，
// 谁先到谁负责关，另一个只是等着同一件事做完。
test("host.close() 幂等", async () => {
  const { host } = await openFixture()
  await host.close()
  await host.close()

  const end = await host.closed
  // 正常关闭记作 closed；如果是存储出错，这里会是 failed。
  assert.equal(end.reason, "closed")
})
