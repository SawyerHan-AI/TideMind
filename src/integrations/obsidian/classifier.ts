// ============================================================
// Obsidian 文件分类器
//
// 对 Obsidian vault 内的文件做初步分类，决定处理路径。
// 分类逻辑按优先级顺序检查，命中即返回。
// ============================================================

import path from 'node:path';
import { createLogger } from '../../utils/logger.js';
import type { ObsidianFileCategory, ClassifiedFile, ObsidianVaultConfig } from './types.js';

const log = createLogger('obsidian:classify');

/** 非 Markdown 的文件扩展名（视为附件） */
const NON_MD_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.mov',
  '.zip', '.tar', '.gz', '.rar', '.7z',
  '.json', '.xml', '.csv', '.tsv',
  '.ttf', '.otf', '.woff', '.woff2',
]);

/** Markdown 类扩展名 */
const MD_EXTENSIONS = new Set(['.md', '.canvas']);

/** frontmatter 匹配正则 */
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

/**
 * 分类所有文件
 *
 * @param files - 文件绝对路径列表
 * @param vaultRoot - vault 根目录
 * @param config - vault 配置
 * @param readContent - 读取文件内容的回调（支持外部缓存）
 */
export function classifyFiles(
  files: string[],
  vaultRoot: string,
  config: ObsidianVaultConfig,
  readContent: (path: string) => string | null,
): ClassifiedFile[] {
  const result: ClassifiedFile[] = [];
  const byCategory: Partial<Record<ObsidianFileCategory, number>> = {};

  for (const absPath of files) {
    const relPath = path.relative(vaultRoot, absPath).replace(/\\/g, '/');
    const ext = path.extname(absPath).toLowerCase();
    const basename = path.basename(absPath);

    // --- 1. attachment：在附件目录内，或非 .md/.canvas 扩展名 ---
    if (isAttachment(relPath, ext, config)) {
      pushResult(result, byCategory, { relPath, absPath, category: 'attachment', inDegree: 0 });
      continue;
    }

    // --- 2. template：在模板目录内 ---
    if (config.templateFolder && relPath.startsWith(config.templateFolder + '/')) {
      pushResult(result, byCategory, { relPath, absPath, category: 'template', inDegree: 0 });
      continue;
    }

    // --- 3. canvas：.canvas 扩展名 ---
    if (ext === '.canvas') {
      pushResult(result, byCategory, { relPath, absPath, category: 'canvas', inDegree: 0 });
      continue;
    }

    // 以下需要读取文件内容
    const content = readContent(absPath);

    // --- 4. excalidraw：文件名 .excalidraw.md 或 frontmatter 含 excalidraw-plugin ---
    if (basename.endsWith('.excalidraw.md')) {
      pushResult(result, byCategory, { relPath, absPath, category: 'excalidraw', inDegree: 0 });
      continue;
    }
    if (content !== null) {
      const fm = parseFrontmatterKeys(content);
      if (fm.has('excalidraw-plugin')) {
        pushResult(result, byCategory, { relPath, absPath, category: 'excalidraw', inDegree: 0 });
        continue;
      }
    }

    // --- 5. empty_tag：文件为空 ---
    if (content === null || content.trim().length === 0) {
      pushResult(result, byCategory, { relPath, absPath, category: 'empty_tag', inDegree: 0 });
      continue;
    }

    // --- 6. metadata_only：只有 frontmatter，正文 < 20 字符 ---
    const bodyText = extractBody(content);
    if (hasFrontmatter(content) && bodyText.length < 20) {
      pushResult(result, byCategory, { relPath, absPath, category: 'metadata_only', inDegree: 0 });
      continue;
    }

    // --- 7. daily_note：匹配日记路径和日期格式 ---
    if (isDailyNote(relPath, basename, config)) {
      pushResult(result, byCategory, { relPath, absPath, category: 'daily_note', inDegree: 0 });
      continue;
    }

    // --- 8. readwise：frontmatter category 含 #articles 或正文含 ## Highlights + --- ---
    if (isReadwise(content)) {
      pushResult(result, byCategory, { relPath, absPath, category: 'readwise', inDegree: 0 });
      continue;
    }

    // --- 9. chatgpt_export：frontmatter source 含 chat.openai.com 或正文匹配对话模式 ---
    if (isChatGPTExport(content)) {
      pushResult(result, byCategory, { relPath, absPath, category: 'chatgpt_export', inDegree: 0 });
      continue;
    }

    // --- 10. index_page：70%+ 非空行是 [[link]] 列表 ---
    if (isIndexPage(bodyText)) {
      pushResult(result, byCategory, { relPath, absPath, category: 'index_page', inDegree: 0 });
      continue;
    }

    // --- 11. regular：兜底 ---
    pushResult(result, byCategory, { relPath, absPath, category: 'regular', inDegree: 0 });
  }

  log.info(
    '分类完成: %d 个文件 — %s',
    result.length,
    Object.entries(byCategory).map(([k, v]) => `${k}:${v}`).join(', '),
  );

  return result;
}

