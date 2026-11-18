/**
 * 代码块高亮插件（rehype 层）：把 `pre > code.language-x` 的内容换成 Shiki 的 hast。
 *
 * 两条讲究：
 * - 只换 `code` 的内容，保留我们自己的 `pre`（圆角、浅灰底、滚动条都是 Tailwind 出来的），
 *   Shiki 输出的 `pre` 自带背景色，直接采用会把主题底色带进浅色界面；
 * - 文本末尾停在未闭合的围栏里时，跳过最后一块：流式时每 32ms 重分词会把 CPU 烧掉，
 *   等闭合之后再上色（闭合的那一刻就会亮，不用等下一段内容）。
 */
import { canHighlight, highlightCode } from "./highlight.ts"
import type { HastNode } from "./streamReveal.ts"

/** 文本末尾是否停在未闭合的围栏里（``` 或 ~~~）；流式时这种情况最后一块先不上色。 */
export function openFenceAtEnd(text: string): boolean {
  let open: string | undefined
  for (const line of text.split("\n")) {
    // 0–3 个空格缩进才算围栏：4 个空格是缩进代码块
    const match = /^ {0,3}(`{3,}|~{3,})/u.exec(line)
    const fence = match?.[1]
    if (fence === undefined) continue
    if (open === undefined) open = fence
    else if (fence[0] === open[0] && fence.length >= open.length) open = undefined
  }
  return open !== undefined
}

export function rehypeCodeHighlight(options: { readonly openFence: boolean }) {
  return (tree: HastNode): undefined => {
    const blocks = collectBlocks(tree)
    const skip = options.openFence && blocks.length > 0 ? blocks[blocks.length - 1] : undefined

    for (const block of blocks) {
      const language = block.language
      // 语言标签始终写上：高亮与不高亮都要能显示「这是什么语言的块」
      block.pre.properties = { ...ensureObject(block.pre.properties), "data-lang": language }
      if (block === skip || !canHighlight(language)) continue

      const highlighted = highlightCode(block.codeText, language)
      const shikiCode = highlighted === undefined ? undefined : findCode(highlighted)
      if (shikiCode?.children !== undefined) block.code.children = shikiCode.children
    }
    return undefined
  }
}

type Block = {
  readonly pre: HastNode
  readonly code: HastNode
  /** `language-ts` 里的 `ts`；没有语言标签时是 undefined。 */
  readonly language: string | undefined
  readonly codeText: string
}

/** 按文档顺序收集围栏代码块。 */
function collectBlocks(node: HastNode): readonly Block[] {
  const blocks: Block[] = []
  walk(node, blocks)
  return blocks
}

function walk(node: HastNode, blocks: Block[]): void {
  const children = node.children
  if (children === undefined) return
  for (const child of children) {
    if (child.type === "element" && child.tagName === "pre") {
      const code = child.children?.find(item => item.type === "element" && item.tagName === "code")
      if (code !== undefined) {
        blocks.push({
          pre: child,
          code,
          language: languageOf(code),
          codeText: textOf(code),
        })
        continue
      }
    }
    walk(child, blocks)
  }
}

/** `className: ["language-ts"]` → `ts`。 */
function languageOf(code: HastNode): string | undefined {
  const value = code.properties?.["className"]
  const classes = Array.isArray(value) ? value.map(String) : typeof value === "string" ? value.split(/\s+/u) : []
  for (const item of classes) {
    if (item.startsWith("language-")) return item.slice("language-".length)
  }
  return undefined
}

function textOf(node: HastNode): string {
  if (node.type === "text") return node.value ?? ""
  return (node.children ?? []).map(textOf).join("")
}

function findCode(node: HastNode): HastNode | undefined {
  if (node.type === "element" && node.tagName === "code") return node
  for (const child of node.children ?? []) {
    const found = findCode(child)
    if (found !== undefined) return found
  }
  return undefined
}

function ensureObject(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return value ?? {}
}
