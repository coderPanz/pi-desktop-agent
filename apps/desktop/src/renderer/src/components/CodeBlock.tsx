import { useEffect, useRef, useState } from "react"
import type { ReactNode } from "react"

export type CodeBlockProps = {
  /** 围栏上的语言标签（`language-ts` 里的 `ts`）；没有就是普通文本块。 */
  readonly language: string | undefined
  readonly children?: ReactNode
}

/**
 * 代码块外壳：左上语言标签、右上复制按钮，中间是 `pre`。
 * 复制取渲染后的文本（`textContent`），不重新拼一遍源码，换行与缩进都不会走样。
 */
export function CodeBlock({ language, children }: CodeBlockProps) {
  const pre = useRef<HTMLPreElement | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => {
      setCopied(false)
    }, 1500)
    return () => clearTimeout(timer)
  }, [copied])

  const copy = (): void => {
    const text = pre.current?.textContent ?? ""
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true)
      })
      .catch(() => {
        // 剪贴板不可用（权限/无 preload）时什么都不做，不弹错误打断阅读
      })
  }

  return (
    <div className="my-3 overflow-hidden rounded-xl border border-divider bg-subtle">
      <div className="flex items-center justify-between gap-2 border-b border-divider px-3 py-1.5">
        <span className="truncate font-mono text-[11px] text-tertiary">{language ?? "text"}</span>
        <button
          type="button"
          aria-label={copied ? "已复制" : "复制代码"}
          className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-tertiary hover:bg-hover hover:text-primary"
          onClick={copy}
        >
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre ref={pre} className="overflow-x-auto px-4 py-3 text-[13px] leading-5 text-primary">
        {children}
      </pre>
    </div>
  )
}
