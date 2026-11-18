import { safeCut } from "../lib/streamReveal.ts"
import { useStreamReveal } from "../hooks/useStreamReveal.ts"
import { MarkdownText } from "./Markdown.tsx"

/**
 * 正在生成的回答：文字按节奏揭示、逐词由外向内落定，
 * 排版与已提交消息共用同一套 Markdown 组件。
 */
export function StreamingMarkdown({ text }: { readonly text: string }) {
  const { shown, reveal } = useStreamReveal(text)
  return <MarkdownText text={text.slice(0, safeCut(text, shown))} reveal={reveal} />
}
