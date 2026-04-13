// ============================================================
// Logseq Outliner 分段器
//
// 将清洗后的 Logseq 内容按语义分段。
// 基于缩进层级解析 block 树，按顶级 block 分组。
// ============================================================

import type { Segment, Block } from './types.js';

const MAX_SEGMENT_CHARS = 3000;
const SHORT_BLOCK_THRESHOLD = 200;
const MAX_SHORT_BLOCKS_TO_MERGE = 8;

/**
 * 将预处理后的内容分段
 *
 * @param cleanContent - preprocessor 输出的清洗文本（保留缩进）
 * @param pageTitle - 页面标题（用于上下文）
 * @param isJournal - 是否为 journal 文件
 */
export function segmentContent(
  cleanContent: string,
  pageTitle: string,
  isJournal: boolean,
): Segment[] {
  if (cleanContent.trim().length === 0) return [];

  const tree = parseBlockTree(cleanContent);
  if (tree.length === 0) return [];

  if (isJournal) {
    return segmentJournal(tree, pageTitle);
  }
  return segmentPage(tree, pageTitle);
}

// --- Block 树解析 ---

/**
 * 将缩进文本解析为 block 树
 *
 * 输入文本每行的缩进（空格数）决定层级：
 * - indent=0: 顶级 block
 * - indent=2: 二级
 * - indent=4: 三级
 * ...
 */
function parseBlockTree(content: string): Block[] {
  const lines = content.split('\n');
  const rootBlocks: Block[] = [];
  const stack: Array<{ block: Block; indent: number }> = [];

  for (const line of lines) {
    if (line.trim() === '') continue;

    const indent = line.search(/\S/);
    if (indent < 0) continue;

    const text = line.trim();

    const block: Block = {
      content: text,
      indent,
      children: [],
    };

    // 找到合适的父节点
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    if (stack.length === 0) {
      rootBlocks.push(block);
    } else {
      stack[stack.length - 1].block.children.push(block);
    }

    stack.push({ block, indent });
  }

  return rootBlocks;
}

// --- Page 分段 ---

/**
 * 普通页面分段：每个顶级 block + 子树为一个 segment
 */
function segmentPage(tree: Block[], pageTitle: string): Segment[] {
  const segments: Segment[] = [];

  for (const block of tree) {
    const blockText = renderBlockTree(block);

    if (blockText.length <= MAX_SEGMENT_CHARS) {
      segments.push({
        content: blockText,
        context: pageTitle,
      });
    } else {
      // 超长 block：在子 block 边界处拆分
      const subSegments = splitLargeBlock(block, pageTitle);
      segments.push(...subSegments);
    }
  }

  // 合并过短的 segments
  return mergeShortSegments(segments);
}

// --- Journal 分段 ---

/**
 * Journal 分段：连续短 block 合并
 *
 * Journal 通常是扁平的每日碎片记录，很多顶级 block 只有一两句话。
 * 合并相邻的短 block 减少 digest 调用次数。
 */
function segmentJournal(tree: Block[], pageTitle: string): Segment[] {
  const segments: Segment[] = [];
  let pendingShortBlocks: string[] = [];
  let pendingLength = 0;

  const flushPending = () => {
    if (pendingShortBlocks.length > 0) {
      segments.push({
        content: pendingShortBlocks.join('\n\n'),
        context: pageTitle,
      });
      pendingShortBlocks = [];
      pendingLength = 0;
    }
  };

  for (const block of tree) {
    const blockText = renderBlockTree(block);

    if (blockText.length > SHORT_BLOCK_THRESHOLD || block.children.length > 0) {
      // 非短 block 或有子 block：独立成 segment
      flushPending();

      if (blockText.length <= MAX_SEGMENT_CHARS) {
        segments.push({ content: blockText, context: pageTitle });
      } else {
        segments.push(...splitLargeBlock(block, pageTitle));
      }
    } else {
      // 短 block：累积
      if (
        pendingShortBlocks.length >= MAX_SHORT_BLOCKS_TO_MERGE ||
        pendingLength + blockText.length > MAX_SEGMENT_CHARS
      ) {
        flushPending();
      }
      pendingShortBlocks.push(blockText);
      pendingLength += blockText.length;
    }
  }

  flushPending();
  return segments;
}

// --- 辅助函数 ---

/**
 * 将 block 树渲染为文本（含子 block 缩进）
 */
function renderBlockTree(block: Block, depth: number = 0): string {
  const indent = '  '.repeat(depth);
  let text = `${indent}${block.content}`;

  for (const child of block.children) {
    text += '\n' + renderBlockTree(child, depth + 1);
  }

  return text;
}

/**
 * 拆分超长 block：每个子 block 独立成 segment，附带父 block 内容作为上下文
 */
function splitLargeBlock(block: Block, pageTitle: string): Segment[] {
  const segments: Segment[] = [];
  const parentContext = `${pageTitle} > ${block.content.slice(0, 100)}`;

  if (block.children.length === 0) {
    // 叶节点本身超长：按段落拆分
    const chunks = splitTextByParagraphs(block.content, MAX_SEGMENT_CHARS);
    for (const chunk of chunks) {
      segments.push({ content: chunk, context: parentContext });
    }
    return segments;
  }

  // 有子 block：尝试按子 block 分组
  let currentGroup: string[] = [block.content];
  let currentLen = block.content.length;

  for (const child of block.children) {
    const childText = renderBlockTree(child, 1);

    if (currentLen + childText.length > MAX_SEGMENT_CHARS && currentGroup.length > 1) {
      segments.push({
        content: currentGroup.join('\n'),
        context: pageTitle,
      });
      currentGroup = [block.content]; // 保留父 block 内容作为上下文
      currentLen = block.content.length;
    }

    currentGroup.push(childText);
    currentLen += childText.length;
  }

  if (currentGroup.length > 1) {
    segments.push({
      content: currentGroup.join('\n'),
      context: pageTitle,
    });
  }

  return segments;
}

/**
 * 按段落边界拆分超长文本
 */
function splitTextByParagraphs(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    // 在 maxLen 以内找最近的段落边界
    let splitAt = remaining.lastIndexOf('\n\n', maxLen);
    if (splitAt <= 0) {
      // 没有段落边界，在句子边界拆
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

/**
 * 合并过短的独立 segments
 */
function mergeShortSegments(segments: Segment[]): Segment[] {
  if (segments.length <= 1) return segments;

  const result: Segment[] = [];
  let pending: Segment | null = null;

  for (const seg of segments) {
    if (seg.content.length < SHORT_BLOCK_THRESHOLD) {
      if (pending) {
        // 合并
        pending = {
          content: pending.content + '\n\n' + seg.content,
          context: pending.context,
        };
        if (pending.content.length >= MAX_SEGMENT_CHARS) {
          result.push(pending);
          pending = null;
        }
      } else {
        pending = { ...seg };
      }
    } else {
      if (pending) {
        result.push(pending);
        pending = null;
      }
      result.push(seg);
    }
  }

  if (pending) {
    result.push(pending);
  }

  return result;
}
