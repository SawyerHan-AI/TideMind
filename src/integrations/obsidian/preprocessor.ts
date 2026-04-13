// ============================================================
// Obsidian Markdown 预处理器
//
// 将原始 Obsidian markdown 清洗为干净文本 + 结构化元数据。
// 16 步流水线，每步聚焦一类语法元素的处理。
//
// 核心设计：
// - 纯函数（除文件 I/O）
// - 代码区域感知（避免误处理代码块/行内代码中的语法）
// - 输出与 Logseq preprocessor 相同的 PreprocessedPage 结构
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { createLogger } from '../../utils/logger.js';
import type { PreprocessedPage, PageMetadata } from './types.js';
import {
  OBSIDIAN_SYSTEM_PROPERTIES,
  PLUGIN_CODE_BLOCKS,
  CHECKBOX_MAP,
  FIELD_NAME_ALIASES,
} from './types.js';

const log = createLogger('obsidian:preprocess');

// ============================================================
// 公共 API
// ============================================================

/**
 * 预处理 Obsidian markdown 文件
 *
 * @param filePath  文件绝对路径
 * @param vaultRoot  vault 根目录
 * @param fileIndex  文件名索引（用于 wikilink 解析），可选
 * @returns 预处理结果，文件无效时返回 null
 */
export function preprocessFile(
  filePath: string,
  vaultRoot: string,
  fileIndex?: Map<string, string>,
): PreprocessedPage | null {
  let rawContent: string;
  try {
    rawContent = fs.readFileSync(filePath, 'utf-8');
  } catch {
    log.warn('文件读取失败: %s', filePath);
    return null;
  }

  if (rawContent.trim().length < 10) return null;

  const relPath = path.relative(vaultRoot, filePath).replace(/\\/g, '/');
  const metadata: PageMetadata = {
    aliases: [],
    tags: [],
    pageRefs: [],
    blockRefAssociations: [],
    properties: {},
    isJournal: false,
    filePath: relPath,
  };

  let content = rawContent;

  // Step 0: 标记代码区域（后续步骤跳过这些区域）
  let codeRegions = markCodeRegions(content);

  // Step 1: 解析 YAML frontmatter
  const fmResult = extractFrontmatter(content, metadata);
  content = fmResult.body;
  // frontmatter 被移除后需要重新计算代码区域
  if (fmResult.changed) {
    codeRegions = markCodeRegions(content);
  }

  // Step 2: frontmatter 值中的 wikilinks
  extractFrontmatterWikilinks(metadata);

  // Step 3: 过滤系统属性
  filterSystemProperties(metadata);

  // Step 4: 正文 wikilinks（跳过代码区域）
  content = resolveBodyWikilinks(content, metadata, codeRegions);
  codeRegions = markCodeRegions(content);

  // Step 5: Markdown 链接（跳过代码区域）
  content = resolveMarkdownLinks(content, metadata, codeRegions);
  codeRegions = markCodeRegions(content);

  // Step 6: 嵌入引用 ![[...]]
  content = resolveEmbeds(content, metadata, codeRegions);
  codeRegions = markCodeRegions(content);

  // Step 7: Dataview 行内字段（跳过代码区域）
  content = extractInlineFields(content, metadata, codeRegions);
  codeRegions = markCodeRegions(content);

  // Step 8: 标签（跳过代码区域）
  content = resolveTags(content, metadata, codeRegions);

  // Step 9: Callouts
  content = handleCallouts(content);

  // Step 10: Checkboxes
  content = handleCheckboxes(content);

  // Step 11: HTML 清理
  content = stripHtml(content);

  // Step 12: 插件代码块
  content = removePluginCodeBlocks(content, metadata);

  // Step 13: 杂项清理
  content = cleanUp(content);

  // Step 14: 脚注
  content = handleFootnotes(content);

  // 最终检查：内容过短则丢弃
  if (content.trim().length < 5) return null;

  // 推断标题
  const title = inferTitle(metadata);

  return { title, cleanContent: content, metadata };
}

/**
 * 构建文件名索引
 *
 * 扫描 vault 下所有 .md 文件，建立 {normalized_name -> filePath} 映射。
 * 支持 NFC 归一化、小写匹配、frontmatter aliases。
 */
