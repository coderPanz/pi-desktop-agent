/**
 * 流式回答的「逐词进场」标记：把 Markdown 里的文本节点切成词级 span，交给 CSS 做
 * 「由外向内收束 + 渐显」，动画结束后就是普通排版。
 *
 * 为什么在 hast 层做：react-markdown 每收到一段新文本都会重建整棵树，
 * 只有在这里产出稳定的 span 结构（同一个词永远是同一个位置上的 span），
 * React 才会按位置复用 DOM 节点；否则每个 token 都会重挂一次，动画会被不停重播。
 *
 * 结构一旦建立就不再变化：落定（settledBefore 之后的推进）只摘掉动画类，
 * span 本身保留，避免 inline-block ↔ inline 互换导致行尾重新折行。
 */

export const REVEAL_TOKEN_CLASS = "pi-stream-token"
export const REVEAL_WORD_CLASS = "pi-stream-word"

export type StreamReveal = {
  /** 小于该偏移的文本已经落定：保留 span，但不再带动画类。 */
  readonly settledBefore: number
  /** 同一批到达的词依次错开进场，返回毫秒延迟。 */
  readonly delayFor: (start: number) => number
}

export type RevealToken = {
  readonly kind: "space" | "word"
  readonly text: string
  /** 该词在「已渲染文本」里的起始偏移。 */
  readonly start: number
}

/** 中日韩文字没有空格，逐字进场才看得出来；拉丁文字按词进场。 */
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/
const SPACE = /^\s+$/

/** 把一段文本切成「词」与「空白」：空白保持原样（`whitespace-pre-wrap` 依赖它）。 */
export function revealTokens(text: string, base = 0): readonly RevealToken[] {
  const tokens: RevealToken[] = []
  let cursor = 0
  for (const piece of text.split(/(\s+)/)) {
    if (piece === "") continue
    if (SPACE.test(piece)) {
      tokens.push({ kind: "space", text: piece, start: base + cursor })
      cursor += piece.length
      continue
    }
    let word = ""
    let start = cursor
    for (const char of piece) {
      if (CJK.test(char)) {
        if (word !== "") tokens.push({ kind: "word", text: word, start: base + start })
        word = ""
        tokens.push({ kind: "word", text: char, start: base + cursor })
        cursor += char.length
        start = cursor
        continue
      }
      if (word === "") start = cursor
      word += char
      cursor += char.length
    }
    if (word !== "") tokens.push({ kind: "word", text: word, start: base + start })
  }
  return tokens
}

/** 揭示到 count 个字时该切在哪：别把代理对劈成两半（emoji / 生僻字会先冒出替换字符）。 */
export function safeCut(text: string, count: number): number {
  if (count <= 0) return 0
  if (count >= text.length) return text.length
  const before = text.charCodeAt(count - 1)
  return before >= 0xd800 && before <= 0xdbff ? count - 1 : count
}

/** hast 的最小形状：只碰我们需要的字段，不引入 hast 的类型依赖。 */
export type HastNode = {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

/** 代码块里不做逐词动画：行内代码与围栏代码都保持原样。 */
const CODE_TAGS = new Set(["code", "pre"])

type WalkState = {
  readonly reveal: StreamReveal
  /** 已渲染文本的偏移，用来和 `settledBefore` 对齐。 */
  cursor: number
}

/** rehype 插件：把文本节点换成词级 span。 */
export function rehypeStreamReveal(reveal: StreamReveal) {
  return (tree: HastNode): undefined => {
    walk(tree, { reveal, cursor: 0 })
    return undefined
  }
}

/**
 * `plain` 要整棵子树继承：高亮之后的代码块是 `pre > code > span.line > span`，
 * 只看当前节点的 tagName 会把里面的 span 当普通文字切一遍。
 */
function walk(node: HastNode, state: WalkState, inheritedPlain = false): void {
  const children = node.children
  if (children === undefined) return
  const plain = inheritedPlain || (node.type === "element" && node.tagName !== undefined && CODE_TAGS.has(node.tagName))
  const next: HastNode[] = []
  for (const child of children) {
    if (child.type === "text" && typeof child.value === "string") {
      if (plain) {
        state.cursor += child.value.length
        next.push(child)
        continue
      }
      next.push(...words(child.value, state))
      continue
    }
    walk(child, state, plain)
    next.push(child)
  }
  node.children = next
}

function words(value: string, state: WalkState): readonly HastNode[] {
  if (value === "") return []
  const out: HastNode[] = []
  for (const token of revealTokens(value, state.cursor)) {
    if (token.kind === "space") {
      out.push({ type: "text", value: token.text })
      continue
    }
    out.push(span(token, state.reveal))
  }
  state.cursor += value.length
  return out
}

function span(token: RevealToken, reveal: StreamReveal): HastNode {
  const properties: Record<string, unknown> = { className: [REVEAL_TOKEN_CLASS] }
  if (token.start >= reveal.settledBefore) {
    properties.className = [REVEAL_TOKEN_CLASS, REVEAL_WORD_CLASS]
    // 错开时间只能逐个算，写在 style 上由 CSS 变量之外的动画属性消费。
    properties.style = `animation-delay:${reveal.delayFor(token.start)}ms`
  }
  return { type: "element", tagName: "span", properties, children: [{ type: "text", value: token.text }] }
}
