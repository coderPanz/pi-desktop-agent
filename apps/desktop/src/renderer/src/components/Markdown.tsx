/**
 * 回答正文的 Markdown 渲染。
 *
 * 模型输出是不可信内容：`react-markdown` 默认不渲染原始 HTML（不装 rehype-raw），
 * 链接、图片只当普通节点处理，所以这里不需要额外过滤。
 */
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"

export function MarkdownText({ text }: { readonly text: string }) {
  return (
    <div className="space-y-2 text-[13px] leading-relaxed text-[#c7ccd8]">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="whitespace-pre-wrap">{children}</p>,
          a: ({ children, href }) => (
            <a className="text-[#60a5fa] underline" href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          ul: ({ children }) => <ul className="list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5">{children}</ol>,
          code: ({ children, className }) => {
            const block = className !== undefined
            return block ? (
              <code className="block overflow-x-auto rounded bg-[#0d1017] p-3 font-mono text-[12px]">
                {children}
              </code>
            ) : (
              <code className="rounded bg-[#0d1017] px-1 py-0.5 font-mono text-[12px]">{children}</code>
            )
          },
          pre: ({ children }) => <pre className="overflow-x-auto">{children}</pre>,
          table: ({ children }) => (
            <table className="w-full border-collapse text-left text-[12px]">{children}</table>
          ),
          th: ({ children }) => (
            <th className="border-b border-[#262b36] px-2 py-1 text-[#9aa2b1]">{children}</th>
          ),
          td: ({ children }) => <td className="border-b border-[#1a1f28] px-2 py-1">{children}</td>,
        }}
      >
        {text}
      </Markdown>
    </div>
  )
}