export function buildFileIndex(
  vaultRoot: string,
  excludedDirs: string[],
): Map<string, string> {
  const index = new Map<string, string>();
  const files = walkMdFiles(vaultRoot, excludedDirs);

  for (const filePath of files) {
    const relPath = path.relative(vaultRoot, filePath).replace(/\\/g, '/');
    const basename = path.basename(relPath, '.md');

    // 主文件名
    const normalizedName = normalizeFileName(basename);
    index.set(normalizedName, relPath);

    // 从 frontmatter 读取 aliases
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const aliases = extractAliasesQuick(content);
      for (const alias of aliases) {
        const normalizedAlias = normalizeFileName(alias);
        // 不覆盖已有条目（优先保留文件名匹配）
        if (!index.has(normalizedAlias)) {
          index.set(normalizedAlias, relPath);
        }
      }
    } catch {
      // 读取失败跳过
    }
  }

  log.info('文件索引构建完成: %d 条', index.size);
  return index;
}

/**
 * 遍历 vault 目录下的所有 .md 文件（排除指定目录）
 */
export function walkMdFiles(vaultRoot: string, excludedDirs: string[]): string[] {
  const results: string[] = [];

  function walk(dir: string, relDir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (isExcludedDir(relPath, excludedDirs)) continue;
        walk(path.join(dir, entry.name), relPath);
      } else if (entry.name.endsWith('.md')) {
        results.push(path.join(dir, entry.name));
      }
    }
  }

  walk(vaultRoot, '');
  return results;
}

/**
 * 检查文件是否应该被处理
 */
export function shouldProcessFile(filename: string, excludedDirs: string[]): boolean {
  if (!filename.endsWith('.md')) return false;
  const normalized = filename.replace(/\\/g, '/');
  return !excludedDirs.some(
    excluded => normalized.startsWith(excluded + '/') || normalized === excluded,
  );
}

// ============================================================
// Step 0: 代码区域标记
// ============================================================

/** 代码区域：[start, end] 字符偏移量数组 */
type CodeRegion = [number, number];

/**
 * 标记所有代码区域（围栏代码块 + 行内代码）
 *
 * 后续步骤用 isInCodeRegion() 判断某个位置是否在代码中，
 * 避免误处理代码块内的 wikilink / tag 等语法。
 */
