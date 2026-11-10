import { createHash } from 'node:crypto';

/** Pure shared input contract: no config, database or provider/model calls. */
export const EMBEDDING_INPUT_VERSION = 'title-content-v1';
export const EMBEDDING_SEGMENT_VERSION = 'boundary-500-400-overlap50-v1';

const SEGMENT_THRESHOLD = 500;    // 超过此长度才分段
const SEGMENT_TARGET = 400;       // 每段目标长度
const SEGMENT_OVERLAP = 50;       // 段间重叠字符数

// ---- 分段策略 ----

/**
 * 将内容拆分为 embedding 分段
 *
 * 短内容（< 500 字符）不分段。
 * 长内容按段落/句子边界拆分，每段约 300-500 字符，
 * 相邻段有 50 字符重叠保持语义连续。
 */
export function segmentForEmbedding(content: string): string[] {
  if (!content.trim()) return [];
  if (content.length < SEGMENT_THRESHOLD) return [content];

  const segments: string[] = [];
  let start = 0;

  while (start < content.length) {
    const end = Math.min(start + SEGMENT_TARGET + 100, content.length);

    if (end < content.length) {
      // 在 target 附近找段落或句子边界
      let breakAt = content.lastIndexOf('\n\n', end);
      if (breakAt <= start) breakAt = content.lastIndexOf('\n', end);
      if (breakAt <= start) breakAt = content.lastIndexOf('。', end);
      if (breakAt <= start) breakAt = content.lastIndexOf('. ', end);
      if (breakAt <= start) breakAt = end; // 找不到边界就硬切
      else breakAt += 1; // 包含边界字符

      segments.push(content.slice(start, breakAt).trim());
      // 历史 bug(2026-05-09):兜底用 `start + 1` 在极端情形下让 start 每轮只
      // 前进 1 字符 —— 用户笔记里贴大段无标点串(base64、minified 代码、
      // 长 token 列表)且某次 breakAt - SEGMENT_OVERLAP <= start + 1 时,
      // 会产生数千个 1 字符递增的 segment,getEmbedding 调用爆量、nodes_vec 写爆。
      // 改为保证最小前进 SEGMENT_TARGET,与正常切分步长一致,牺牲一些 overlap
      // 但避免 quadratic 爆炸。
      start = Math.max(breakAt - SEGMENT_OVERLAP, start + SEGMENT_TARGET);
    } else {
      segments.push(content.slice(start).trim());
      break;
    }
  }

  return segments.filter(s => s.length > 0);
}

export function nodeEmbeddingInput(content: string, title?: string | null): string {
  return content.trim() ? (title ? `${title}\n\n${content}` : content) : (title ?? '');
}
export function nodeEmbeddingInputHash(content: string, title?: string | null): string {
  return createHash('sha256').update(nodeEmbeddingInput(content,title)).digest('hex');
}

