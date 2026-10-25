// 扁平配置。两条硬边界写在这里，靠人记是记不住的：
//   1. 渲染进程不得 import pi-durable / electron / node:*（它只有只读副本与 IPC）
//   2. core 与扩展不得 import electron（要能被纯 Node 脚本测试）
import js from "@eslint/js"
import tseslint from "typescript-eslint"

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "docs/**", "**/electron-builder.yml"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["apps/desktop/src/renderer/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["electron", "electron/*"], message: "渲染进程不得直接访问主进程能力，一律走 window.pi。" },
            {
              group: ["@earendil-works/pi-durable", "@earendil-works/pi-durable/*"],
              message: "渲染进程不得持有 Harness；只允许 @earendil-works/chord/delta 的纯函数。",
            },
            { group: ["node:*"], message: "渲染进程没有 Node 能力。" },
            {
              group: ["@pi/core", "@pi/core/*", "@pi/shared-docs", "@pi/shared-docs/*"],
              message: "渲染进程只依赖 @pi/shared-types。",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/**/*.ts", "apps/cli/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["electron", "electron/*"],
              message: "core / 扩展 / cli 不得依赖 Electron，否则无法用纯 Node 脚本验收。",
            },
          ],
        },
      ],
    },
  },
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
)