function markCodeRegions(content: string): CodeRegion[] {
  const regions: CodeRegion[] = [];

  // --- 围栏代码块（``` 或 ~~~） ---
  // 跳过超长行（>10000 字符，通常是 base64 图片）
  const lines = content.split('\n');
  let inFence = false;
  let fenceStart = 0;
  let fenceChar = '';
  let charOffset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 跳过超长行
    if (line.length > 10000) {
      charOffset += line.length + 1;
      continue;
    }

    if (!inFence) {
      const fenceMatch = line.match(/^(\s*)(```|~~~)/);
      if (fenceMatch) {
        inFence = true;
        fenceChar = fenceMatch[2];
        fenceStart = charOffset;
      }
    } else {
      // 检查是否是闭合围栏
      const closeMatch = line.match(/^(\s*)(```|~~~)\s*$/);
      if (closeMatch && closeMatch[2] === fenceChar) {
        regions.push([fenceStart, charOffset + line.length]);
        inFence = false;
        fenceChar = '';
      }
    }

    charOffset += line.length + 1; // +1 for \n
  }

  // 未闭合的围栏视为无效，不标记为代码区域

  // --- 行内代码 ---
  // 匹配 `...`（非代码块内）
  const inlineCodeRegex = /`([^`\n]+)`/g;
  let match;
  while ((match = inlineCodeRegex.exec(content)) !== null) {
    const start = match.index;
    const end = start + match[0].length;

    // 检查是否已经在围栏代码块内
    const inFenceBlock = regions.some(([s, e]) => start >= s && end <= e);
    if (!inFenceBlock) {
      regions.push([start, end]);
    }
  }

  return regions;
}

/**
 * 判断给定字符位置是否在代码区域内
 */
function isInCodeRegion(pos: number, regions: CodeRegion[]): boolean {
  return regions.some(([start, end]) => pos >= start && pos <= end);
}

// ============================================================
// Step 1: YAML Frontmatter 解析
// ============================================================

interface FrontmatterResult {
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
function extractFrontmatter(content: string, metadata: PageMetadata): FrontmatterResult {
  // 检查是否有 frontmatter
  if (!content.startsWith('---')) {
    return { body: content, changed: false };
  }

  const endIndex = content.indexOf('\n---', 3);
  if (endIndex === -1) {
    return { body: content, changed: false };
  }

  const fmRaw = content.slice(4, endIndex); // 跳过开头的 ---\n
  const body = content.slice(endIndex + 4).replace(/^\n/, ''); // 跳过结尾的 ---\n

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
 * 归一化字符串列表值（aliases 等）
 */
function normalizeStringList(value: unknown): string[] {
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
 * 将任意值转为字符串
 */
function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (Array.isArray(value)) return value.map(v => String(v ?? '')).join(', ');
  return String(value);
}

// ============================================================
// Step 2: Frontmatter 值中的 wikilinks
// ============================================================

/**
 * 从 frontmatter 值中提取 [[wikilink]] 引用
 *
 * 例：source: "[[某本书]]" → pageRefs += "某本书"，值变为 "某本书"
 */
function extractFrontmatterWikilinks(metadata: PageMetadata): void {
  const wikiRe = /\[\[([^\]]+)\]\]/g;

  // 检查 properties
  for (const [key, value] of Object.entries(metadata.properties)) {
    let match;
    let newValue = value;
    while ((match = wikiRe.exec(value)) !== null) {
      const ref = match[1].split('|')[0].trim(); // [[page|alias]] 取 page
      if (ref && !metadata.pageRefs.includes(ref)) {
        metadata.pageRefs.push(ref);
      }
    }
    // 去除 [[ ]]
    newValue = value.replace(/\[\[([^\]]+)\]\]/g, '$1');
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

// ============================================================
// Step 3: 过滤系统属性
// ============================================================

/**
 * 从 metadata.properties 中移除系统属性
 */
function filterSystemProperties(metadata: PageMetadata): void {
  for (const key of Object.keys(metadata.properties)) {
    if (OBSIDIAN_SYSTEM_PROPERTIES.includes(key)) {
      delete metadata.properties[key];
    }
  }
}

// ============================================================
// Step 4: 正文 Wikilinks
// ============================================================

/**
 * 解析正文中的 [[wikilinks]]（非嵌入引用）
 *
 * 处理：
 * - [[page]] → page
 * - [[page|alias]] → alias（取第一个未转义的 |）
 * - [[page#heading]] → page
 * - [[page#^block-id]] → page
 * - [[path/to/page]] → page（取最后一段）
 * - [[page\|alias]] → alias（表格中的转义 pipe）
 * - 排除全数字/标点的误匹配：[[1, 2, 3]]
 */
function resolveBodyWikilinks(
  content: string,
  metadata: PageMetadata,
  codeRegions: CodeRegion[],
): string {
  // 匹配 [[...]]，但排除 ![[...]]（嵌入引用在 Step 6 处理）
  return content.replace(
    /(?<!!)\[\[([^\]]+)\]\]/g,
    (fullMatch, inner: string, offset: number) => {
      // 跳过代码区域
      if (isInCodeRegion(offset, codeRegions)) return fullMatch;

      // 排除全数字/标点内容（如 [[1, 2, 3]]）
      if (/^[\d\s,.:;!?]+$/.test(inner)) return fullMatch;

      // 处理转义 pipe（表格中的 \|）
      const normalizedInner = inner.replace(/\\\|/g, '|');

      // 分离 page 和 alias（取第一个未转义的 |）
      let pagePart: string;
      let displayText: string;

      const pipeIndex = findFirstUnescapedPipe(normalizedInner);
      if (pipeIndex !== -1) {
        pagePart = normalizedInner.slice(0, pipeIndex).trim();
        displayText = normalizedInner.slice(pipeIndex + 1).trim();
      } else {
        pagePart = normalizedInner.trim();
        displayText = '';
      }

      // 去除 heading / block-id 后缀
      const hashIndex = pagePart.indexOf('#');
      const pageRef = hashIndex !== -1 ? pagePart.slice(0, hashIndex).trim() : pagePart;

      // 路径形式取最后一段
      const finalRef = pageRef.includes('/') ? pageRef.split('/').pop()! : pageRef;

      if (finalRef && !metadata.pageRefs.includes(finalRef)) {
        metadata.pageRefs.push(finalRef);
      }

      // 返回显示文本：有 alias 用 alias，否则用 page 名
      return displayText || (pagePart.includes('/') ? pagePart.split('/').pop()! : pagePart);
    },
  );
}

/**
 * 查找第一个未转义的 pipe 字符位置
 */
function findFirstUnescapedPipe(str: string): number {
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '|') {
      // 计算前面连续反斜杠数量，偶数个（含0）表示 pipe 未转义
      let backslashes = 0;
      for (let j = i - 1; j >= 0 && str[j] === '\\'; j--) {
        backslashes++;
      }
      if (backslashes % 2 === 0) return i;
    }
  }
  return -1;
}

// ============================================================
// Step 5: Markdown 链接
// ============================================================

/**
 * 解析标准 markdown 链接
 *
 * - [text](path.md) → pageRef
 * - [text](path) 无 .md → 视为页面名
 * - ![alt](local-image) → [图片: filename]
 * - ![alt](https://...) → [外部图片: alt]
 * - ![](data:image/...) → [内联图片]
 */
function resolveMarkdownLinks(
  content: string,
  metadata: PageMetadata,
  codeRegions: CodeRegion[],
): string {
  // 图片链接 ![alt](url)
  content = content.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    (fullMatch, alt: string, url: string, offset: number) => {
      if (isInCodeRegion(offset, codeRegions)) return fullMatch;

      // data URI
      if (url.startsWith('data:image/')) {
        return '[内联图片]';
      }

      // 外部图片
      if (/^https?:\/\//.test(url)) {
        if (!alt || /^\d+$/.test(alt.trim())) {
          return '[外部图片]';
        }
        return `[外部图片: ${alt}]`;
      }

      // 本地图片
      let decodedImgUrl: string;
      try {
        decodedImgUrl = decodeURIComponent(url);
      } catch {
        decodedImgUrl = url;
      }
      const filename = path.basename(decodedImgUrl.replace(/#.*$/, ''));
      return `[图片: ${filename}]`;
    },
  );

  // 普通链接 [text](url)
  content = content.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (fullMatch, text: string, url: string, offset: number) => {
      if (isInCodeRegion(offset, codeRegions)) return fullMatch;

      // 外部链接保持原样
      if (/^https?:\/\//.test(url)) {
        return fullMatch;
      }

      // 本地 .md 文件链接
      let rawDecodedUrl: string;
      try {
        rawDecodedUrl = decodeURIComponent(url);
      } catch {
        rawDecodedUrl = url;
      }
      const decodedUrl = rawDecodedUrl.replace(/#.*$/, '');
      if (decodedUrl.endsWith('.md')) {
        const pageName = path.basename(decodedUrl, '.md');
        if (pageName && !metadata.pageRefs.includes(pageName)) {
          metadata.pageRefs.push(pageName);
        }
        return text;
      }

      // 无扩展名的本地路径，视为页面名
      if (!path.extname(decodedUrl)) {
        const pageName = path.basename(decodedUrl);
        if (pageName && !metadata.pageRefs.includes(pageName)) {
          metadata.pageRefs.push(pageName);
        }
        return text;
      }

      // 其他文件类型链接，保持原样
      return fullMatch;
    },
  );

  return content;
}

// ============================================================
// Step 6: 嵌入引用 ![[...]]
// ============================================================

/** 图片扩展名 */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico']);
/** 媒体扩展名 */
const MEDIA_EXTENSIONS = new Set(['mp3', 'mp4', 'wav', 'ogg', 'webm', 'flac', 'm4a']);

/**
 * 解析嵌入引用 ![[...]]
 *
 * - ![[image.ext]] → [图片: image.ext]
 * - ![[file.pdf]] → [PDF: file.pdf]
 * - ![[file.pdf#page=N]] → [PDF: file.pdf, 第N页]
 * - ![[media.mp3]] → [媒体: media.mp3]
 * - ![[note]] → [引用: note]
 * - ![[note#heading]] → [引用: note section heading]
 * - ![[note#^blockid]] → [引用: note section blockid]
 */
function resolveEmbeds(
  content: string,
  metadata: PageMetadata,
  codeRegions: CodeRegion[],
): string {
  return content.replace(
    /!\[\[([^\]]+)\]\]/g,
    (fullMatch, inner: string, offset: number) => {
      if (isInCodeRegion(offset, codeRegions)) return fullMatch;

      // 去除尺寸参数 |NxM 或 |N
      const withoutSize = inner.replace(/\|[\dx]+$/i, '').trim();

      // 分离文件名和片段
      const hashIndex = withoutSize.indexOf('#');
      const fileName = hashIndex !== -1 ? withoutSize.slice(0, hashIndex).trim() : withoutSize;
      const fragment = hashIndex !== -1 ? withoutSize.slice(hashIndex + 1).trim() : '';

      // 获取扩展名
      const ext = path.extname(fileName).slice(1).toLowerCase();

      // 图片
      if (IMAGE_EXTENSIONS.has(ext)) {
        return `[图片: ${path.basename(fileName)}]`;
      }

      // PDF
      if (ext === 'pdf') {
        const pageMatch = fragment.match(/^page=(\d+)/);
        if (pageMatch) {
          return `[PDF: ${path.basename(fileName)}, 第${pageMatch[1]}页]`;
        }
        return `[PDF: ${path.basename(fileName)}]`;
      }

      // 媒体文件
      if (MEDIA_EXTENSIONS.has(ext)) {
        return `[媒体: ${path.basename(fileName)}]`;
      }

      // 笔记引用
      const noteName = fileName.includes('/') ? fileName.split('/').pop()! : fileName;

      if (noteName && !metadata.pageRefs.includes(noteName)) {
        metadata.pageRefs.push(noteName);
      }

      if (fragment) {
        // 去除 ^ 前缀（block id）
        const sectionName = fragment.startsWith('^') ? fragment.slice(1) : fragment;
        return `[引用: ${noteName} \u00A7 ${sectionName}]`;
      }

      return `[引用: ${noteName}]`;
    },
  );
}

// ============================================================
// Step 7: Dataview 行内字段
// ============================================================

/**
 * 提取 Dataview 行内字段
 *
 * 三种形式：
 * - 行首 key:: value → 移除整行，存入 properties
 * - (key:: value) → 替换为 value 文本，存入 properties
 * - [key:: value] → 替换为 value 文本，存入 properties
 *
 * 值中的 [[wikilink]] 会被提取到 pageRefs
 */
function extractInlineFields(
  content: string,
  metadata: PageMetadata,
  codeRegions: CodeRegion[],
): string {
  const lines = content.split('\n');
  const result: string[] = [];
  let charOffset = 0;

  for (const line of lines) {
    // 跳过代码区域内的行
    if (isInCodeRegion(charOffset, codeRegions)) {
      result.push(line);
      charOffset += line.length + 1;
      continue;
    }

    // 行首形式：key:: value
    const lineStartMatch = line.match(/^([\w][\w\s-]*)::(.*)$/);
    if (lineStartMatch) {
      const [, key, rawValue] = lineStartMatch;
      const value = rawValue.trim();
      storeInlineField(key.trim(), value, metadata);
      // 移除整行（不添加到 result）
      charOffset += line.length + 1;
      continue;
    }

    // 括号和方括号形式
    let processedLine = line;

    // (key:: value)
    processedLine = processedLine.replace(
      /\(([\w][\w\s-]*)::([^)]*)\)/g,
      (_, key: string, value: string) => {
        storeInlineField(key.trim(), value.trim(), metadata);
        return value.trim();
      },
    );

    // [key:: value] — 注意不能与 wikilink 混淆
    processedLine = processedLine.replace(
      /\[([\w][\w\s-]*)::([^\]]*)\]/g,
      (fullMatch, key: string, value: string) => {
        // 排除可能是 wikilink 的情况
        if (fullMatch.startsWith('[[')) return fullMatch;
        storeInlineField(key.trim(), value.trim(), metadata);
        return value.trim();
      },
    );

    result.push(processedLine);
    charOffset += line.length + 1;
  }

  return result.join('\n');
}

/**
 * 存储行内字段值，提取其中的 wikilink
 */
function storeInlineField(key: string, value: string, metadata: PageMetadata): void {
  // 提取值中的 wikilinks
  const wikiRe = /\[\[([^\]]+)\]\]/g;
  let match;
  while ((match = wikiRe.exec(value)) !== null) {
    const ref = match[1].split('|')[0].trim();
    if (ref && !metadata.pageRefs.includes(ref)) {
      metadata.pageRefs.push(ref);
    }
  }

  // 去除 wikilink 括号
  const cleanValue = value.replace(/\[\[([^\]]+)\]\]/g, '$1');

  // 存入 properties（同 key 拼接）
  if (metadata.properties[key]) {
    metadata.properties[key] += `, ${cleanValue}`;
  } else {
    metadata.properties[key] = cleanValue;
  }
}

// ============================================================
// Step 8: 标签
// ============================================================

/**
 * 解析 #tag 语法
 *
 * - 必须以非空白字符前导（或行首）
 * - 首字符必须是字母或中文
 * - 排除纯数字（如 #123）
 * - 嵌套标签 #parent/child → 同时添加 "parent" 和 "parent/child"
 * - 与 frontmatter tags 合并去重
 */
function resolveTags(
  content: string,
  metadata: PageMetadata,
  codeRegions: CodeRegion[],
): string {
  return content.replace(
    /(?<!\S)#([a-zA-Z\u4e00-\u9fff][\w/\u4e00-\u9fff-]*)/g,
    (fullMatch, tag: string, offset: number) => {
      if (isInCodeRegion(offset, codeRegions)) return fullMatch;

      // 排除纯数字
      if (/^\d+$/.test(tag)) return fullMatch;

      // 嵌套标签：#parent/child → 添加 "parent" 和 "parent/child"
      if (tag.includes('/')) {
        const parts = tag.split('/');
        let accumulated = '';
        for (const part of parts) {
          accumulated = accumulated ? `${accumulated}/${part}` : part;
          if (!metadata.tags.includes(accumulated)) {
            metadata.tags.push(accumulated);
          }
        }
      } else {
        if (!metadata.tags.includes(tag)) {
          metadata.tags.push(tag);
        }
      }

      return tag;
    },
  );
}

// ============================================================
// Step 9: Callouts
// ============================================================

/**
 * 处理 Obsidian callouts
 *
 * > [!type][+-]? 可选标题
 * > 内容...
 *
 * 保留内容文本，移除 [!type] 标记和折叠符号
 */
function handleCallouts(content: string): string {
  const lines = content.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    // 匹配 callout 标记行（支持嵌套引用 > > [!type]）
    const calloutMatch = line.match(/^((?:\s*>\s*)+)\[!(\w+)\][+-]?\s*(.*)?$/);
    if (calloutMatch) {
      const prefix = calloutMatch[1]; // 引用前缀 "> " 部分
      const title = calloutMatch[3]?.trim();
      if (title) {
        // 有标题时保留标题
        result.push(`${prefix}${title}`);
      }
      // 无标题时整行移除
      continue;
    }

    result.push(line);
  }

  return result.join('\n');
}

// ============================================================
// Step 10: Checkboxes
// ============================================================

/**
 * 处理扩展 checkbox 语法
 *
 * - [x] → [已完成]
 * - [ ] → [待办]
 * - [>] → [推迟]
 * 等，参见 CHECKBOX_MAP
 */
function handleCheckboxes(content: string): string {
  return content.replace(
    /^(\s*)-\s+\[(.)\]\s+/gm,
    (_match, indent: string, state: string) => {
      const mapped = CHECKBOX_MAP[state];
      if (mapped) {
        return `${indent}${mapped} `;
      }
      // 未知状态保留原始形式
      return `${indent}[${state}] `;
    },
  );
}

// ============================================================
// Step 11: HTML 清理
// ============================================================

/**
 * 清理 HTML 标签
 *
 * - <iframe>...</iframe> → 完全移除
 * - <br> / <br/> → 换行
 * - <details>/<summary> → 保留文本内容
 * - <mark style="...">text</mark> → text
 * - 其他标签 → 去除标签保留内容
 */
function stripHtml(content: string): string {
  // iframe 完全移除（含内容）
  content = content.replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '');

  // br 转换行
  content = content.replace(/<br\s*\/?>/gi, '\n');

  // 移除所有 HTML 标签，保留内容
  content = content.replace(/<[^>]+>/g, '');

  return content;
}

// ============================================================
// Step 12: 插件代码块
// ============================================================

/**
 * 移除插件代码块
 *
 * 整块删除 ```dataview ... ```, ```tasks ... ``` 等。
 * 对 dataview/dataviewjs：提取查询文本存入 metadata。
 */
function removePluginCodeBlocks(content: string, metadata: PageMetadata): string {
  const pluginPattern = PLUGIN_CODE_BLOCKS.join('|');
  // 匹配 ```type\n...\n``` 和 ~~~type\n...\n~~~
  const regex = new RegExp(
    `^[ \\t]*(\`\`\`|~~~)(${pluginPattern}|yaml:dbfolder)\\s*\\n([\\s\\S]*?)^[ \\t]*\\1\\s*$`,
    'gm',
  );

  const dataviewQueries: string[] = [];

  content = content.replace(regex, (_match, _fence, type: string, body: string) => {
    // dataview / dataviewjs: 提取查询文本
    if (type === 'dataview' || type === 'dataviewjs') {
      const query = body.trim();
      if (query) {
        dataviewQueries.push(query);
      }
    }
    return '';
  });

  // 存储 dataview 查询
  if (dataviewQueries.length > 0) {
    metadata.properties['dataview_queries'] = JSON.stringify(dataviewQueries);
  }

  return content;
}

