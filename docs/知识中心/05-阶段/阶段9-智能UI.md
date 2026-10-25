# 阶段 9：智能 UI

> **目标**：模型生成一段 TokUI DSL，渲染成可点击的卡片；点击后对话继续，刷新/重启后状态不丢。
> **预计**：1–2 周。**产出**：`render_ui` 工具 + 安全的 DSL 渲染层 + 幂等交互回传。

---

## 1. 前置概念

- **UI 是工具结果的一部分，不是聊天记录的旁路。** DSL 存在 tool-result 的 `details` 里，和消息同一次 commit。
- **DSL 是不可信输入。** 模型可以生成任意文本；渲染前必须做组件、属性、大小、协议的白名单校验。
- **交互只是数据。** 点击回传的是 `{uiId, handler, payload}`，不是可执行代码。
- **幂等靠 `requestId`。** 双击、重试、渲染进程重放，都必须落到同一条 submission。
- **渲染进程不保存 UI 状态。** 状态在 `app.smartui` 与 entry 里；组件只负责显示。
- **流式 DSL 不是默认能力。** `execute()` 拿到的是完整参数；只有在工具自己多次 `api.details()` 更新 DSL 时才有「增量渲染」。不要假设能看到模型参数流。

---

## 2. 先读哪些文档

1. [TokUI API 参考](../04-API/tokui.md) —— 全文
2. [模块交互](../01-架构/02-模块交互.md) —— 场景 G
3. [数据模型](../01-架构/03-数据模型与Document设计.md) —— 4.5 `app.smartui`
4. [工具与扩展](../02-PI-Durable/03-工具与扩展.md) —— 三通道
5. [渲染进程 replica](../03-Electron/03-渲染进程replica.md) —— 第 7、10 节

---

## 3. 架构位置与模块协作

```
packages/extensions/smartui/src/
├─ index.ts            defineExtension({name:"smartui", tools:[RenderUiTool]})
├─ docs.ts             AppSmartUiDoc（conversation scope）
├─ tools/render-ui.ts  校验 DSL → 返回 details
└─ dsl/
   ├─ whitelist.ts     组件、属性、handler、URL 协议
   └─ validate.ts      大小/深度/标签闭合/属性值

apps/desktop/renderer/src/ui/
├─ TokUiBlock.tsx      一个 uiId 一个实例
├─ handlers.ts         固定 5 个 handler
├─ action.ts           生成 requestId、调用 window.pi.ui.action
└─ registry.ts         按 uiId 缓存实例与已喂长度

apps/desktop/main/ipc/
└─ ui-action.ts        ui.action → conversation.submit
```

数据流：

```
模型 → render_ui(dsl)
        └─ 校验 → 返回 { output:"[UI 已渲染]", details:{ uiId, dsl, handlers } }
              └─ tool-result entry（model[0].details）→ watch 帧
                    └─ TokUI.render(dsl) → 用户点击
                          └─ ui.action → submit(app.ui_action) → 新一轮生成
```

**持久化位置（已核实）**：`ToolResultMessage` 有 `details` 字段（`pi-ai/dist/types.d.ts`），tool-result entry 的 `model[0].details` 就是它。刷新后用 entry 重建 UI；`app.smartui` 只存交互状态。

---

## 4. API 清单

| 目的 | API | 注意 |
|---|---|---|
| 渲染 | `ui.render(dsl)` | 一次性；清空容器 |
| 流式 | `ui.startStream()` / `ui.feed(chunk)` / `ui.endStream()` | 只喂增量后缀 |
| 重绘 | `ui.rerender()` | 主题/语言变化后 |
| 注册交互 | `registerHandler(name, fn)` | 全局命名，固定 5 个 |
| 统一事件 | `new TokUI({onEvent})` | 调试/埋点 |
| 断开 | `ui.disconnect()` | 卸载时 |
| 提交交互 | `conversation.submit({type:"input", content, entry:{kind:"app.ui_action", data}, requestId, whenBusy:"followUp"}, ctx)` | entry kind 不能以 `pi.` 开头 |
| 交互文档 | `tx.doc(AppSmartUiDoc, conversationId)` | 记录 status/actionCount |
| 定义 entry | `defineEntry<{...}>("app.ui_action")` | 类型收窄 |
| 主题/语言 | `setTheme` / `setLocale` + `rerender()` | 已渲染 DOM 不自动更新 |

