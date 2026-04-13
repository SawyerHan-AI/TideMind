/**
 * 为没有标题的节点生成对外展示用的标题。
 *
 * 背景：节点的 title 可能是 null（digest 时没显式给标题），
 * 直接暴露给外部 Agent 时如果只 fallback 到 id，会变成一串乱码。
 * 此时截取 content 的前若干个字符作为"显示标题"。
 */
export function pickDisplayTitle(
  title: string | null | undefined,
  content: string | null | undefined,
  maxLen = 20,
): string | null {
  if (title && title.trim()) return title;
  if (content) {
    // 折叠空白、去首尾，按字符（code point）截断以避免破坏中文/emoji
    const normalized = content.replace(/\s+/g, ' ').trim();
    if (normalized.length === 0) return null;
    const codepoints = Array.from(normalized);
    if (codepoints.length <= maxLen) return normalized;
    return codepoints.slice(0, maxLen).join('') + '…';
  }
  return null;
}