// ============================================================
// Step 13: 杂项清理
// ============================================================

/**
 * 最终清理
 *
 * - %%...%% 注释（单行和多行）
 * - ^block-id 行尾标记
 * - <% ... %> Templater 语法
 * - ([View Highlight](url)) Readwise 标记
 * - ==text== 高亮标记
 * - ~~text~~ 删除线
 * - 连续空行压缩
 * - 行尾空白
 */
function cleanUp(content: string): string {
  // %%...%% 注释（多行）
  content = content.replace(/%%[\s\S]*?%%/g, '');

  // ^block-id 行尾标记
  content = content.replace(/\s+\^[\w-]+\s*$/gm, '');

  // <% ... %> Templater 语法（单行和多行）
  content = content.replace(/<%[\s\S]*?%>/g, '');

  // ([View Highlight](url)) Readwise 标记
  content = content.replace(/\(\[View Highlight\]\([^)]*\)\)/g, '');

  // ==text== 高亮 → 保留文本
  content = content.replace(/==([^=]+)==/g, '$1');

  // ~~text~~ 删除线 → 保留文本
  content = content.replace(/~~([^~]+)~~/g, '$1');

  // 连续 3+ 空行压缩为 2 行
  content = content.replace(/\n{3,}/g, '\n\n');

  // 行尾空白
  content = content.replace(/[ \t]+$/gm, '');

  // 首尾空行
  content = content.replace(/^\n+/, '');
  content = content.replace(/\n+$/, '');

  return content;
}