---

## 5. 手写任务

### 5.0 落地顺序与可手写代码

先让 DSL 经过白名单和大小检查，再作为工具详情持久化；点击行为只提交数据，绝不执行 DSL 中的代码。

```ts
export const ALLOWED_HANDLERS = new Set(["choose", "confirm", "input", "open", "cancel"]); // 固定允许回传主进程的五种交互名。
export const ALLOWED_URL_PROTOCOLS = new Set(["https:"]); // 只允许安全的外部链接协议。
export function validateDsl(dsl: string): { ok: true; handlers: string[] } | { ok: false; reason: string } { // 定义工具执行前的 DSL 校验函数。
  if (dsl.length > 64 * 1024) return { ok: false, reason: "DSL 超过 64KB" }; // 先拒绝可能阻塞渲染线程的超大输入。
  if (/<script|javascript:/i.test(dsl)) return { ok: false, reason: "DSL 包含禁止文本" }; // 拦截明确的脚本攻击信号。
  const handlers = [...dsl.matchAll(/(?:clk|sub):([\w-]+)/g)].map((match) => match[1]); // 提取所有声明的点击或提交处理器。
  if (handlers.some((name) => !ALLOWED_HANDLERS.has(name))) return { ok: false, reason: "包含未知处理器" }; // 拒绝不在固定路由表中的处理器。
  for (const value of dsl.matchAll(/(?:u|s):([^\s\]]+)/g)) if (!ALLOWED_URL_PROTOCOLS.has(new URL(value[1]).protocol)) return { ok: false, reason: "链接协议不允许" }; // 验证每个 URL 都使用 https 协议。
  return { ok: true, handlers: [...new Set(handlers)] }; // 返回去重后的已验证处理器清单。
} // 结束 DSL 校验函数。
export const RenderUiTool = defineTool({ // 定义只生成持久化 UI 详情的工具。
  name: "render_ui", // 使用模型可发现的稳定工具名。
  parameters: Type.Object({ dsl: Type.String({ maxLength: 64 * 1024 }), summary: Type.String({ maxLength: 200 }) }), // 限定 DSL 与降级摘要的输入大小。
  replay: "safe", // 校验和返回详情没有外部副作用。
  async execute(args, api) { // 执行完整 DSL 的校验和封装。
    const checked = validateDsl(args.dsl); // 在向渲染端暴露前验证不可信文本。
    if (!checked.ok) return { isError: true, output: `DSL 校验失败: ${checked.reason}` }; // 用紧凑错误引导模型修正。
    return { output: "[UI 已渲染]", details: { v: 1, uiId: `ui:${api.callId}`, dsl: args.dsl, handlers: checked.handlers, summary: args.summary } }; // 将可恢复的 DSL 写入工具结果详情。
  }, // 结束工具执行函数。
}); // 结束 UI 工具定义。
```

### 5.1 `dsl/whitelist.ts`

固定三张表：

```ts
export const ALLOWED_COMPONENTS = new Set([...]);   // 从 TokUI README 的组件清单里选
export const ALLOWED_HANDLERS = new Set(["choose", "confirm", "input", "open", "cancel"]);
export const ALLOWED_URL_PROTOCOLS = new Set(["https:"]);
```

组件清单**不要凭记忆写**。先从 TokUI 包内 README / 官方 DSL 参考确认名字（见 [待验证清单](../04-API/待验证清单.md) 4.6），再写进白名单。未知组件会被 TokUI 渲染成 `tokui-unknown`，但那不是安全边界。

### 5.2 `dsl/validate.ts`

输入 `dsl: string`，输出 `{ok:true, handlers: string[]} | {ok:false, reason}`。

检查顺序：

