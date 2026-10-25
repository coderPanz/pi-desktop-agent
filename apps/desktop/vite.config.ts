// 渲染进程构建配置。main / preload 由 build/build.ts 用 esbuild 单独构建：
//   main  → ESM（Electron ≥28 支持 ESM 主进程）
//   preload → CJS（sandbox: true 下 preload 不支持 ESM）
import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const here = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))

export default defineConfig({
  root: here("./src/renderer"),
  base: "./",
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: here("./dist/renderer"),
    emptyOutDir: true,
    sourcemap: true,
  },
})
