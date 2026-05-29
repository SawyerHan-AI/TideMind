// ============================================================
// Obsidian Heading-based 分段器
//
// 将清洗后的 Obsidian Markdown 内容按语义分段。
// 与 Logseq 按缩进层级分段不同，Obsidian 按 heading 层级分段。
// ============================================================

import type { Segment, ObsidianFileCategory } from './types.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('obsidian:segment');

const MAX_SEGMENT_CHARS = 3000;
const SHORT_SEGMENT_THRESHOLD = 200;

// Backlinks/References 段落检测
const BACKLINKS_HEADING_RE = /^#{1,3}\s+(Backlinks|References|See Also|Related)\s*$/i;
const LINK_LINE_RE = /^\s*[-*]?\s*\[\[.+\]\]\s*$/;

/**
 * 将预处理后的 Obsidian 内容分段
 *
 * @param content - 预处理后的清洗文本（frontmatter 已移除）
 * @param category - 文件分类（决定分段策略）
 * @param pageTitle - 页面标题（用于上下文）
 */
export function segmentContent(
  content: string,
  category: ObsidianFileCategory,
  pageTitle: string = '',
): Segment[] {
  if (!content || content.trim().length === 0) return [];

  switch (category) {
    case 'empty_tag':
    case 'metadata_only':
      // 无实质内容，不分段
      return [];

    case 'index_page':
      // 索引页不拆分，整体作为 1 段
      return [{ content: content.trim(), context: pageTitle }];

    case 'excalidraw':
      return segmentExcalidraw(content, pageTitle);

    case 'daily_note':
      return segmentDailyNote(content, pageTitle);

    case 'readwise':
      return segmentReadwise(content, pageTitle);

    case 'chatgpt_export':
      return segmentChatGPT(content, pageTitle);

    case 'regular':
    default:
      return segmentRegular(content, pageTitle);
  }
}

// --- 普通文件分段：按 H1-H3 heading 切分 ---

function segmentRegular(content: string, pageTitle: string): Segment[] {
  const headingRe = /^(#{1,3})\s+(.+)$/gm;
  const sections = splitByPattern(content, headingRe);

  if (sections.length === 0) {
    // 无 heading：尝试按水平线分段
    return segmentByHorizontalRule(content, pageTitle);
  }

  const rawSegments: Segment[] = [];

  for (const section of sections) {
    // 检测是否为 Backlinks/References 段落
    if (isBacklinksSection(section.heading, section.body)) {
      log.debug('跳过 Backlinks 段落: %s', section.heading);
      continue;
    }

    const context = section.heading || pageTitle;
    const text = section.body.trim();
    if (text.length === 0) continue;

    rawSegments.push({ content: text, context });
  }

  // 合并空 heading（连续 heading 无内容时合并到下一个）、短段、拆长段
  return postProcess(rawSegments);
}

// --- Daily Note 分段：按水平线切分 ---

function segmentDailyNote(content: string, pageTitle: string): Segment[] {
  return segmentByHorizontalRule(content, pageTitle);
}

// --- Readwise 分段：按 --- 分隔符，每条高亮一段 ---

function segmentReadwise(content: string, pageTitle: string): Segment[] {
  const parts = content.split(/^---+$/m).map(p => p.trim()).filter(p => p.length > 0);

  if (parts.length === 0) return [];

  const segments: Segment[] = [];
  for (const part of parts) {
    // 移除残留的 [View Highlight](url) 标记
    const cleaned = part.replace(/\(?\[View Highlight\]\([^)]*\)\)?/g, '').trim();
    if (cleaned.length === 0) continue;
    segments.push({ content: cleaned, context: pageTitle });
  }

  return postProcess(segments);
}

// --- ChatGPT 导出分段：按对话轮次 ---

