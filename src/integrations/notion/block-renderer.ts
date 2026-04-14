// ============================================================
// Notion Block → Markdown 渲染器
// ============================================================

import type { BlockObjectResponse, RichTextItemResponse } from '@notionhq/client/build/src/api-endpoints.js';
import { createLogger } from '../../utils/logger.js';
import { NOTION_SKIPPED_BLOCK_TYPES } from './types.js';

const log = createLogger('notion-block-renderer');

export interface RenderResult {
  text: string;
  pageRefs: string[]; // page_id 列表（从 mention 和 child_page 中提取）
}

// ── 主入口 ────────────────────────────────────────────────────

/**
 * 将扁平的 block 列表渲染为 Markdown 文本。
 * blocks 已由 api-client 递归获取并展平，每个 block 带有 parent 信息。
 * 这里重建树结构后渲染。
 */
export function renderBlocks(blocks: BlockObjectResponse[]): RenderResult {
  const pageRefs: string[] = [];
  const tree = buildBlockTree(blocks);
  const text = renderBlockNodes(tree, 0, pageRefs);
  return { text: text.trim(), pageRefs };
}

// ── Block 树重建 ──────────────────────────────────────────────

interface BlockNode {
  block: BlockObjectResponse;
  children: BlockNode[];
}

function buildBlockTree(blocks: BlockObjectResponse[]): BlockNode[] {
  const nodeMap = new Map<string, BlockNode>();
  const roots: BlockNode[] = [];

  // 先创建所有节点
  for (const block of blocks) {
    nodeMap.set(block.id, { block, children: [] });
  }

  // 建立父子关系
  for (const block of blocks) {
    const node = nodeMap.get(block.id)!;
    const parentId = getParentBlockId(block);
    const parentNode = parentId ? nodeMap.get(parentId) : null;

    if (parentNode) {
      parentNode.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

function getParentBlockId(block: BlockObjectResponse): string | null {
  const parent = block.parent;
  if (parent.type === 'block_id') return parent.block_id;
  return null; // page_id 或 workspace → 根节点
}

// ── 渲染逻辑 ──────────────────────────────────────────────────

function renderBlockNodes(nodes: BlockNode[], depth: number, pageRefs: string[]): string {
  let result = '';
  for (const node of nodes) {
    result += renderSingleBlock(node, depth, pageRefs);
  }
  return result;
}

function renderSingleBlock(node: BlockNode, depth: number, pageRefs: string[]): string {
  const { block, children } = node;
  const type = block.type;

  // 跳过的块类型
  if (NOTION_SKIPPED_BLOCK_TYPES.has(type)) {
    if (type === 'unsupported') {
      log.debug(`跳过不支持的块: ${block.id}`);
    }
    return '';
  }

  const indent = '  '.repeat(depth);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (block as any)[type] as Record<string, unknown> | undefined;
  if (!data) return '';

  switch (type) {
    case 'paragraph': {
      const text = extractRichText(data.rich_text as RichTextItemResponse[], pageRefs);
      const childText = renderBlockNodes(children, depth, pageRefs);
      if (!text && !childText) return '';
      return text ? `${indent}${text}\n\n${childText}` : childText;
    }

    case 'heading_1':
    case 'heading_2':
    case 'heading_3': {
      const level = parseInt(type.slice(-1));
      const prefix = '#'.repeat(level);
      const text = extractRichText(data.rich_text as RichTextItemResponse[], pageRefs);
      let result = `${prefix} ${text}\n\n`;
      // toggle heading: is_toggleable 为 true 时有子块
      if (children.length > 0) {
        result += renderBlockNodes(children, depth, pageRefs);
      }
      return result;
    }

    case 'bulleted_list_item': {
      const text = extractRichText(data.rich_text as RichTextItemResponse[], pageRefs);
      let result = `${indent}- ${text}\n`;
      if (children.length > 0) {
        result += renderBlockNodes(children, depth + 1, pageRefs);
      }
      return result;
    }

    case 'numbered_list_item': {
      const text = extractRichText(data.rich_text as RichTextItemResponse[], pageRefs);
      let result = `${indent}1. ${text}\n`;
      if (children.length > 0) {
        result += renderBlockNodes(children, depth + 1, pageRefs);
      }
      return result;
    }

    case 'to_do': {
      const text = extractRichText(data.rich_text as RichTextItemResponse[], pageRefs);
      const checked = data.checked ? 'x' : ' ';
      let result = `${indent}- [${checked}] ${text}\n`;
      if (children.length > 0) {
        result += renderBlockNodes(children, depth + 1, pageRefs);
      }
      return result;
    }

    case 'toggle': {
      const text = extractRichText(data.rich_text as RichTextItemResponse[], pageRefs);
      let result = `${indent}${text}\n`;
      if (children.length > 0) {
        result += renderBlockNodes(children, depth, pageRefs);
      }
      return result + '\n';
    }

    case 'quote': {
      const text = extractRichText(data.rich_text as RichTextItemResponse[], pageRefs);
      let result = `${indent}> ${text}\n`;
      if (children.length > 0) {
        const childText = renderBlockNodes(children, 0, pageRefs);
        result += childText
          .split('\n')
          .map(line => (line.trim() ? `${indent}> ${line}` : ''))
          .join('\n');
        result += '\n';
      }
      return result + '\n';
    }

    case 'callout': {
      const richText = data.rich_text as RichTextItemResponse[];
      const text = extractRichText(richText, pageRefs);
      const iconData = data.icon as { type: string; emoji?: string } | null;
      const emoji = iconData?.type === 'emoji' ? `${iconData.emoji} ` : '';
      let result = `${indent}> ${emoji}${text}\n`;
      if (children.length > 0) {
        const childText = renderBlockNodes(children, 0, pageRefs);
        result += childText
          .split('\n')
          .map(line => (line.trim() ? `${indent}> ${line}` : ''))
          .join('\n');
        result += '\n';
      }
      return result + '\n';
    }

    case 'code': {
      const text = extractRichText(data.rich_text as RichTextItemResponse[], pageRefs);
      const language = (data.language as string) || '';
      return `${indent}\`\`\`${language}\n${text}\n\`\`\`\n\n`;
    }

    case 'equation': {
      const expression = (data.expression as string) || '';
      return `${indent}$$\n${expression}\n$$\n\n`;
    }

    case 'table': {
      return renderTable(children, pageRefs);
    }

    case 'table_row': {
      // table_row 由 renderTable 处理，这里不单独渲染
      return '';
    }

    case 'column_list':
    case 'column': {
      // 忽略布局，顺序拼接子块内容
      return renderBlockNodes(children, depth, pageRefs);
    }

    case 'synced_block': {
      const syncData = data.synced_from as { block_id: string } | null;
      if (syncData !== null) {
        // duplicate synced block — 跳过，避免重复
        return '';
      }
      // original synced block — 渲染子块
      return renderBlockNodes(children, depth, pageRefs);
    }

    case 'child_page': {
      const title = (data.title as string) || 'Untitled';
      // child_page 的 block.id 就是子页面的 page_id
      pageRefs.push(block.id);
      return `${indent}[[${title}]]\n\n`;
    }

    case 'child_database': {
      const title = (data.title as string) || 'Untitled';
      return `${indent}[数据库: ${title}]\n\n`;
    }

    case 'link_to_page': {
      const linkData = data as { type: string; page_id?: string; database_id?: string };
      if (linkData.page_id) {
        pageRefs.push(linkData.page_id);
        return `${indent}[[链接页面]]\n\n`;
      }
      return '';
    }

    default: {
      // 处理 SDK 未定义的新块类型（heading_4, tab, meeting_notes 等）
      // 优先按文本块处理，其次按容器块处理
      // 尝试提取 rich_text（兜底处理未知的文本块类型）
      const richText = data.rich_text as RichTextItemResponse[] | undefined;
      if (richText && Array.isArray(richText)) {
        const text = extractRichText(richText, pageRefs);
        if (text) return `${indent}${text}\n\n`;
      }
      return '';
    }
  }
}

// ── Rich Text 提取 ───────────────────────────────────────────

/**
 * 从 rich_text 数组提取纯文本，处理 mention → [[标题]] + pageRef
 */
export function extractRichText(
  richTextArray: RichTextItemResponse[] | undefined,
  pageRefs: string[],
): string {
  if (!richTextArray || richTextArray.length === 0) return '';

  return richTextArray
    .map(item => {
      switch (item.type) {
        case 'text':
          return item.plain_text;

        case 'mention': {
          const mention = item.mention;
          if (mention.type === 'page') {
            pageRefs.push(mention.page.id);
            const title = item.plain_text || '未命名页面';
            return `[[${title}]]`;
          }
          if (mention.type === 'database') {
            pageRefs.push(mention.database.id);
            const title = item.plain_text || '未命名数据库';
            return `[[${title}]]`;
          }
          if (mention.type === 'user') {
            return `@${item.plain_text}`;
          }
          // date, link_preview, template_mention
          return item.plain_text;
        }

        case 'equation':
          return `$${item.equation.expression}$`;

        default:
          return (item as { plain_text: string }).plain_text;
      }
    })
    .join('');
}

// ── 表格渲染 ─────────────────────────────────────────────────

function renderTable(rowNodes: BlockNode[], pageRefs: string[]): string {
  if (rowNodes.length === 0) return '';

  const rows: string[][] = [];
  for (const rowNode of rowNodes) {
    const rowData = (rowNode.block as Record<string, unknown>).table_row as {
      cells: RichTextItemResponse[][];
    } | undefined;
    if (!rowData) continue;

    const cells = rowData.cells.map(cell => extractRichText(cell, pageRefs));
    rows.push(cells);
  }

  if (rows.length === 0) return '';

  // 生成 Markdown 表格
  const colCount = Math.max(...rows.map(r => r.length));
  const lines: string[] = [];

  // 表头
  const header = rows[0] || [];
  lines.push('| ' + padRow(header, colCount).join(' | ') + ' |');
  lines.push('| ' + Array(colCount).fill('---').join(' | ') + ' |');

  // 数据行
  for (let i = 1; i < rows.length; i++) {
    lines.push('| ' + padRow(rows[i], colCount).join(' | ') + ' |');
  }

  return lines.join('\n') + '\n\n';
}

function padRow(row: string[], colCount: number): string[] {
  const padded = [...row];
  while (padded.length < colCount) padded.push('');
  return padded.map(cell => cell.replace(/\|/g, '\\|')); // 转义表格分隔符
}
