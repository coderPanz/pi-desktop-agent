# 验收脚本归档（不属于产品代码）

这里放的是**阶段验收与实验脚本**，不是产品代码：

- 它们不参与构建（`pnpm build` 只打 `apps/desktop/dist`）
- 不参与 typecheck（根 `tsconfig.json` 不 include `docs/`）
- 不参与 lint（`eslint.config.mjs` 忽略 `docs/**`）
- 不进发布产物

放在 `docs/` 下的原因：这类脚本是「证据」而不是「功能」。产品目录里只应该有会被打包、会被调用、会被测试的东西。

## 现有脚本

| 文件 | 作用 |
|---|---|
| `stage0-min-agent.ts` | 最小 Agent 调用：`submit → wait → entries → inspect → close`，六项断言 |
| `lib/models.ts` | 自建 gateway provider（Anthropic Messages 协议），阶段 0 的模型入口 |
| `lib/assert.ts` | `check`（硬断言）/ `observe`（软观察）/ `report` |

## 怎么跑

```bash
pnpm stage0            # 等价于：tsx --env-file-if-exists=.env docs/verify/stage0-min-agent.ts
```

后续阶段的验收脚本也放这里，命名保持 `stage<N>-<主题>.ts`；纯函数的单测不放这里，直接与实现同包（`*.test.ts`）。