function segmentChatGPT(content: string, pageTitle: string): Segment[] {
  // 匹配 #### You: 和 #### ChatGPT: 标记
  const turnRe = /^####\s+(You|ChatGPT)\s*:/gm;
  const matches = [...content.matchAll(turnRe)];

  if (matches.length === 0) {
    // 不符合预期格式，回退到普通分段
    return segmentRegular(content, pageTitle);
  }

  const segments: Segment[] = [];
  let turnIndex = 0;

  // 按 You + ChatGPT 配对分组
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    if (match[1] !== 'You') continue;

    turnIndex++;
    const start = match.index!;
    // 找到这一轮结束的位置：下一个 #### You: 的位置，或内容末尾
    let end = content.length;
    for (let j = i + 1; j < matches.length; j++) {
      if (matches[j][1] === 'You') {
        end = matches[j].index!;
        break;
      }
    }

    let turnContent = content.slice(start, end).trim();
    // 清除 <time> 标签
    turnContent = turnContent.replace(/<time[^>]*>.*?<\/time>/g, '');

    if (turnContent.length > 0) {
      segments.push({
        content: turnContent,
        context: `${pageTitle} > 对话轮次 ${turnIndex}`,
      });
    }
  }

  return postProcess(segments);
}

// --- Excalidraw 分段：只提取 Text Elements ---

function segmentExcalidraw(content: string, pageTitle: string): Segment[] {
  // 查找 # Text Elements 段落
  const textElementsRe = /^#\s+Text Elements\s*$/m;
  const match = textElementsRe.exec(content);
  if (!match) {
    log.debug('Excalidraw 文件无 Text Elements 段落: %s', pageTitle);
    return [];
  }

  const start = match.index! + match[0].length;
  // Text Elements 段落结束于下一个 # heading 或文件末尾
  const nextHeadingRe = /^#\s+/m;
  const rest = content.slice(start);
  const nextMatch = nextHeadingRe.exec(rest);
  const textSection = nextMatch ? rest.slice(0, nextMatch.index) : rest;

  // 移除 ^blockId 后缀（Excalidraw 内部引用标记）
  const cleaned = textSection.replace(/\s*\^[a-zA-Z0-9]+$/gm, '').trim();
  if (cleaned.length === 0) return [];

  return [{ content: cleaned, context: `${pageTitle} [Excalidraw]` }];
}

// --- 按水平线分段 ---

function segmentByHorizontalRule(content: string, pageTitle: string): Segment[] {
  const parts = content.split(/^---+$/m).map(p => p.trim()).filter(p => p.length > 0);

  if (parts.length <= 1) {
    // 无分割线或只有一段：整体作为 1 段
    const text = content.trim();
    if (text.length === 0) return [];
    return postProcess([{ content: text, context: pageTitle }]);
  }

  const segments: Segment[] = parts.map(part => ({
    content: part,
    context: pageTitle,
  }));

  return postProcess(segments);
}

// --- Heading 切分辅助 ---

interface Section {
  heading: string;   // heading 文本（不含 # 标记），引言段为空
  body: string;      // heading 下的内容
}

/**
 * 按 H1-H3 heading 拆分内容为 sections
 *
 * 第一个 heading 之前的内容作为"引言"section（heading 为空）。
 */
function splitByPattern(content: string, headingRe: RegExp): Section[] {
  const sections: Section[] = [];
  const matches = [...content.matchAll(headingRe)];

  if (matches.length === 0) return [];

  // 引言段：第一个 heading 之前的内容
  const beforeFirst = content.slice(0, matches[0].index!).trim();
  if (beforeFirst.length > 0) {
    sections.push({ heading: '', body: beforeFirst });
  }

  // 各 heading 段
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

// --- Backlinks 段落检测 ---

/**
 * 判断某个 heading 段落是否为 Backlinks/References 段落
 *
 * 条件：heading 匹配特定模式 + 80% 以上的非空行是 [[link]] 列表
 */
function isBacklinksSection(heading: string, body: string): boolean {
  if (!heading) return false;

  // 构造完整的 heading 行来匹配（补上 # 前缀）
  const headingLine = `## ${heading}`;
  if (!BACKLINKS_HEADING_RE.test(headingLine) && !BACKLINKS_HEADING_RE.test(`# ${heading}`) && !BACKLINKS_HEADING_RE.test(`### ${heading}`)) {
    return false;
  }

  const lines = body.split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) return true; // 空的 backlinks 段落，直接跳过

  const linkLines = lines.filter(l => LINK_LINE_RE.test(l));
  return linkLines.length / lines.length >= 0.8;
}

