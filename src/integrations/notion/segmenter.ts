// ============================================================
// Notion 分段器
//
// Notion 页面统一走 regular 分段策略：按 H1-H3 heading 拆分。
// 逻辑与 Obsidian segmentRegular 一致。
// ============================================================

import type { Segment } from './types.js';

const MAX_SEGMENT_CHARS = 3000;
const SHORT_SEGMENT_THRESHOLD = 200;

/**
 * 将预处理后的 Notion 页面内容分段
 */
export function segmentContent(content: string, pageTitle: string = ''): Segment[] {
  if (!content || content.trim().length === 0) return [];

  const headingRe = /^(#{1,4})\s+(.+)$/gm;
  const sections = splitByHeadings(content, headingRe);

  if (sections.length === 0) {
    // 无 heading：整页作为一个 segment
    return postProcess([{ content: content.trim(), context: pageTitle }]);
  }

  const rawSegments: Segment[] = [];
  for (const section of sections) {
    const context = section.heading || pageTitle;
    const text = section.body.trim();
    if (text.length === 0) continue;
    rawSegments.push({ content: text, context });
  }

  return postProcess(rawSegments);
}

// ── Heading 切分 ──────────────────────────────────────────────

interface Section {
  heading: string;
  body: string;
}

function splitByHeadings(content: string, headingRe: RegExp): Section[] {
  const sections: Section[] = [];
  const matches = [...content.matchAll(headingRe)];

  if (matches.length === 0) return [];

  // 引言段：第一个 heading 之前的内容
  const beforeFirst = content.slice(0, matches[0].index!).trim();
  if (beforeFirst.length > 0) {
    sections.push({ heading: '', body: beforeFirst });
  }

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const headingText = match[2].trim();
    const bodyStart = match.index! + match[0].length;
    const bodyEnd = i + 1 < matches.length ? matches[i + 1].index! : content.length;
    const body = content.slice(bodyStart, bodyEnd).trim();
    sections.push({ heading: headingText, body });
  }

  return sections;
}

// ── 后处理：合并短段、拆分长段 ────────────────────────────────

function postProcess(segments: Segment[]): Segment[] {
  if (segments.length === 0) return [];
  let result = mergeShortSegments(segments);
  result = splitLongSegments(result);
  return result;
}

function mergeShortSegments(segments: Segment[]): Segment[] {
  if (segments.length <= 1) return segments;

  const result: Segment[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.content.length < SHORT_SEGMENT_THRESHOLD) {
      if (result.length > 0) {
        const prev = result[result.length - 1];
        prev.content = prev.content + '\n\n' + seg.content;
      } else if (i + 1 < segments.length) {
        segments[i + 1] = {
          content: seg.content + '\n\n' + segments[i + 1].content,
          context: segments[i + 1].context,
        };
      } else {
        result.push(seg);
      }
    } else {
      result.push(seg);
    }
  }
  return result;
}

function splitLongSegments(segments: Segment[]): Segment[] {
  const result: Segment[] = [];
  for (const seg of segments) {
    if (seg.content.length <= MAX_SEGMENT_CHARS) {
      result.push(seg);
      continue;
    }
    const chunks = splitAtParagraphs(seg.content, MAX_SEGMENT_CHARS);
    for (const chunk of chunks) {
      result.push({ content: chunk, context: seg.context });
    }
  }
  return result;
}

function splitAtParagraphs(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf('\n\n', maxLen);
    if (splitAt <= 0) {
      splitAt = remaining.lastIndexOf('。', maxLen);
      if (splitAt <= 0) splitAt = remaining.lastIndexOf('. ', maxLen);
      if (splitAt <= 0) splitAt = maxLen;
      else splitAt += 1;
    }
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}
