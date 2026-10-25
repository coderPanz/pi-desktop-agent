# TokUI API 参考（0.2.8）

> TokUI 把一段极简 DSL 变成 DOM，支持边收边渲染。
> 在本项目里它只负责**一条消息内部的富 UI**，不负责消息列表，也不负责状态。

包名：`@jboltai/tokui`，版本 **0.2.8**。类型定义：`node_modules/@jboltai/tokui/src/index.d.ts`。

---

## 1. 引入

```ts
import { TokUI, registerHandler } from "@jboltai/tokui";
import "@jboltai/tokui/css";        // 必须显式引入一次
```

`package.json` 的 `exports` 里 `.` 指向 `dist/tokui.mjs`，`./css` 指向 `dist/tokui.css`。

核心包零运行时依赖，gzip 后约 86KB。官方还有 React/Vue/Svelte 适配器（`@jboltai/tokui-react` 等），但**不在本项目基线依赖内**；V1 用核心类，自己包一层 React 组件。

---

## 2. 构造

```ts
const ui = new TokUI({
  container: "#chat",       // 选择器或 HTMLElement
  theme: "default",
  locale: "zh-CN",
  streaming: true,
  streamAnimation: true,
  onEvent: (name, data) => {
    if (name === "streamEnd") { /* ... */ }
    if (name === "component") { /* data: TokUIComponentEvent */ }
  },
  eventFilter: (evt) => evt.type !== "dialog",
});
```

`TokUIOptions`（已核实）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `container` | — | 渲染目标 |
| `theme` | `"default"` | 主题名 |
| `locale` | 自动探测 | 只影响组件骨架文案（aria-label / placeholder / 空态） |
| `streaming` | `true` | 流式模式 |
| `streamAnimation` | `true` | 流式入场动画；高频场景可关 |
| `onEvent` | — | `("streamEnd", {})` / `("component", TokUIComponentEvent)` |
| `eventFilter` | — | 返回 `false` 丢弃组件事件 |

**locale 不管业务文案。** DSL 里的 `tt:` / `l:` / `tx:` 是什么就显示什么；多语言要在生成 DSL 时处理。

---

## 3. 三种渲染方式

### 一次性

```ts
ui.render("[card tt:标题][p 内容][/card]");
```

`render(dsl, targetContainer?)` 会清空目标容器再渲染。

### 手动流式（本项目主用）

```ts
ui.startStream();
ui.feed("[card tt:");
ui.feed("构建结果]");
ui.feed("[p 成功 3 个][/card]");
ui.endStream();          // 刷缓冲区
```

- `startStream(target?)` 初始化解析器。
- `feed(chunk)` 喂**增量**；重复喂同一段会产生重复内容。
- `endStream()` 收尾；不调用可能留下未闭合的标签。
- 内部有 `maxBuffer`（1MB）与 `maxDepth`（100）保护。

### 就地重绘

```ts
ui.rerender();           // 用缓存的 DSL 按当前主题/locale 重画
```

切换主题或语言后调用。返回 `boolean`（无缓存内容时为 `false`）。

### SSE（本项目不用）

```ts
await ui.connect("/api/chat/stream", { prompt: "hi" });
```

我们用 Electron IPC，不用 SSE。

---

## 4. 事件

### handler 注册

```ts
registerHandler("choose", (data, event, element) => {
  // data 是 DSL 里 clk:「」携带的数据
  window.pi.ui.action({
    convId, uiId, handler: "choose",
    payload: data,
    requestId: `ui:${uiId}:${nextSeq()}`,
  });
});

removeHandler("choose");   // 卸载时清理
```

已核实签名：

```ts
type TokUIHandlerFn = (data: any, event: Event, element: HTMLElement) => void;
registerHandler(name: string, fn: TokUIHandlerFn): void;
```

**handler 是全局命名注册表。** 多个消息用同一个名字会互相覆盖。V1 的做法：

- 固定 5 个 handler（`choose` / `confirm` / `input` / `open` / `cancel`）。
- 具体是哪个消息的 UI，由 `uiId` 与 `data` 决定，注册一次即可。
- 组件卸载时**不要** `removeHandler`，除非确认没有其它实例在用。更稳的做法：在应用启动时注册一次，永不移除；handler 内部按 `uiId` 路由。

### 统一事件出口

```ts
onEvent: (name, data) => {
  if (name !== "component") return;
  const evt = data as TokUIComponentEvent;
  // { type, id, event, detail }
}
```

`type` 是组件类型（`input` / `tabs` / `dialog` / `tool-call`…），`event` 是事件名（`change` / `close` / `stop` / `approval`…）。

它与 `registerHandler` 不冲突：前者是统一出口，后者是 DSL 显式绑定。V1 只用 `registerHandler` + 固定 handler，`onEvent` 用来做埋点/调试。

---

## 5. DSL 速查（已核实）

```
[组件类型 属性:值 内容文本]          ; 自闭合
[card tt:标题][p 内容][/card]        ; 容器嵌套
ph:"含空格的值"                      ; 值含空格用双引号
v:"primary,sm"                       ; 多变体逗号分隔
stripe                               ; 布尔属性只写 key
```

常用属性简写：