// --- 后处理：合并短段、拆分长段 ---

function postProcess(segments: Segment[]): Segment[] {
  if (segments.length === 0) return [];

  // 1. 合并短段
  let merged = mergeShortSegments(segments);

  // 2. 拆分长段
  merged = splitLongSegments(merged);

  return merged;
}

/**
 * 合并过短的段落
 *
 * < 200 字符的段落与前一段合并；如果没有前一段，与后一段合并。
 */
function mergeShortSegments(segments: Segment[]): Segment[] {
  if (segments.length <= 1) return segments;

  // 与 notion/segmenter.ts F12(2026-05-21)对齐:旧实现有两个 mutation 点——
  //   a) `prev.content = ...` 直接改 result 数组里的对象(即调用方入参里的同一引用);
  //   b) `segments[i + 1] = {...}` 直接改写入参数组。
  // 改为:result 中始终保存新对象;"短段在最前面"时用循环本地变量 pendingPrefix
  // 累积,不触碰入参。当前调用链虽未读回入参,但保持纯函数避免与 F12 同根因回归。
  const result: Segment[] = [];
  let pendingPrefix: string | null = null;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];

    if (seg.content.length < SHORT_SEGMENT_THRESHOLD) {
      if (result.length > 0) {
        // 与前一段合并(用新对象替换,不改原对象)
        const prev = result[result.length - 1];
        result[result.length - 1] = {
          ...prev,
          content: prev.content + '\n\n' + seg.content,
        };
      } else {
        // 开头的短段(可能连续多个,含最后一段也短的情况)→ 累积到 pendingPrefix,
        // 等后面第一个长段把它带上;若整篇都短则在循环后合并成一段。
        // 必须无条件累积:之前对"最后一段也短"单独 push,会让末尾短段与缓存前缀
        // 顺序颠倒且漏合并([short,short]/全短文档退化),见 2026-05-29 round-2 audit。
        pendingPrefix = pendingPrefix !== null
          ? pendingPrefix + '\n\n' + seg.content
          : seg.content;
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

  // 残留 pendingPrefix(开头连续短段后未遇到长段,即整篇都短)→ 保持原顺序合并。
  // result 为空时整篇短段合成一段;若已有结果(理论上此分支不会进,防御性保留)则前置到首段。
  if (pendingPrefix !== null) {
    if (result.length > 0) {
      const first = result[0];
      result[0] = { ...first, content: pendingPrefix + '\n\n' + first.content };
    } else {
      result.push({ content: pendingPrefix, context: segments[0]?.context });
    }
  }

  return result;
}

/**
 * 拆分超长段落（> 3000 字符）
 *
 * 在段落边界（双换行）处拆分。
 */
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

/**
 * 按段落边界拆分文本
 */
function splitAtParagraphs(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    // 在 maxLen 以内找最近的段落边界（双换行）
    let splitAt = remaining.lastIndexOf('\n\n', maxLen);
    if (splitAt <= 0) {
      // 没有段落边界，在句子边界拆分
      splitAt = remaining.lastIndexOf('。', maxLen);
      if (splitAt <= 0) splitAt = remaining.lastIndexOf('. ', maxLen);
      if (splitAt <= 0) splitAt = maxLen;
      else splitAt += 1;
    }
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}