/**
 * 统计每个页面的入度（被多少其他文件 [[引用]]）
 *
 * 遍历所有文件内容提取 [[引用]]，统计每个文件名被引用次数。
 * 跳过 canvas、template、attachment 类型的文件。
 *
 * @param files - classifyFiles 的输出
 * @param readContent - 读取文件内容的函数（支持缓存）
 * @returns Map<relPath（不含扩展名）, inDegree>
 */
export function buildInDegreeMap(
  files: ClassifiedFile[],
  readContent: (filePath: string) => string | null,
): Map<string, number> {
  const skipCategories = new Set<ObsidianFileCategory>(['canvas', 'template', 'attachment']);

  // 构建文件名 → relPath 的查找表（不含扩展名，用于匹配 [[link]]）
  const nameSet = new Set<string>();
  for (const f of files) {
    if (skipCategories.has(f.category)) continue;
    // Obsidian [[link]] 可以是文件名（不含扩展名）或完整路径
    const nameWithoutExt = f.relPath.replace(/\.md$/, '');
    nameSet.add(nameWithoutExt);
    // 也添加纯文件名（不含目录）
    const baseName = path.basename(f.relPath, '.md');
    nameSet.add(baseName);
  }

  const inDegree = new Map<string, number>();

  for (const file of files) {
    if (skipCategories.has(file.category)) continue;

    const content = readContent(file.absPath);
    if (!content) continue;

    const selfName = path.basename(file.relPath, '.md');
    const seen = new Set<string>();

    // 提取 [[link]] 和 [[link|alias]] 中的 link 部分
    for (const match of content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
      const refName = match[1].trim();
      if (refName === selfName) continue; // 跳过自引用
      if (seen.has(refName)) continue;
      seen.add(refName);

      if (nameSet.has(refName)) {
        inDegree.set(refName, (inDegree.get(refName) ?? 0) + 1);
      }
    }
  }

  log.info('入度统计: %d 个页面有入度 (max=%d)', inDegree.size, Math.max(0, ...inDegree.values()));
  return inDegree;
}

// ============================================================
// 分类判断辅助函数
// ============================================================

/** 判断是否为附件 */
function isAttachment(relPath: string, ext: string, config: ObsidianVaultConfig): boolean {
  // 在附件目录内
  if (config.attachmentFolder && relPath.startsWith(config.attachmentFolder + '/')) {
    return true;
  }
  // 非 Markdown 类扩展名
  if (!MD_EXTENSIONS.has(ext) && !relPath.endsWith('.excalidraw.md')) {
    return true;
  }
  return false;
}

/** 判断是否为 daily note */
function isDailyNote(relPath: string, basename: string, config: ObsidianVaultConfig): boolean {
  const dnConfig = config.dailyNotes;
  const folder = dnConfig?.folder ?? '';
  const format = dnConfig?.format ?? 'YYYY-MM-DD';

  // 检查路径是否在日记目录内
  if (folder) {
    if (!relPath.startsWith(folder + '/')) return false;
  }

  // 检查文件名是否匹配日期格式
  const nameWithoutExt = basename.replace(/\.md$/, '');
  const dateRegex = dateFormatToRegex(format);
  return dateRegex.test(nameWithoutExt);
}

