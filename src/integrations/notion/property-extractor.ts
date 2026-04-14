// ============================================================
// Notion Properties → PageMetadata 转换
// ============================================================

import type { PageObjectResponse } from '@notionhq/client/build/src/api-endpoints.js';
import type { PageMetadata } from './types.js';
import { NOTION_SYSTEM_PROPERTIES } from './types.js';

type PropertyValue = PageObjectResponse['properties'][string];

// ── 主入口 ────────────────────────────────────────────────────

/**
 * 从 Notion 页面属性中提取 PageMetadata。
 * - select/multi_select/status → tags（走 promotion）
 * - relation → pageRefs（后续创建 link）
 * - 其他属性 → properties（渲染到正文头部）
 */
export function extractMetadata(page: PageObjectResponse): PageMetadata {
  const metadata: PageMetadata = {
    aliases: [],
    tags: [],
    pageRefs: [],
    blockRefAssociations: [],
    properties: {},
    isJournal: false,
    filePath: page.id,
  };

  for (const [key, prop] of Object.entries(page.properties)) {
    extractSingleProperty(key, prop, metadata);
  }

  return metadata;
}

/**
 * 将 metadata.properties 序列化为正文头部文本。
 * 格式：每行 `属性名: 值`，末尾 `---` 分隔。
 */
export function renderPropertiesHeader(properties: Record<string, string>): string {
  const entries = Object.entries(properties);
  if (entries.length === 0) return '';

  const lines = entries.map(([key, value]) => `${key}: ${value}`);
  return lines.join('\n') + '\n---\n';
}

/**
 * 提取页面标题，若有 emoji icon 则拼在前面。
 */
export function extractTitle(page: PageObjectResponse): string {
  let title = extractTitleProperty(page.properties) || 'Untitled';

  // emoji icon 拼到标题前面
  if (page.icon && page.icon.type === 'emoji') {
    title = `${page.icon.emoji} ${title}`;
  }

  return title;
}

// ── 单属性提取 ────────────────────────────────────────────────

function extractSingleProperty(
  key: string,
  prop: PropertyValue,
  metadata: PageMetadata,
): void {
  // 跳过系统属性
  if (isSystemProperty(key, prop.type)) return;

  switch (prop.type) {
    case 'title':
      // 标题单独提取，不放入 properties
      break;

    case 'multi_select':
      if (prop.multi_select.length > 0) {
        const names = prop.multi_select.map(s => s.name);
        metadata.tags.push(...names);
        metadata.properties[key] = names.join(', ');
      }
      break;

    case 'select':
      if (prop.select) {
        metadata.tags.push(prop.select.name);
        metadata.properties[key] = prop.select.name;
      }
      break;

    case 'status':
      if (prop.status) {
        metadata.tags.push(prop.status.name);
        metadata.properties[key] = prop.status.name;
      }
      break;

    case 'relation':
      // relation → pageRefs（后续创建显式 link）
      // 注意：超过 25 条时 has_more 为 true，需要调用方额外处理
      if (prop.relation.length > 0) {
        metadata.pageRefs.push(...prop.relation.map(r => r.id));
      }
      break;

    case 'date':
      if (prop.date) {
        const dateStr = prop.date.end
          ? `${prop.date.start} → ${prop.date.end}`
          : prop.date.start;
        metadata.properties[key] = dateStr;
      }
      break;

    case 'checkbox':
      metadata.properties[key] = String(prop.checkbox);
      break;

    case 'number':
      if (prop.number !== null) {
        metadata.properties[key] = String(prop.number);
      }
      break;

    case 'url':
      if (prop.url) {
        metadata.properties[key] = prop.url;
      }
      break;

    case 'email':
      if (prop.email) {
        metadata.properties[key] = prop.email;
      }
      break;

    case 'phone_number':
      if (prop.phone_number) {
        metadata.properties[key] = prop.phone_number;
      }
      break;

    case 'rich_text': {
      const text = prop.rich_text.map(t => t.plain_text).join('');
      if (text) {
        metadata.properties[key] = text;
      }
      break;
    }

    case 'people':
      if (prop.people.length > 0) {
        metadata.properties[key] = prop.people
          .map(p => ('name' in p ? p.name : p.id) ?? p.id)
          .join(', ');
      }
      break;

    case 'files':
      if (prop.files.length > 0) {
        metadata.properties[key] = prop.files.map(f => f.name).join(', ');
      }
      break;

    case 'formula':
      if (prop.formula) {
        const f = prop.formula;
        const val = f.type === 'number' ? f.number
          : f.type === 'string' ? f.string
          : f.type === 'boolean' ? f.boolean
          : f.type === 'date' ? f.date?.start
          : null;
        if (val !== null && val !== undefined) {
          metadata.properties[key] = String(val);
        }
      }
      break;

    case 'unique_id':
      if (prop.unique_id) {
        const prefix = prop.unique_id.prefix ? `${prop.unique_id.prefix}-` : '';
        metadata.properties[key] = `${prefix}${prop.unique_id.number}`;
      }
      break;

    // created_time, last_edited_time, created_by, last_edited_by, rollup
    // → 跳过（系统属性或计算属性）
  }
}

// ── 辅助 ──────────────────────────────────────────────────────

function isSystemProperty(key: string, type: string): boolean {
  if (NOTION_SYSTEM_PROPERTIES.includes(key)) return true;
  // 系统自动属性类型
  if (['created_time', 'last_edited_time', 'created_by', 'last_edited_by', 'rollup'].includes(type)) {
    return true;
  }
  return false;
}

function extractTitleProperty(
  properties: PageObjectResponse['properties'],
): string | null {
  for (const prop of Object.values(properties)) {
    if (prop.type === 'title' && 'title' in prop) {
      const titleArr = prop.title as Array<{ plain_text: string }>;
      const text = titleArr.map(t => t.plain_text).join('');
      if (text) return text;
    }
  }
  return null;
}
