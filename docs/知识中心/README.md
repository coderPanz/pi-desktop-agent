# Pi Desktop Agent 知识中心

这套文档只服务一个目的：**让你亲手把这个桌面 Agent 写出来**。

不是教程合集，也不是产品说明书。它是一份「施工图 + 验收单」：每个阶段告诉你该理解什么、读哪几页、写哪几个文件、怎么调试、做到什么程度算完成。

---

## 怎么用这套文档

工作方式（古法编程）：

1. 先读当前阶段的**前置概念**和**要读的文档**，把原理讲清楚再动手。
2. 按「亲手编写的代码」清单建文件、写函数。文档只给关键步骤和坑，不贴完整实现。
3. 用「调试方法」自己跑出证据，不看日志猜。
4. 对照「验收标准」逐条打勾。**没打勾就不要进下一阶段。**
5. 卡住时先查 [04-API/待验证清单.md](04-API/待验证清单.md)，再查对应 SDK 的 `.d.ts`，最后才看官方 README。

不要一次读完所有文档。路线是浅入深的，后面的文档会假设前面阶段已经验收。

---

## 目录结构

```
docs/知识中心/
├── README.md                        ← 你在这里
├── V1开发路线.md                     ← 阶段总览、依赖关系、里程碑
├── 01-架构/
│   ├── 01-系统全景.md                进程边界、分层、数据流
│   ├── 02-模块交互.md                一次提问/工具/恢复/UI 的完整时序
│   └── 03-数据模型与Document设计.md   Entry、Document、五个 app.* 文档
├── 02-PI-Durable/
│   ├── 01-核心心智模型.md            Harness/Conversation/Task/Document 的概念模型
│   ├── 02-API参考.md                 已核实的函数签名与语义（按 1.4.0）
│   ├── 03-工具与扩展.md              Tool / Extension / Hook / Registry
│   ├── 04-状态订阅与增量同步.md      viewState / watch / ops / 背压
│   └── 05-存储错误与恢复.md          Storage 契约、崩溃恢复、失败处理
├── 03-Electron/
│   ├── 01-主进程与HarnessHost.md     生命周期、单写者、启动与关闭
│   ├── 02-IPC契约与preload.md        通道设计、序列化、安全边界
│   └── 03-渲染进程replica.md         不可变副本、apply、React 订阅
├── 04-API/
│   ├── pi-ai.md                      Models / Provider / CredentialStore
│   ├── chord.md                      Context / Op / apply / AttachedReplicatedState
│   ├── tokui.md                      TokUI 0.2.8 真实接口
│   └── 待验证清单.md                 所有未核实项与验证方法
└── 05-阶段/
    ├── 阶段0-工作区与最小Agent调用.md
    ├── 阶段1-流式输出与状态订阅.md
    ├── 阶段2-工具调用与可视化.md
    ├── 阶段3-中断排队与多会话.md
    ├── 阶段4-SQLite持久化与崩溃恢复.md
    ├── 阶段5-Electron主进程与IPC.md
    ├── 阶段6-渲染进程replica与聊天UI.md
    ├── 阶段7-知识库.md
    ├── 阶段8-工具自举闭环.md
    └── 阶段9-智能UI.md
```

---

## 版本基线（重要）

| 包 | 本文档基线 | 说明 |
|---|---|---|
| `@earendil-works/pi-durable` | **1.4.0** | 单写者 Harness、Task、Document、Storage |
| `@earendil-works/pi-ai` | **1.4.0** | Models / Provider / 认证 / 消息类型 |
| `@earendil-works/chord` | **1.4.0** | Context、Op、增量 apply、复制状态 |
| `typebox` | **1.3.27** | 工具参数 schema（pi-durable 的固定依赖） |
| `@jboltai/tokui` | **0.2.8** | 生成式 UI 的 DSL 流式渲染 |
| `react` | 19.x | 渲染进程（见技术方案 D4） |
| Electron | 待定，≥35 | 需带 Node 22 才有内置 `node:sqlite`，见待验证清单 |

> 参考资料 `技术方案.md` 锁定的是 **1.3.0**。实际 npm 最新为 **1.4.0**，且 1.4.0 有不兼容变更（`defineDoc` 必须提供 `checkpointWhen`、`sleep()` 改为 `sleepUntil()`、SQLite schema v2、任务重启上限默认 5）。**本文档一律按 1.4.0 写**，并在 [04-API/待验证清单.md](04-API/待验证清单.md) 记录了与旧方案的偏差。
>
> 不要用 1.3.0 打开 1.4.0 写出的 SQLite 文件，schema 不兼容。

### 核验方法

文档中标注「已核实」的 API，来自对 npm 发布包的实际检查：

```bash
npm pack @earendil-works/pi-durable@1.4.0 @earendil-works/pi-ai@1.4.0 @earendil-works/chord@1.4.0 @jboltai/tokui@0.2.8
# 解包后阅读 dist/*.d.ts、README.md、CHANGELOG.md
```

引用路径统一写成包内路径，例如 `pi-durable/dist/harness/types.d.ts`、`pi-ai/dist/models.d.ts`。安装后对应 `node_modules/...` 下的同一文件。

**没有核验过的东西不会写成事实。** 无法确认的一律标注「待验证」，并给出验证步骤。

---

## 三条贯穿全程的原则

1. **先提交，再展示。** 渲染进程看到的每一帧，都已经是存储里可恢复的状态。任何「先显示、后落盘」的写法都是 bug。
2. **主进程是唯一写者。** Harness 只活在 Electron 主进程。渲染进程只有只读副本，写操作一律走 `invoke`。不要在两个进程里各开一个 Harness。
3. **名字是契约。** Extension 名、Tool 名、Document kind、Entry kind 都会写进存储。改名等于破坏已有会话。定义前想清楚。

---

## 先读哪几份？

| 你现在想做什么 | 先读 |
|---|---|
| 完全没概念，想知道这东西长什么样 | 本文件 → [01-架构/01-系统全景.md](01-架构/01-系统全景.md) |
| 准备写第一行代码 | [05-阶段/阶段0-工作区与最小Agent调用.md](05-阶段/阶段0-工作区与最小Agent调用.md) |
| 想搞懂 Harness 的心智模型 | [02-PI-Durable/01-核心心智模型.md](02-PI-Durable/01-核心心智模型.md) |
| 要查某个函数签名 | [02-PI-Durable/02-API参考.md](02-PI-Durable/02-API参考.md) |
| 要做 Electron 集成 | [03-Electron/01-主进程与HarnessHost.md](03-Electron/01-主进程与HarnessHost.md) |
| 某个 API 到底存不存在 | [04-API/待验证清单.md](04-API/待验证清单.md) |

---

## 文档状态标记

| 标记 | 含义 |
|---|---|
| 已核实 | 在 1.4.0 的 `.d.ts` / README / CHANGELOG 中确认 |
| 待验证 | 合理推断或第三方资料，尚未实测；文档内给出验证步骤 |
| 风险 | 已确认的不确定性，可能改变方案，需在指定阶段先做验证门 |