1. **长度** ≤ 64KB；总标签数 ≤ 2000。
2. **深度** ≤ 32（TokUI 自身上限 100，业务收紧）。
3. **标签闭合**：容器标签必须有对应 `[/x]`；自闭合标签不能有闭合。
4. **组件白名单**：每个 `[name ...]` 的 `name` 在表里。
5. **属性白名单**：只允许 TokUI 文档里存在的简写与全名；未知属性丢弃或拒绝（V1 拒绝，便于发现幻觉）。
6. **handler 白名单**：`clk:` / `sub:` 的值必须在 5 个里。
7. **URL**：`u:` / `s:` 只允许 `https:`；不允许 `data:`、`file:`、`javascript:`。
8. **禁止文本**：`<script`、`javascript:` 出现在文本里时拒绝（TokUI 按文本处理，但这是明确的攻击信号）。
9. **ID 唯一**：同一 DSL 内 `id:` 不重复。

失败时 `render_ui` 返回 `isError: true` + 一行原因，**不要**把错误细节全塞给模型（给前 200 字符即可）。

### 5.3 `tools/render-ui.ts`

```ts
defineTool({
  name: "render_ui",
  description: "Render a TokUI DSL card. Use only whitelisted components...",
  parameters: Type.Object({
    dsl: Type.String({ maxLength: 64 * 1024 }),
    summary: Type.String({ maxLength: 200 }),   // 给模型的摘要，也用于降级显示
  }),
  replay: "safe",                // 纯渲染，崩溃后可安全重跑
  executionMode: "parallel",
  async execute(args, api, ctx) {
    const checked = validateDsl(args.dsl);
    if (!checked.ok) return { isError: true, output: `DSL 校验失败: ${checked.reason}` };
    return {
      output: "[UI 已渲染]",
      details: {
        v: 1,
        uiId: `ui:${api.callId}`,
        dsl: args.dsl,
        handlers: checked.handlers,
        summary: args.summary,
      },
    };
  },
});
```

要点：

- `uiId` 由 `callId` 派生，重放时稳定。
- `details` 只放 DSL 与元数据，**不要放模型原文**。
- `output` 是给模型看的，不要贴整段 DSL（浪费 token）。
- 如果工具要边生成边更新：多次 `api.details({...dsl: growing}, ctx)`（第二参是 `ctx`）；渲染端按「前缀是否一致」决定 `feed` 还是 `render`。

### 5.4 `docs.ts`（`app.smartui`）

沿用 [数据模型 4.5](../01-架构/03-数据模型与Document设计.md)：

```ts
{
  version: 1,
  instances: {
    [uiId]: {
      toolCallId: string,
      dslVersion: number,
      status: "ready" | "submitted" | "rejected" | "error",
      actionCount: number,
      lastError?: string,
    }
  }
}
```

- `ready`：DSL 校验通过、已渲染。
- `submitted`：用户已点击并成功提交。
- `error`：渲染端报告无法渲染（例如未知组件）。
- **写下标状态前先确认 entry 存在**；不要凭空创建 instance。

### 5.5 `ui/TokUiBlock.tsx`

一个 `uiId` 一个实例：

```tsx
// streaming=false：render_ui 的常规路径，参数一次给全
// streaming=true ：工具多次 api.details 推送变长的 dsl
function TokUiBlock({ uiId, dsl, streaming, complete }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const instance = useRef<TokUI | null>(null);
  const shown = useRef("");        // 已经交给 TokUI 的 DSL

  useEffect(() => {
    instance.current = new TokUI({ container: ref.current!, theme, locale });
    return () => { instance.current?.disconnect(); instance.current = null; };
  }, [uiId]);

  useEffect(() => {
    const ui = instance.current;
    if (!ui) return;

    if (!streaming) {
      ui.render(dsl);              // 一次性：清空重画
      shown.current = dsl;
      return;
    }

    if (!dsl.startsWith(shown.current)) {
      ui.render(dsl);              // 前缀变了：不能 feed
      shown.current = dsl;
      return;
    }
    if (shown.current === "") ui.startStream();   // 第一次开流
    ui.feed(dsl.slice(shown.current.length));     // 只喂后缀
    shown.current = dsl;
    if (complete) ui.endStream();
  }, [dsl, streaming, complete]);

  return <div ref={ref} data-ui-id={uiId} className="tokui-scope" />;
}
```

要求：

- `disconnect()` 在卸载时调用。
- `dsl` 变短或前缀不同 → 全量 `render()`，不要继续 `feed`。
- 流式模式必须先 `startStream()` 再 `feed()`；`feed` 只喂后缀，结束时 `endStream()`。
- 主题/语言变化 → `ui.rerender()`（或重新 `render`）。
- 容器加一个作用域 class，避免 TokUI 样式影响全局。

