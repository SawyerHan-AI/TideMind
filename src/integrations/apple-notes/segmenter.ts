// ============================================================
// Apple Notes 分段器
//
// 整条笔记作为一个 segment，仅当超过 MAX_SEGMENT_CHARS 时才拆分。
// 拆分优先级：标题边界 → 段落边界 → 句子边界 → 硬切
// ============================================================

import { MAX_SEGMENT_CHARS, type Segment } from './types.js';
import type { HeadingPosition } from './protobuf.js';

/**
 * 将笔记纯文本分段。
 *
 * @param cleanText - buildCleanText 输出的纯文本
 * @param title - 笔记标题（用于 segment.context）
 * @param headingPositions - extractHeadingPositions 返回的标题位置（可选）
 */
export function segmentNote(
  cleanText: string,
  title: string,
  headingPositions?: HeadingPosition[],
): Segment[] {
  if (!cleanText || cleanText.trim().length < 10) {
    return [];
  }

  // 短笔记：整条笔记一段
  if (cleanText.length <= MAX_SEGMENT_CHARS) {
    return [{ content: cleanText, context: title }];
  }

  // 长笔记：尝试按标题拆分
  if (headingPositions && headingPositions.length > 1) {
    const segments = splitByHeadings(cleanText, title, headingPositions);
    if (segments.length > 0) return segments;
  }

  // 没有标题或标题拆分失败：按段落/句子边界拆
  return splitByParagraphs(cleanText, title);
}

/**
 * 按标题位置拆分
 */
function splitByHeadings(
  text: string,
  title: string,
  headings: HeadingPosition[],
): Segment[] {
  const segments: Segment[] = [];

  // 跳过第一个标题（通常是笔记标题本身，offset=0）
  const splitPoints = headings
    .filter(h => h.offset > 0)
    .map(h => h.offset);

  if (splitPoints.length === 0) return [];

  // 在每个标题位置处切分
  // 但要找到该 offset 对应的行首位置（向前搜索 \n）
  const lineStartOffsets: number[] = [];
  for (const offset of splitPoints) {
    // 找到 offset 之前最近的换行符
    const lineStart = text.lastIndexOf('\n', offset - 1);
    lineStartOffsets.push(lineStart >= 0 ? lineStart + 1 : offset);
  }

  let prevEnd = 0;
  for (const splitAt of lineStartOffsets) {
    if (splitAt <= prevEnd) continue;

    const chunk = text.slice(prevEnd, splitAt).trim();
    if (chunk.length > 0) {
      // 如果单段仍然超长，进一步按段落拆分
      if (chunk.length > MAX_SEGMENT_CHARS) {
        segments.push(...splitByParagraphs(chunk, title));
      } else {
        segments.push({ content: chunk, context: title });
      }
    }
    prevEnd = splitAt;
  }

  // 最后一段
  const lastChunk = text.slice(prevEnd).trim();
  if (lastChunk.length > 0) {
    if (lastChunk.length > MAX_SEGMENT_CHARS) {
      segments.push(...splitByParagraphs(lastChunk, title));
    } else {
      segments.push({ content: lastChunk, context: title });
    }
  }

  // 合并过短的段落（< 200 字符的段与相邻段合并）
  return mergeShortSegments(segments);
}

/**
 * 按段落边界拆分超长文本（三级回退）
 */
function splitByParagraphs(text: string, title: string): Segment[] {
  if (text.length <= MAX_SEGMENT_CHARS) {
    return [{ content: text, context: title }];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > MAX_SEGMENT_CHARS) {
    // 在 MAX_SEGMENT_CHARS 以内找最近的段落边界
    let splitAt = remaining.lastIndexOf('\n\n', MAX_SEGMENT_CHARS);
    if (splitAt <= 0) {
      // 没有段落边界，在句子边界拆
      splitAt = remaining.lastIndexOf('。', MAX_SEGMENT_CHARS);
      if (splitAt <= 0) splitAt = remaining.lastIndexOf('. ', MAX_SEGMENT_CHARS);
      if (splitAt <= 0) splitAt = MAX_SEGMENT_CHARS; // 硬切
      else splitAt += 1;
    }
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks.map(content => ({ content, context: title }));
}

/**
 * 合并过短的 segments（< 200 字符）
 *
 * 纯函数：不修改输入 segments 数组或其内部对象，返回新数组。
 */
function mergeShortSegments(segments: Segment[]): Segment[] {
  if (segments.length <= 1) return segments.slice();

  const SHORT_THRESHOLD = 200;
  const result: Segment[] = [];
  // 拷贝一份用作可变的 pending buffer（避免修改输入）
  const buffer = segments.map(s => ({ content: s.content, context: s.context }));

  for (let i = 0; i < buffer.length; i++) {
    const seg = buffer[i];

    if (seg.content.length < SHORT_THRESHOLD && result.length > 0) {
      // 合并到上一段（result 里的对象是 buffer 的引用，直接改不会影响输入）
      const prev = result[result.length - 1];
      prev.content = prev.content + '\n\n' + seg.content;
    } else if (seg.content.length < SHORT_THRESHOLD && i + 1 < buffer.length) {
      // 合并到下一段（改 buffer 不影响输入）
      buffer[i + 1].content = seg.content + '\n\n' + buffer[i + 1].content;
    } else {
      result.push(seg);
    }
  }

  return result;
}
