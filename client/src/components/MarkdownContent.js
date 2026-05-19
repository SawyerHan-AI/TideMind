import { jsx as _jsx } from "react/jsx-runtime";
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
export function MarkdownContent({ content, className = '' }) {
    if (!content)
        return null;
    return (_jsx("div", { className: `markdown-content prose prose-sm max-w-none ${className}`, children: _jsx(ReactMarkdown, { remarkPlugins: [remarkGfm], children: content }) }));
}
