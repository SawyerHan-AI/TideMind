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

// 导出供 F12 回归测试断言 mergeShortSegments 不 mutate 入参。
// 生产代码内仍走 segmentContent 主入口,不要直接调本函数。
export function mergeShortSegments(segments: Segment[]): Segment[] {
  if (segments.length <= 1) return segments;

  // 修复 F12(2026-05-21): 旧实现两个 mutation 点:
  //   a) `prev.content = prev.content + '\n\n' + seg.content` 直接改 result 数组中
  //      已 push 的 Segment 对象 — 当 result.push(seg) 时这是入参的同一对象引用,
  //      调用方传进来的数组里的对象内容也被偷偷改了。
  //   b) `segments[i + 1] = {...}` 直接改写入参数组,调用方 segments 数组被污染。
  // 改为:result 中保存的始终是新对象(用 push({...prev, content: ...}));
  // 处理"短段在最前面"时,把内容缓存在循环本地变量 pendingPrefix 而不是改入参。
  const result: Segment[] = [];
  let pendingPrefix: string | null = null; // 累积"短段在最前面"的待并入下一段的内容

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.content.length < SHORT_SEGMENT_THRESHOLD) {
      if (result.length > 0) {
        // 把当前短段合并到上一个段(用新对象替换,不改原对象)
        const prev = result[result.length - 1];
        result[result.length - 1] = {
          ...prev,
          content: prev.content + '\n\n' + seg.content,
        };
      } else if (i + 1 < segments.length) {
        // 短段在最前面 → 缓存到 pendingPrefix,下一轮跟下一段合并(不改入参)
        pendingPrefix = pendingPrefix !== null
          ? pendingPrefix + '\n\n' + seg.content
          : seg.content;
      } else {
        // 短段在最后面且 result 为空 → 直接 push(注意单段路径不需要重建对象)
        result.push(seg);
      }
    } else {
      if (pendingPrefix !== null) {
        // 把缓存的前缀合并到当前段(用新对象,不改原对象 / 不改入参)
        result.push({
          ...seg,
          content: pendingPrefix + '\n\n' + seg.content,
        });
        pendingPrefix = null;
      } else {
        result.push(seg);
      }
    }
  }

  // 最后还残留 pendingPrefix(整个数组都是短段)→ 单独成段
  if (pendingPrefix !== null) {
    // 这种情况只可能在首段是短段、所有段都短、且 result.push 这条 fallback 路径前
    // 触发(实际不会进:第一段短 + 没有下一段 = i+1 == length 走 push;有下一段就被
    // pendingPrefix 接走)。但走到这里保留兜底:新建一个段保留 context。
    result.push({ content: pendingPrefix, context: segments[0]?.context });
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
