/** 模型输出仍按不可信内容处理：不启用原始 HTML；这里只定义排版。 */
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"

export function MarkdownText({ text }: { readonly text: string }) {
  return (
    <div className="pi-markdown min-w-0 text-[14px] leading-7 break-words text-primary">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
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
        }}
      >
        {text}
      </Markdown>
    </div>
  )
}
