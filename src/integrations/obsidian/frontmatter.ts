import yaml from 'js-yaml';
import { createLogger } from '../../utils/logger.js';
import type { PageMetadata } from './types.js';
import {
  FIELD_NAME_ALIASES,
  OBSIDIAN_SYSTEM_PROPERTIES,
} from './types.js';

const log = createLogger('obsidian:preprocess');

export interface FrontmatterResult {
  body: string;
  changed: boolean;
}

/**
 * 解析 YAML frontmatter
 *
 * - 正常解析 YAML
 * - 失败时去除 <% %> 和 {{ }} 模板语法后重试
 * - 二次失败则跳过 frontmatter
 * - 扁平化嵌套对象：{wellbeing: {mood: 3}} -> {'wellbeing.mood': '3'}
 * - 通过 FIELD_NAME_ALIASES 归一化字段名
 * - tags 的多态处理
 */
export function extractFrontmatter(content: string, metadata: PageMetadata): FrontmatterResult {
  // 检查是否有 frontmatter
  if (!content.startsWith('---')) {
    return { body: content, changed: false };
  }

  // 用 line-by-line 扫描找 frontmatter terminator：只有整行仅含 `---`
  // 才算真正的结束。避免 YAML block-scalar 里字面 `\n---` 被误判为结束。
  const lines = content.split('\n');
  // 第一行必为 `---`（已在上方 startsWith 校验），从第二行开始扫描。
  let terminatorLine = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i])) {
      terminatorLine = i;
      break;
    }
  }
  if (terminatorLine === -1) {
    return { body: content, changed: false };
  }

  const fmRaw = lines.slice(1, terminatorLine).join('\n');
  const body = lines.slice(terminatorLine + 1).join('\n').replace(/^\n/, '');

  // 第一次尝试解析
  let parsed = tryParseYaml(fmRaw);

  // 失败则去除模板语法后重试
  if (parsed === null) {
    const cleaned = fmRaw
      .replace(/<%.*?%>/gs, '')
      .replace(/\{\{.*?\}\}/gs, '');
    parsed = tryParseYaml(cleaned);
  }

  // 二次失败，跳过 frontmatter
  if (parsed === null || typeof parsed !== 'object') {
    log.debug('frontmatter 解析失败，跳过');
    return { body, changed: true };
  }

  const fm = parsed as Record<string, unknown>;

  // 扁平化并处理各字段
  const flat = flattenObject(fm);

  for (const [rawKey, value] of Object.entries(flat)) {
    // 归一化字段名
    const key = FIELD_NAME_ALIASES[rawKey] ?? rawKey;

    if (key === 'tags') {
      metadata.tags = normalizeTags(value);
    } else if (key === 'aliases') {
      metadata.aliases = normalizeStringList(value);
    } else if (key === 'title') {
      // title 存到 properties，后续 inferTitle 会用
      metadata.properties['title'] = String(value ?? '');
    } else {
      // 通用属性
      metadata.properties[key] = stringifyValue(value);
    }
  }

  return { body, changed: true };
}

/**
 * 从 frontmatter 值中提取 [[wikilink]] 引用
 *
 * 例：source: "[[某本书]]" → pageRefs += "某本书"，值变为 "某本书"
 */
export function extractFrontmatterWikilinks(metadata: PageMetadata): void {
  const wikiRe = /\[\[([^\]]+)\]\]/g;

  // 检查 properties
  for (const [key, value] of Object.entries(metadata.properties)) {
    let match;
    while ((match = wikiRe.exec(value)) !== null) {
      const ref = match[1].split('|')[0].trim(); // [[page|alias]] 取 page
      if (ref && !metadata.pageRefs.includes(ref)) {
        metadata.pageRefs.push(ref);
      }
    }
    // 去除 [[ ]]
    const newValue = value.replace(/\[\[([^\]]+)\]\]/g, '$1');
    if (newValue !== value) {
      metadata.properties[key] = newValue;
    }
  }

  // 检查 aliases
  for (let i = 0; i < metadata.aliases.length; i++) {
    const alias = metadata.aliases[i];
    const cleaned = alias.replace(/\[\[([^\]]+)\]\]/g, (_, inner: string) => {
      const ref = inner.split('|')[0].trim();
      if (ref && !metadata.pageRefs.includes(ref)) {
        metadata.pageRefs.push(ref);
      }
      return inner;
    });
    metadata.aliases[i] = cleaned;
  }
}

/**
 * 从 metadata.properties 中移除系统属性
 */
export function filterSystemProperties(metadata: PageMetadata): void {
  for (const key of Object.keys(metadata.properties)) {
    if (OBSIDIAN_SYSTEM_PROPERTIES.includes(key)) {
      delete metadata.properties[key];
    }
  }
}

/**
 * 归一化字符串列表值（aliases 等）
 */
export function normalizeStringList(value: unknown): string[] {
  if (value === null || value === undefined) return [];

  if (Array.isArray(value)) {
    return value.map(v => String(v ?? '').trim()).filter(Boolean);
  }

  if (typeof value === 'string') {
    return value.split(',').map(s => s.trim()).filter(Boolean);
  }

  return [String(value)];
}

/**
 * 快速从文件内容提取 frontmatter aliases（不做完整预处理）。
 */
export function extractAliasesQuick(content: string): string[] {
  // 统一换行，避免 CRLF 文件找不到 frontmatter 结束标记
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---')) return [];

  const endIndex = normalized.indexOf('\n---', 3);
  if (endIndex === -1) return [];

  const fmRaw = normalized.slice(4, endIndex);
  const parsed = tryParseYaml(fmRaw);
  if (!parsed || typeof parsed !== 'object') return [];

  const fm = parsed as Record<string, unknown>;
  const aliasKey = Object.keys(fm).find(k =>
    k === 'aliases' || k === 'alias' || k === 'Alias' || k === 'Aliases',
  );

  if (!aliasKey) return [];
  return normalizeStringList(fm[aliasKey]);
}

/**
 * 安全解析 YAML
 */
function tryParseYaml(raw: string): unknown {
  try {
    return yaml.load(raw);
  } catch {
    return null;
  }
}

/**
 * 扁平化嵌套对象
 *
 * {wellbeing: {mood: 3, energy: 4}} -> {'wellbeing.mood': '3', 'wellbeing.energy': '4'}
 */
function flattenObject(
  obj: Record<string, unknown>,
  prefix = '',
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;

    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      !(value instanceof Date)
    ) {
      Object.assign(result, flattenObject(value as Record<string, unknown>, fullKey));
    } else {
      result[fullKey] = value;
    }
  }

  return result;
}

/**
 * 归一化 tags 值
 *
 * 处理 tags 的多态：
 * - string: 按空格分割（不按逗号分割，尊重 Obsidian 行为）
 * - list: 直接扁平化
 * - null: 返回空数组
 * - 含逗号的字符串: 保持原样（不拆分）
 */
function normalizeTags(value: unknown): string[] {
  if (value === null || value === undefined) return [];

  if (Array.isArray(value)) {
    return value
      .flat()
      .map(v => String(v ?? '').replace(/^#/, '').trim())
      .filter(Boolean);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    // 按空格分割（Obsidian 行为：逗号分隔的不拆分）
    return trimmed
      .split(/\s+/)
      .map(t => t.replace(/^#/, '').trim())
      .filter(Boolean);
  }

  return [String(value)];
}

/**
 * 将任意值转为字符串
 */
function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (Array.isArray(value)) return value.map(v => String(v ?? '')).join(', ');
  return String(value);
}