/**
 * 将 Obsidian/moment.js 日期格式转换为正则表达式
 *
 * 支持常见格式：YYYY-MM-DD, YYYY_MM_DD, YYYYMMDD, DD-MM-YYYY 等
 */
function dateFormatToRegex(format: string): RegExp {
  const escaped = format
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')  // 转义正则特殊字符（除了替换 token）
    .replace(/YYYY/g, '\\d{4}')
    .replace(/YY/g, '\\d{2}')
    .replace(/MM/g, '\\d{2}')
    .replace(/DD/g, '\\d{2}')
    .replace(/M/g, '\\d{1,2}')
    .replace(/D/g, '\\d{1,2}');
  return new RegExp(`^${escaped}$`);
}

/** 判断是否为 Readwise 导入 */
function isReadwise(content: string): boolean {
  // frontmatter category 含 #articles
  const fm = extractFrontmatterRaw(content);
  if (fm && /category\s*:\s*.*#articles/i.test(fm)) {
    return true;
  }
  // 正文含 ## Highlights + --- 分隔模式
  const body = extractBody(content);
  if (/^##\s+Highlights/m.test(body) && /^---$/m.test(body)) {
    return true;
  }
  return false;
}

/** 判断是否为 ChatGPT 导出 */
function isChatGPTExport(content: string): boolean {
  // frontmatter source 含 chat.openai.com
  const fm = extractFrontmatterRaw(content);
  if (fm && /source\s*:.*chat\.openai\.com/i.test(fm)) {
    return true;
  }
  // 正文匹配 #### You: + #### ChatGPT: 模式
  const body = extractBody(content);
  if (/^####\s+You\s*:/m.test(body) && /^####\s+ChatGPT\s*:/m.test(body)) {
    return true;
  }
  return false;
}

/** 判断是否为索引页（70%+ 非空行是 [[link]] 列表） */
function isIndexPage(body: string): boolean {
  const lines = body.split('\n').filter(l => l.trim().length > 0);
  if (lines.length < 3) return false; // 太短不算索引页

  const linkLineRe = /^\s*[-*]?\s*\[\[.+\]\]/;
  const linkLines = lines.filter(l => linkLineRe.test(l));
  return linkLines.length / lines.length >= 0.7;
}

// ============================================================
// Frontmatter 解析辅助
// ============================================================

/** 提取 frontmatter 原始文本 */
function extractFrontmatterRaw(content: string): string | null {
  const match = FRONTMATTER_RE.exec(content);
  return match ? match[1] : null;
}

/** 解析 frontmatter 中的 key 集合（不需要解析值，只看有没有某个 key） */
function parseFrontmatterKeys(content: string): Set<string> {
  const raw = extractFrontmatterRaw(content);
  if (!raw) return new Set();

  const keys = new Set<string>();
  for (const line of raw.split('\n')) {
    const keyMatch = line.match(/^(\S+?)\s*:/);
    if (keyMatch) {
      keys.add(keyMatch[1]);
    }
  }
  return keys;
}

/** 判断是否有 frontmatter */
function hasFrontmatter(content: string): boolean {
  return FRONTMATTER_RE.test(content);
}

/** 提取 frontmatter 之后的正文 */
function extractBody(content: string): string {
  const match = FRONTMATTER_RE.exec(content);
  if (match) {
    return content.slice(match[0].length).trim();
  }
  return content.trim();
}

// ============================================================

function pushResult(
  result: ClassifiedFile[],
  counter: Partial<Record<ObsidianFileCategory, number>>,
  file: ClassifiedFile,
): void {
  result.push(file);
  counter[file.category] = (counter[file.category] ?? 0) + 1;
}