// ============================================================
// Step 14: 脚注
// ============================================================

/**
 * 处理脚注
 *
 * - [^id]: definition → 移除定义行
 * - [^id] 行内引用 → 保留原样
 */
function handleFootnotes(content: string): string {
  // 移除脚注定义行
  content = content.replace(/^\[\^[^\]]+\]:\s+.*$/gm, '');
  return content;
}

// ============================================================
// 工具函数
// ============================================================

/**
 * 推断页面标题
 *
 * 优先级：
 * 1. frontmatter 中的 title 字段
 * 2. 文件名（去除 .md 扩展名，解码 %20 等）
 */
function inferTitle(metadata: PageMetadata): string {
  // 优先使用 frontmatter title
  const fmTitle = metadata.properties['title'];
  if (fmTitle) {
    // title 已提取到 properties，从 properties 中移除（避免重复）
    delete metadata.properties['title'];
    return fmTitle;
  }

  // 从文件路径推断
  const basename = path.basename(metadata.filePath, '.md');
  try {
    return decodeURIComponent(basename);
  } catch {
    return basename;
  }
}

/**
 * 归一化文件名（用于索引匹配）
 *
 * NFC 归一化 + 小写
 */
function normalizeFileName(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/**
 * 快速从文件内容提取 frontmatter aliases（不做完整解析）
 */
function extractAliasesQuick(content: string): string[] {
  if (!content.startsWith('---')) return [];

  const endIndex = content.indexOf('\n---', 3);
  if (endIndex === -1) return [];

  const fmRaw = content.slice(4, endIndex);
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
 * 检查路径是否在排除目录中
 */
function isExcludedDir(relPath: string, excludedDirs: string[]): boolean {
  const normalized = relPath.replace(/\\/g, '/');
  return excludedDirs.some(
    excluded => normalized === excluded || normalized.startsWith(excluded + '/'),
  );
}