### 5.6 `ui/handlers.ts`

固定 5 个，启动时注册**一次**：

```ts
registerHandler("choose", (data, _event, el) => {
  const uiId = el.closest("[data-ui-id]")?.getAttribute("data-ui-id");
  submitUiAction({ uiId, handler: "choose", payload: data });
});
```

- handler 内部按 `data-ui-id` 找到具体实例，**不要**每个组件卸载时 `removeHandler`。
- `payload` 必须可 JSON 序列化；截断到 8KB。
- `submitUiAction` 在 `action.ts` 里生成 `requestId`。

### 5.7 `ui/action.ts`

```ts
const actionId = crypto.randomUUID();                 // 一次点击生成一次
const requestId = `ui:${uiId}:${actionId}`;
await window.pi.ui.action({ convId, uiId, handler, payload, requestId });
```

- **双击防护**：点击后本地 disable（仅视觉），并等待 `app.smartui.status === "submitted"` 或超时。
- **重试**：同一个点击的重试必须复用同一个 `requestId`；不要重新生成。
- 不要用时间戳或自增序号做 `requestId`，渲染进程重启后会重复。

### 5.8 主进程 `ui.action`

1. 校验 sender、convId、uiId 格式、handler 白名单、payload 大小、requestId 格式。
2. `conversation.submit({ type:"input", content: "[UI 交互] ...", entry:{kind:"app.ui_action", data:{uiId, handler, payload}}, requestId, whenBusy:"followUp" }, ctx)`。
3. `commit` 更新 `app.smartui.instances[uiId]`：`status:"submitted"`, `actionCount+1`。
4. 返回 `{submissionId}`。

关于原子性：

- `submit` 与 doc 写入不在同一个 commit。崩溃可能造成「消息已提交、状态没更新」。
- **以 `requestId` 为准**：重试会命中同一条 submission；加载时扫描 `app.ui_action` entries 重建 `actionCount`，修正文档。

### 5.9 加载与恢复

启动/切换会话时：

1. 从 `entries` 里找 `pi.tool-result`，`model[0].details.uiId` 存在 → 收集 `{uiId, dsl, summary}`。
2. 读 `app.smartui` 覆盖 `status`、`actionCount`。
3. 渲染时按 `uiId` 去重（同一 uiId 只保留最新一条）。
4. 文档缺失 → 所有 instance 视为 `ready`。

**不要**把 DSL 复制进 `app.smartui`：它已经在 entry 里，复制会导致两份真相与写放大。

### 5.10 降级与错误

- DSL 校验/Ui 渲染失败：显示 `summary` + 「此卡片无法渲染」+ 折叠的原因。
- 组件未知：TokUI 会生成 `tokui-unknown`；渲染端检测到后把 `status:"error"` 写回（通过一个 `ui.renderError` IPC，或仅在本地显示并记录日志；V1 先本地）。
- 超大 DSL：工具层拒收，模型会看到 `isError` 并重试更小的版本。
- 渲染端抛错：用 ErrorBoundary 包住 `TokUiBlock`，只影响这一条消息。

### 5.11 测试

- `dsl/validate.test.ts`：至少 20 条，含嵌套、未闭合、未知组件、`javascript:`、超深、超长、重复 id。
- `action.test.ts`：同一 actionId 重试 => 同一 requestId；双击 => 两个不同 requestId（由本地 disable 防住）。
- 手动：刷新窗口、重启应用、切换会话后，卡片与已提交状态都正确。

---

## 6. 实现提示

- **TokUI 只负责一条消息内部。** 不要用它画消息列表、侧边栏或输入框。
- **handler 是全局的。** 固定名字 + `data-ui-id` 路由，是最省事的方案。
- **`feed` 只喂后缀。** 用「已喂长度」而不是「上次的完整字符串比较」。
- **`streaming: true` 不是必须。** 静态卡片用 `render()` 更稳；只有在 dsl 真的一点点变长时才开流式。
- **不要假设 `execute` 能看到模型参数流。** 已核实的 `ToolExecutionApi` 没有「部分参数」接口；流式 DSL 只能来自工具自己的多次 `details`。
- **DSL 里不要放大段 JSON。** 卡片是给人看的；数据用表格/列表。
- **主题与语言切换后要重绘。** TokUI 不会自动更新已渲染 DOM。
- **`requestId` 是幂等键，不是排序键。** 不要用它推断顺序。
- **点击后不要让本地状态先变成「已处理」。** 等 `app.smartui` 或 `ui_action` entry 回来；否则提交失败时界面在撒谎。
- **UI 卡片可以出现在历史里。** 滚动到旧消息时不要重新触发 handler；handler 只绑定当前渲染的实例。

