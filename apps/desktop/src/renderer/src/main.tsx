import { StrictMode } from "react" // 严格模式： 用于检测潜在问题
import { createRoot } from "react-dom/client" // 创建根节点

import { App } from "./App" // 应用入口组件
import "./styles/globals.css"

/**
 * `window` 是浏览器窗口对象
 * `document` 是页面文档（DOM 的根节点）
 *  window.document.getElementById("root") 获取到 id 为 root 的元素
 */
const container = document.getElementById("root")
if (container === null) throw new Error("找不到 #root 容器")

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
