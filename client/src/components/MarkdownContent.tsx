import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'

interface MarkdownContentProps {
  content: string
  className?: string
}

/**
 * F12: 显式 sanitize HTML 输出。
 *
 * react-markdown 默认会剥离裸 HTML 标签和危险 URL,但 LLM 输出的内容可能
 * 走 raw HTML 或被未来的 react-markdown 版本放宽默认策略。加 rehype-sanitize
 * 作为 defense-in-depth — 即使 markdown 文本里有 `<script>` / `<iframe>` /
 * `javascript:` / `data:` URL,经 sanitize 后也会被剥离。
 */
export function MarkdownContent({ content, className = '' }: MarkdownContentProps) {
  if (!content) return null

  return (
    <div className={`markdown-content prose prose-sm max-w-none ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
        {content}
      </ReactMarkdown>
    </div>
  )
}