---

## 7. 调试方法

| 想知道 | 做法 |
|---|---|
| DSL 为什么被拒 | `validateDsl` 的 reason；打印前 200 字符 |
| 卡片没出现 | `live.tools[].details` 是否有值；entry 的 `model[0].details` |
| 卡片渲染成 unknown | 组件名是否在白名单/拼写是否正确 |
| 点了没反应 | handler 是否注册；`data-ui-id` 是否在 DOM 上 |
| 重复提交 | 打印 `requestId`；检查是否每次点击都新生成 |
| 刷新后卡片消失 | 是否只依赖 `app.smartui` 而没扫 entry |
| 样式污染 | 容器作用域 class；是否引入 `@jboltai/tokui/css` |
| 语言切换无效 | 是否调用 `rerender()` |

---

## 8. 验收标准

- [ ] 模型调用 `render_ui` 后，界面出现卡片，且同一条消息不会重复出现两张。
- [ ] 含未闭合标签、未知组件、`javascript:` 链接的 DSL 被工具拒绝，模型能看到原因。
- [ ] 超过 64KB 的 DSL 被拒绝；渲染线程不卡死。
- [ ] 点击卡片按钮后，对话继续；`app.ui_action` entry 与用户消息顺序正确。
- [ ] 同一 `requestId` 重复提交只产生一条 submission（手动重放验证）。
- [ ] 双击不会提交两次（本地 disable + 状态回写）。
- [ ] 刷新窗口后，历史卡片仍在，已提交的卡片状态正确。
- [ ] 重启应用后同上。
- [ ] 切换会话后，卡片不会串到另一个会话。
- [ ] 主题/语言切换后，卡片重绘且 handler 仍可用。
- [ ] 渲染失败只影响单条消息（ErrorBoundary 生效）。
- [ ] `validate.test.ts` 全部通过。

---

## 9. 阶段产出

- `packages/extensions/smartui/src/`（工具、文档、校验、白名单）
- `apps/desktop/renderer/src/ui/`（TokUiBlock、handlers、action、registry）
- 主进程 `ui.action`
- `notes/stage9-smartui.md`：一张成功卡片、一次被拒的 DSL、一次双击/重试的 requestId 记录。

---

## 10. 常见失败

| 现象 | 原因 | 修法 |
|---|---|---|
| 卡片空白 | 没引入 CSS / 容器无高度 | 引入 `@jboltai/tokui/css`，给容器最小高度 |
| 内容重复 | 每帧喂全量 | 只喂后缀 |
| 内容截断 | 没 `endStream` | 结束时调用 |
| 点击无反应 | handler 名与 `clk:` 不一致 | 大小写敏感，对照检查 |
| 多个卡片互相影响 | handler 全局覆盖 | 固定 handler + `data-ui-id` 路由 |
| 刷新后消失 | 只读 `app.smartui` | 从 entry 的 details 重建 |
| 重复提交 | 每次重试生成新 requestId | 一次点击一个 requestId，重试复用 |
| 卡片把布局撑坏 | DSL 太宽/嵌套太深 | 容器 `overflow:auto` + 工具层限制 |
| 未知组件静默 | 只看 TokUI 的 unknown 样式 | 白名单校验 + 渲染端检测 |
| 旧卡片还能点 | 历史消息也绑定了 handler | 只给「当前会话最后 N 条」绑定，或按 status 禁用 |

---

## 完成之后

回到 [V1 开发路线](../V1开发路线.md) 的里程碑表，逐项做一次「可演示」验证：D0 → D6。全部通过，V1 的骨架就完成了。

后续打磨（不在本路线内）：打包、自动更新、多窗口只读、会话导出、工具市场、向量检索。
