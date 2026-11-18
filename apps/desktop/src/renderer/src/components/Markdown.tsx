/** 模型输出仍按不可信内容处理：不启用原始 HTML；这里只定义排版。 */
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { Components } from "react-markdown"

import { rehypeStreamReveal } from "../lib/streamReveal.ts"
import type { StreamReveal } from "../lib/streamReveal.ts"

/**
 * 组件表放在模块级：react-markdown 把每个函数当成 React 元素类型，
 * 每次渲染新建匿名函数等于换类型，整棵 Markdown 子树会被卸载重建——
 * 那会让流式进场的动画在每个 token 到来时从头重播。
 */
const COMPONENTS: Components = {
  p: ({ children }) => <p className="whitespace-pre-wrap">{children}</p>,
  a: ({ children, href }) => <a className="text-accent underline decoration-accent/35 underline-offset-3 hover:decoration-accent" href={href} target="_blank" rel="noreferrer">{children}</a>,
  ul: ({ children }) => <ul className="list-disc space-y-1 pl-5 marker:text-secondary">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5 marker:text-secondary">{children}</ol>,
  code: ({ children, className }) => <code className={className}>{children}</code>,
  pre: ({ children }) => <pre className="overflow-x-auto rounded-xl border border-divider bg-subtle px-4 py-3 text-secondary">{children}</pre>,
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto rounded-xl border border-divider">
      <table className="w-full border-collapse text-left text-[12px] leading-6">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b border-divider bg-subtle px-3 py-2 font-semibold text-secondary">{children}</th>,
  td: ({ children }) => <td className="border-b border-divider px-3 py-2 align-top">{children}</td>,
}

/**
 * `reveal` 只给流式回答用：带上它，新到的词走「由外向内收束」的进场动画；
 * 历史消息不带，渲染与以前完全一致。
 */
export function MarkdownText({ text, reveal }: { readonly text: string; readonly reveal?: StreamReveal }) {
  return (
    <div className="pi-markdown min-w-0 text-[14px] leading-7 break-words text-primary">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={reveal === undefined ? [] : [[rehypeStreamReveal, reveal]]}
        components={COMPONENTS}
      >
        {text}
      </Markdown>
    </div>
  )
}