| 简写 | 含义 | 简写 | 含义 |
|---|---|---|---|
| `tt` | title | `tx` | text |
| `l` | label | `ph` | placeholder |
| `u` | url | `s` | src / source |
| `n` | name | `v` | value / variant |
| `clk` | onclick handler 名 | `sub` | onsubmit handler 名 |
| `dis` / `ro` / `req` / `chk` | disabled / readonly / required / checked | `id` | 元素 ID |
| `w` / `h` / `bg` / `fc` | 宽 / 高 / 背景 / 字色 | | |

更新已渲染组件：

```
[upd id:目标ID v/act/tt/tx:新值]
```

变体名走白名单，未知变体静默丢弃。完整组件清单与属性见包内 README 与 `demo/TOKUI_DSL_REFERENCE.md`（**包内未附带该文件，需查官网**，见 [待验证清单](待验证清单.md)）。

---

## 6. 主题与语言

```ts
import { setTheme, getTheme, setLocale, getLocale, registerLocale } from "@jboltai/tokui";

setTheme("dark");            // 更新容器 data-tokui-theme
setLocale("en-US");          // 返回规整后的 locale
registerLocale("ja-JP", { "ok": "OK" });   // 增量合并
```

- **已渲染的 DOM 不会自动更新**，setLocale 后要 `ui.rerender()`。
- 内置只有 `zh-CN` 与 `en-US`。
- 主题通过 CSS 变量驱动；自定义主题在 CSS 里覆盖变量即可。

---

## 7. 在 React 里包一层

```tsx
function TokUiBlock({ dsl, uiId }: { dsl: string; uiId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const uiRef = useRef<TokUI | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const ui = new TokUI({ container: ref.current, theme: "default", streaming: true });
    ui.startStream();
    uiRef.current = ui;
    return () => { ui.disconnect(); uiRef.current = null; };
  }, []);

  useEffect(() => {
    const ui = uiRef.current;
    if (!ui) return;
    ui.feed(dsl.slice(fedLengthRef.current));
    fedLengthRef.current = dsl.length;
  }, [dsl]);

  return <div ref={ref} data-ui-id={uiId} />;
}
```

要点：

- **一个 `uiId` 一个实例**，不要每帧重建。
- `feed` 只喂**新增后缀**。记录已喂长度，否则重复渲染。
- DSL 变小（重新生成）时，必须重建实例或 `render()` 全量，不能继续 `feed`。
- 卸载时 `disconnect()`，清定时器/连接。
- `uiId` 写到 DOM 上（`data-ui-id`），便于调试与端到端测试定位。

### 什么时候用流式

- 工具**边生成边渲染**：`details.dsl` 是累积字符串，每帧算后缀。
- 工具**一次性返回**：直接 `render(dsl)`，不要 `startStream`。

判断依据：`details.status` 或工具是否声明了流式输出。

---

## 8. 安全边界

TokUI 的 handler 是**命名引用**，DSL 不能注入可执行代码。但仍要：

1. **DSL 大小上限**：1MB 是库的保护，业务应在工具层设更小（如 64KB）。
2. **组件白名单**：不接受任意自定义组件；只允许内置集合。
3. **handler 白名单**：只注册固定的 5 个名字；模型生成的 `clk:` 若不在白名单，点击无效果。
4. **链接**：`u:` 只允许 `https:`，且在系统浏览器打开（主进程）。
5. **隔离**：把 TokUI 容器放在独立的 `div`，用 CSS 限定作用域；不要让它继承应用的可点击区域。
6. **不信任 `details`**：渲染前做结构校验（`dsl` 是 string、`uiId` 是已知 id、长度合理）。

**不要**让 DSL 直接携带 HTML。TokUI 的文本内容按文本节点处理；如果你自己加自定义组件，必须显式转义。

---

## 9. 调试

- 打开 DevTools，检查容器上的 `data-tokui-theme` 与生成的 class（`tokui-btn--primary` 等）。
- DSL 不渲染：先 `ui.render(dsl)` 一次性验证语法，再排查流式。
- 未知组件：会渲染成 `div.tokui-unknown`；检查组件名拼写。
- 单个组件报错：会生成 `details.tokui-error`，不会炸整页。
- 事件不触发：确认 handler 名与 DSL 的 `clk:` 完全一致（大小写敏感）。
- 流式内容重复：检查 `feed` 是否喂了累积字符串而不是后缀。

---

## 10. 常见失败

| 现象 | 原因 | 修法 |
|---|---|---|
| 完全没样式 | 忘了 `import "@jboltai/tokui/css"` | 加引入 |
| 内容重复 | 每帧喂全量 | 只喂后缀 |
| 内容截断 | 没 `endStream()` | 结束时调用 |
| 切语言不生效 | 已渲染 DOM 不自动更新 | `rerender()` |
| 点击无反应 | handler 未注册/名字不符 | 检查 `clk:` 与注册名 |
| 多个消息互相影响 | handler 全局覆盖 | 固定 handler + `uiId` 路由 |
| 大 DSL 卡顿 | 单条消息过大 | 工具层限制大小、分块 |
| 卸载后仍触发 | 没 `disconnect()` | 清理副作用 |

---

## 11. 相关文档

- 富 UI 的持久化：[../01-架构/03-数据模型与Document设计.md](../01-架构/03-数据模型与Document设计.md) 的 `app.smartui`
- 交互回传：[../01-架构/02-模块交互.md](../01-架构/02-模块交互.md) 场景 G
- 动手：[阶段9](../05-阶段/阶段9-智能UI.md)
