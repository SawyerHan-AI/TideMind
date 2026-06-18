// ============================================================
// Logseq Markdown 预处理器
//
// 将原始 Logseq markdown 清洗为干净文本 + 结构化元数据。
// 核心设计：纯函数（除 block reference 解析需要外部索引）。
// ============================================================

import path from 'node:path';
import type { PreprocessedPage, PageMetadata } from './types.js';
import { SYSTEM_PROPERTIES, EXCLUDED_DIRS } from './types.js';
import { safeReadTextFileSync, walkFilesFiltered } from '../../utils/safe-fs.js';

// --- Block UUID 索引 ---
//
// 多 graph 场景下，每个 graphRoot 维护独立的 UUID → 内容 映射，
// 避免 buildBlockIndex(graphRootA) clear 掉 graphRootB 已填好的索引。

/** graphRoot → (UUID → block 原始内容) */
const blockIndexByGraph = new Map<string, Map<string, string>>();

function getBlockIndex(graphRoot: string): Map<string, string> {
  let idx = blockIndexByGraph.get(graphRoot);
  if (!idx) {
    idx = new Map<string, string>();
    blockIndexByGraph.set(graphRoot, idx);
  }
  return idx;
}

/**
 * 构建 block UUID 索引
 * 扫描所有 .md 文件，提取带 `id:: <uuid>` 的 block 内容
 *
 * 注意：walkMdFiles 内部已过滤 iCloud dataless 文件，indexFileBlocks 里的读操作
 * 不会阻塞主进程 event loop。
 */
export function buildBlockIndex(graphRoot: string): void {
  const idx = getBlockIndex(graphRoot);
  idx.clear();
  const files = walkMdFiles(graphRoot);
  for (const filePath of files) {
    indexFileBlocks(filePath, idx);
  }
}

/**
 * 增量更新：重新索引单个文件的 blocks
 */
export function updateBlockIndexForFile(filePath: string, graphRoot: string): void {
  // 移除该文件旧的索引条目
  // 由于我们没有追踪 uuid→file 映射，全量重建该文件即可
  // 删除旧条目的代价可忽略（重复 set 覆盖即可）
  const idx = getBlockIndex(graphRoot);
  indexFileBlocks(filePath, idx);
}

function indexFileBlocks(filePath: string, blockIndex: Map<string, string>): void {
  const res = safeReadTextFileSync(filePath);
  if (!res.ok) return;
  const content = res.content;

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const idMatch = lines[i].match(/^\s*id:: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/);
    if (!idMatch) continue;

    const uuid = idMatch[1];
    // 向上查找该 block 的内容行（同缩进级别的 `- ` 开头行）
    const idIndent = lines[i].search(/\S/);
    let blockContent = '';

    for (let j = i - 1; j >= 0; j--) {
      const line = lines[j];
      if (line.trim() === '') continue;

      const lineIndent = line.search(/\S/);
      // 找到了同级或更低缩进的 `- ` 行，这就是 block 开始
      if (lineIndent <= idIndent && /^\s*- /.test(line)) {
        // 收集从这行到 id:: 行之间的所有内容（不含 id:: 本身和其他 properties）
        const contentLines: string[] = [];
        for (let k = j; k < i; k++) {
          const cl = lines[k];
          // 跳过 property 行
          if (/^\s*\w[\w-]*:: /.test(cl)) continue;
          contentLines.push(cl);
        }
        blockContent = contentLines
          .map(l => l.replace(/^\s*- /, '').replace(/^\s+/, ''))
          .join(' ')
          .trim();
        break;
      }
    }

    if (blockContent) {
      blockIndex.set(uuid, blockContent);
    }
  }
}

/** 查询 block 索引（按 graphRoot 隔离） */
export function lookupBlock(uuid: string, graphRoot: string): string | undefined {
  return blockIndexByGraph.get(graphRoot)?.get(uuid);
}

/** 获取索引大小（用于进度报告） */
export function getBlockIndexSize(graphRoot: string): number {
  return blockIndexByGraph.get(graphRoot)?.size ?? 0;
}

// --- 目录/文件过滤 ---

/**
 * 遍历 graph 目录下的所有 .md 文件（排除系统目录）。
 *
 * 内部通过 walkFilesFiltered 同时剔除：
 *   - iCloud stub 文件（`.xxx.md.icloud`）
 *   - iCloud dataless 文件（size>0, blocks=0）——不跳过会导致 readFileSync
 *     同步阻塞触发下载，锁死主进程
 *
 * onDatalessSkip：可选回调，每命中一个 dataless 文件调一次，调用方自行聚合。
 */
export function walkMdFiles(
  graphRoot: string,
  onDatalessSkip?: (filePath: string) => void,
): string[] {
  return walkFilesFiltered(graphRoot, {
    extensions: ['.md'],
    excludeDir: isExcludedDir,
    onDatalessSkip,
  });
}

/**
 * 检查路径是否在排除目录中。
 *
 * 规则：
 * - 含斜杠的规则（如 `logseq/bak`）：按完整 relPath 精确前缀匹配；
 * - 不含斜杠的规则（如 `assets`、`draws`、`.git`）：只在 graph 根目录的一层
 *   （depth 1）匹配，避免用户在深层目录里叫 `assets` 的笔记夹被误排除。
 */
export function isExcludedDir(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/');
  return EXCLUDED_DIRS.some(excluded => {
    if (excluded.includes('/')) {
      return normalized === excluded || normalized.startsWith(excluded + '/');
    }
    // depth 1：basename 等于 excluded 且 relPath 不含斜杠
    return normalized === excluded;
  });
}

/**
 * 检查文件路径是否应该被处理
 *
 * relPath 是文件相对 graph 根的路径，比如 `pages/foo.md`、`assets/bar.md`。
 * 规则与 isExcludedDir 一致：不含斜杠的 excluded 只在文件的第一段目录匹配，
 * 避免深层子目录里的同名文件夹被误排除。
 */
export function shouldProcessFile(relPath: string): boolean {
  if (!relPath.endsWith('.md')) return false;
  const normalized = relPath.replace(/\\/g, '/');
  const firstSegment = normalized.includes('/') ? normalized.split('/')[0] : '';
  return !EXCLUDED_DIRS.some(excluded => {
    if (excluded.includes('/')) {
      return normalized === excluded || normalized.startsWith(excluded + '/');
    }
    // depth 1：只在文件挂在 graph 根下的某个 excluded 目录里时才匹配
    return firstSegment === excluded;
  });
}

// --- 核心预处理 ---

/**
 * 预处理 Logseq markdown 文件。
 *
 * 返回类型把 rawContent 收窄为必填(PreprocessedPage 基类里为可选,因 Notion 等
 * 非文件源复用该类型时无原始文件内容)。本函数所有非 null 返回路径都填了 rawContent,
 * 故调用方(init / queue)可直接用 preprocessed.rawContent 算 hash,无需 undefined 守卫,
 * 与 Obsidian preprocessFile(返回 ObsidianPreprocessedPage,rawContent 必填)对齐。
 */
export function preprocessFile(
  filePath: string,
  graphRoot: string,
): (PreprocessedPage & { rawContent: string }) | null {
  const res = safeReadTextFileSync(filePath);
  if (!res.ok) return null;
  // 统一换行为 LF：LOGBOOK/properties 等正则用 `$` 锚点，CRLF 会在值里留下 \r
  // 与 Obsidian preprocessor 保持一致
  const rawContent = res.content.replace(/\r\n/g, '\n');

  if (rawContent.trim().length < 10) return null;

  const relPath = path.relative(graphRoot, filePath).replace(/\\/g, '/');
  const isJournal = relPath.startsWith('journals/');
  const basename = path.basename(relPath, '.md');

  // hls__*.md PDF 标注文件走专门分支
  if (basename.startsWith('hls__')) {
    return preprocessAnnotationFile(rawContent, relPath);
  }

  const title = inferTitle(relPath, isJournal);
  const metadata: PageMetadata = {
    aliases: [],
    tags: [],
    pageRefs: [],
    blockRefAssociations: [],
    properties: {},
    isJournal,
    filePath: relPath,
  };

  let content = rawContent;

  // Step 1: 提取页面级 properties
  content = extractPageProperties(content, metadata);

  // Step 2: 处理 block 级 properties（系统属性删除，自定义属性提取到 metadata）
  content = extractBlockProperties(content, metadata);

  // Step 3: 移除 :LOGBOOK: 块，提取总耗时
  content = removeLogbook(content, metadata);

  // Step 4: 解析 [[page references]]
  content = resolvePageRefs(content, metadata);

  // Step 5: 解析 ((block references))
  content = resolveBlockRefs(content, metadata, graphRoot);

  // Step 6: 解析 #tag 和 #[[multi word tag]]
  content = resolveTags(content, metadata);

  // Step 7: 处理任务标记
  content = handleTaskMarkers(content);

  // Step 8: 处理 Logseq 宏（{{query}}, {{embed}} 等）
  content = handleLogseqMacros(content, metadata);

  // Step 9: 处理资源引用（图片、文件）
  content = handleAssetRefs(content);

  // Step 10: 去除 outliner `- ` 前缀（保留缩进）
  content = stripOutlinerPrefix(content);

  // Step 11: 清理（含 Hiccup 兜底）
  content = cleanUp(content);

  if (content.trim().length < 5) return null;

  return { title, cleanContent: content, metadata, rawContent };
}

// --- PDF 标注文件解析 ---

interface Annotation {
  text: string;
  page: number;
  isArea: boolean;
}

/**
 * 解析 hls__*.md PDF 标注文件
 *
 * 文件结构：
 * - 头部 properties：file-path::, file::, title::
 * - 文本标注：`- 高亮文本\n  ls-type:: annotation\n  hl-page:: N`
 * - 区域标注：`- [:span]\n  ls-type:: annotation\n  hl-type:: area` （无文本，跳过）
 */
function preprocessAnnotationFile(
  rawContent: string,
  relPath: string,
): (PreprocessedPage & { rawContent: string }) | null {
  const metadata: PageMetadata = {
    aliases: [],
    tags: [],
    pageRefs: [],
    blockRefAssociations: [],
    properties: {},
    isJournal: false,
    filePath: relPath,
  };

  const lines = rawContent.split('\n');

  // 提取源 PDF 文件名
  let sourcePdf = '';
  for (const line of lines) {
    const filePathMatch = line.match(/^file-path::\s*(.+)$/);
    if (filePathMatch) {
      // ../assets/讲给大家的中国历史1-6_1667967586558_0.pdf → 讲给大家的中国历史1-6.pdf
      const raw = filePathMatch[1].trim();
      sourcePdf = cleanAssetFilename(path.basename(raw));
      break;
    }
    const fileMatch = line.match(/^file::\s*\[([^\]]+)\]/);
    if (fileMatch && !sourcePdf) {
      sourcePdf = cleanAssetFilename(fileMatch[1]);
    }
  }

  if (sourcePdf) {
    metadata.properties['source_pdf'] = sourcePdf;
  }

  // 解析标注块
  const annotations: Annotation[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 查找列表项开头
    if (/^\s*- /.test(line)) {
      const blockText = line.replace(/^\s*- /, '').trim();

      // 收集后续属性行
      const props: Record<string, string> = {};
      let j = i + 1;
      while (j < lines.length) {
        const propMatch = lines[j].match(/^\s+([\w-]+)::\s*(.*)$/);
        if (propMatch) {
          props[propMatch[1]] = propMatch[2].trim();
          j++;
        } else if (lines[j].trim() === '') {
          j++;
        } else {
          break;
        }
      }

      // 只处理标注块（有 ls-type:: annotation）
      if (props['ls-type'] === 'annotation') {
        const isArea = props['hl-type'] === 'area';
        const page = parseInt(props['hl-page'] || '0', 10);

        if (!isArea && blockText && blockText !== '[:span]') {
          annotations.push({ text: blockText, page, isArea: false });
        }
        // 区域标注（[:span]）跳过，无可提取的文本
      }

      i = j;
    } else {
      i++;
    }
  }

  if (annotations.length === 0) return null;

  // 按页码分组输出
  const title = sourcePdf
    ? `PDF 标注: ${sourcePdf}`
    : `PDF 标注: ${path.basename(relPath, '.md').replace(/^hls__/, '')}`;

  const pageGroups = new Map<number, string[]>();
  for (const ann of annotations) {
    const group = pageGroups.get(ann.page) || [];
    group.push(ann.text);
    pageGroups.set(ann.page, group);
  }

  const contentParts: string[] = [];
  const sortedPages = [...pageGroups.keys()].sort((a, b) => a - b);
  for (const page of sortedPages) {
    const texts = pageGroups.get(page)!;
    if (texts.length === 1) {
      contentParts.push(`p.${page}: ${texts[0]}`);
    } else {
      contentParts.push(`p.${page}:\n${texts.join('\n')}`);
    }
  }

  const content = contentParts.join('\n\n');
  if (content.trim().length < 5) return null;

  // rawContent 为传入的（已归一化）原始文件内容，供调用方用同一 snapshot 算 hash
  return { title, cleanContent: content, metadata, rawContent };
}

/**
 * 清理 Logseq 资源文件名中的时间戳后缀
 * 例：讲给大家的中国历史1-6_1667967586558_0.pdf → 讲给大家的中国历史1-6.pdf
 */
function cleanAssetFilename(filename: string): string {
  // 匹配 _数字13位时间戳_序号.扩展名
  return filename.replace(/_\d{13}_\d+(\.\w+)$/, '$1');
}

// --- LOGBOOK 块移除 ---

/**
 * 移除 :LOGBOOK: ... :END: 块
 * 解析 CLOCK 行中的耗时并累加，存入 metadata.properties['time_spent']
 *
 * CLOCK 格式：CLOCK: [2022-03-04 Fri 10:44:23]--[2022-03-05 Sat 15:12:40] => 28:28:17
 */
function removeLogbook(content: string, metadata: PageMetadata): string {
  const logbookRegex = /^:LOGBOOK:\s*$([\s\S]*?)^:END:\s*$/gm;

  let totalSeconds = 0;
  let found = false;

  content = content.replace(logbookRegex, (_match, body: string) => {
    found = true;
    // 提取所有 CLOCK 行的耗时
    const clockRegex = /=>\s*(\d+):(\d{2}):(\d{2})/g;
    let clockMatch;
    while ((clockMatch = clockRegex.exec(body)) !== null) {
      const hours = parseInt(clockMatch[1], 10);
      const minutes = parseInt(clockMatch[2], 10);
      const seconds = parseInt(clockMatch[3], 10);
      totalSeconds += hours * 3600 + minutes * 60 + seconds;
    }
    return '';
  });

  if (found && totalSeconds > 0) {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    metadata.properties['time_spent'] =
      `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  return content;
}

// --- Logseq 宏处理 ---

/**
 * 处理 Logseq 宏语法：{{query}}, {{embed}} 等
 *
 * - {{query (property 类型 Book)}} → 解析查询意图，存入 metadata，从内容中移除
 * - {{embed ...}} → 移除（嵌入内容在预处理时不可展开）
 * - 其他 {{...}} → 移除
 */
function handleLogseqMacros(content: string, metadata: PageMetadata): string {
  // 处理 {{query ...}} — 提取查询意图
  content = content.replace(/\{\{query\s+(.*?)\}\}/g, (_match, queryExpr: string) => {
    const desc = parseQueryDescription(queryExpr.trim());
    if (desc) {
      // 多个 query 用分号分隔
      const existing = metadata.properties['query_desc'];
      metadata.properties['query_desc'] = existing ? `${existing}; ${desc}` : desc;
    }
    return '';
  });

  // 特定宏：保留 URL 或内容
  content = content.replace(/\{\{tweet\s+(https?:\/\/\S+)\}\}/g, '[推文: $1]');
  content = content.replace(/\{\{youtube\s+(https?:\/\/\S+)\}\}/g, '[视频: $1]');
  content = content.replace(/\{\{video\s+(https?:\/\/\S+)\}\}/g, '[视频: $1]');
  content = content.replace(/\{\{renderer\s+:linkpreview,\s*(https?:\/\/\S+)\}\}/g, '[链接: $1]');
  content = content.replace(/\{\{embed\s+\[\[([^\]]+)\]\]\}\}/g, '[嵌入: $1]');
  content = content.replace(/\{\{embed\s+\(\(([^)]+)\)\)\}\}/g, '[嵌入: $1]');
  content = content.replace(/\{\{cloze\s+(.+?)\}\}/g, '$1');

  // 移除其他 {{...}} 宏
  content = content.replace(/\{\{[^}]*\}\}/g, '');

  return content;
}

/**
 * 将 Logseq query 表达式解析为可读描述
 *
 * (property 类型 Book) → "查询: 类型=Book"
 * (and (property 类型 Book) (property 状态 已读)) → "查询: 类型=Book, 状态=已读"
 */
function parseQueryDescription(expr: string): string {
  const props: string[] = [];

  // 匹配 (property key value) 模式
  const propRegex = /\(property\s+(\S+)\s+(\S+)\)/g;
  let match;
  while ((match = propRegex.exec(expr)) !== null) {
    props.push(`${match[1]}=${match[2]}`);
  }

  if (props.length > 0) {
    return `查询: ${props.join(', ')}`;
  }

  // 无法解析的 query，返回原始表达式截断
  return `查询: ${expr.slice(0, 50)}`;
}

// --- 资源引用处理 ---

/**
 * 处理图片和文件引用，保留文件名去除路径
 *
 * ![alt](../assets/xxx_123456_0.png) → [图片: xxx.png]
 * ![alt](../assets/xxx.pdf) → [文件: xxx.pdf]
 * [filename.pdf](../assets/xxx.pdf) → [文件: filename.pdf]
 */
function handleAssetRefs(content: string): string {
  // 图片引用 ![alt](path)
  content = content.replace(
    /!\[[^\]]*\]\(([^)]+)\)/g,
    (_match, url: string) => {
      const filename = cleanAssetFilename(path.basename(url));
      const ext = path.extname(filename).toLowerCase();
      const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'].includes(ext);
      return isImage ? `[图片: ${filename}]` : `[文件: ${filename}]`;
    },
  );

  // 链接引用 [text](../assets/path) — 仅处理 assets 路径
  content = content.replace(
    /\[([^\]]+)\]\((\.\.\/assets\/[^)]+)\)/g,
    (_match, text: string, _url: string) => {
      const filename = cleanAssetFilename(text);
      return `[文件: ${filename}]`;
    },
  );

  return content;
}

// --- 各处理步骤 ---

/**
 * 提取文件头部的页面级 properties（在第一个 `- ` 之前）
 */
function extractPageProperties(content: string, metadata: PageMetadata): string {
  const lines = content.split('\n');
  const propertyLines: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;

    // 第一个 `- ` 开头的行标志着 block 内容开始
    if (line.startsWith('- ')) {
      break;
    }

    const propMatch = line.match(/^([\w][\w-]*)::\s*(.*)$/);
    if (propMatch) {
      const [, key, value] = propMatch;
      const lowerKey = key.toLowerCase();

      // 提取时间戳 epoch（在过滤系统属性之前）
      if (lowerKey === 'created-at' && value.trim()) {
        metadata.properties['_created_at_epoch'] = value.trim();
      }
      if (lowerKey === 'updated-at' && value.trim()) {
        metadata.properties['_updated_at_epoch'] = value.trim();
      }

      if (lowerKey === 'alias' || lowerKey === 'aliases') {
        metadata.aliases = value.split(',').map(s => s.trim()).filter(Boolean);
      } else if (lowerKey === 'tags') {
        metadata.tags = value
          .split(/[,\s]+/)
          .map(s => s.replace(/^#/, '').trim())
          .filter(Boolean);
      } else if (!SYSTEM_PROPERTIES.includes(lowerKey)) {
        metadata.properties[key] = value;
      }
      propertyLines.push(i);
    } else {
      // 非 property 行且非空，停止查找
      break;
    }
  }

  // 移除 property 行
  if (propertyLines.length > 0) {
    const result = lines.filter((_, i) => !propertyLines.includes(i));
    return result.join('\n');
  }
  return content;
}

/**
 * 处理 block 级 properties
 *
 * - 系统属性（id::, collapsed:: 等）：直接删除
 * - 自定义属性（rating::, source:: 等）：提取到 metadata.properties，从内容中移除
 *
 * 这样自定义属性作为结构化元数据保留，不以 `key:: value` 原始格式留在内容中干扰 LLM。
 */
function extractBlockProperties(content: string, metadata: PageMetadata): string {
  // 必须跳过代码块内的 `key:: value` 形式 —— 用户在 fenced code 里贴 Logseq 配置
  // 示例(如 `tags:: example`)会被误识别成 block property,污染 metadata.properties +
  // tag promotion 链。复用 resolvePageRefs 的 codeLines 思路。
  const codeLines = codeRegionsToLineSet(content, findCodeRegions(content));
  const handler = (_match: string, _indent: string, key: string, value: string) => {
    const lowerKey = key.toLowerCase();

    // 提取时间戳 epoch（在过滤系统属性之前）
    if (lowerKey === 'created-at' && value.trim()) {
      metadata.properties['_created_at_epoch'] = value.trim();
    }
    if (lowerKey === 'updated-at' && value.trim()) {
      metadata.properties['_updated_at_epoch'] = value.trim();
    }

    // 系统属性：直接删除
    if (SYSTEM_PROPERTIES.includes(lowerKey)) {
      return '';
    }

    // 页面级已处理的特殊属性（alias/tags），跳过重复提取
    if (lowerKey === 'alias' || lowerKey === 'aliases' || lowerKey === 'tags') {
      return '';
    }

    // 自定义属性：提取到 metadata，不重复写入
    const trimmedValue = value.trim();
    if (trimmedValue) {
      // 同 key 多次出现时用逗号拼接
      if (metadata.properties[key]) {
        metadata.properties[key] += `, ${trimmedValue}`;
      } else {
        metadata.properties[key] = trimmedValue;
      }
    }

    return '';
  };

  const lineRe = /^([ \t]*)([\w][\w-]*):: (.*)$/;
  if (codeLines.size === 0) {
    return content.replace(/^([ \t]*)([\w][\w-]*):: (.*)$/gm, handler);
  }
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (codeLines.has(i)) continue;
    const m = lineRe.exec(lines[i]);
    if (m) lines[i] = handler(m[0], m[1], m[2], m[3]);
  }
  return lines.join('\n');
}

/**
 * 收集 [[page references]] 到 metadata，保留原文中的 [[]] 标记
 * 跳过代码块内的内容
 */
function resolvePageRefs(content: string, metadata: PageMetadata): string {
  const collect = (_match: string, pageName: string) => {
    if (!metadata.pageRefs.includes(pageName)) {
      metadata.pageRefs.push(pageName);
    }
    return _match; // 保留 [[]] 原文
  };

  const codeLines = codeRegionsToLineSet(content, findCodeRegions(content));
  if (codeLines.size === 0) {
    return content.replace(/\[\[([^\]]+)\]\]/g, collect);
  }

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (codeLines.has(i)) continue;
    lines[i] = lines[i].replace(/\[\[([^\]]+)\]\]/g, collect);
  }
  return lines.join('\n');
}

/**
 * 解析 ((block-uuid)) → 查找索引替换为实际内容
 *
 * 按 graphRoot 隔离查询，避免多 graph 之间的 UUID 串库。
 */
function resolveBlockRefs(content: string, metadata: PageMetadata, graphRoot: string): string {
  return content.replace(
    /\(\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)\)/g,
    (_match, uuid: string) => {
      const resolved = lookupBlock(uuid, graphRoot);
      if (resolved) {
        metadata.blockRefAssociations.push({
          refId: uuid,
          resolvedContent: resolved,
        });
        return `[引用: ${resolved}]`;
      }
      // 未找到，移除无意义的 UUID
      return '[引用: 未知]';
    },
  );
}

/**
 * 收集 #tag 和 #[[multi word tag]] 到 metadata，保留原文中的 # 标记
 */
function resolveTags(content: string, metadata: PageMetadata): string {
  // #[[multi word tag]] — 提取标签，保留原文
  content = content.replace(/#\[\[([^\]]+)\]\]/g, (_match, tag: string) => {
    if (!metadata.tags.includes(tag)) {
      metadata.tags.push(tag);
    }
    return _match; // 保留 #[[]] 原文
  });

  // #single-word-tag（排除 markdown 标题 ## ）
  content = content.replace(/(?<!\w)#([\w\u4e00-\u9fff][\w\u4e00-\u9fff/-]*)/g, (_match, tag: string) => {
    // 排除纯数字（如 #1, #123）
    if (/^\d+$/.test(tag)) return _match;
    if (!metadata.tags.includes(tag)) {
      metadata.tags.push(tag);
    }
    return _match; // 保留 #tag 原文
  });

  return content;
}

/**
 * 处理任务标记
 */
function handleTaskMarkers(content: string): string {
  return content.replace(
    /^(\s*- )(TODO|DOING|DONE|LATER|NOW|WAITING|CANCELLED|CANCELED)\s+/gm,
    (_match, prefix: string, marker: string) => {
      const isDone = marker === 'DONE' || marker === 'CANCELLED' || marker === 'CANCELED';
      const isDoing = marker === 'DOING';
      if (isDone) return `${prefix}[已完成] `;
      if (isDoing) return `${prefix}[进行中] `;
      return `${prefix}`;
    },
  );
}

/**
 * 保留 outliner `- ` 前缀和缩进信息
 * Logseq 的大纲结构（`- ` + 缩进）是内容层级的骨架，去掉会丢失结构语义
 *
 * 此函数现在是 no-op，保留函数签名以维持管线接口一致性
 */
function stripOutlinerPrefix(content: string): string {
  return content;
}

/**
 * 最终清理
 */
function cleanUp(content: string): string {
  return content
    // ^^highlight^^ → 纯文本
    .replace(/\^\^([^^]+)\^\^/g, '$1')
    // [#A] [#B] [#C] 优先级标记
    .replace(/\[#([ABC])\]/g, '[优先级$1]')
    // Hiccup 语法兜底：[:span], [:div ...] 等 ClojureScript 标记
    .replace(/\[:\w+[^\]\n]*\]/g, '')
    // 移除连续空行（保留单个）
    .replace(/\n{3,}/g, '\n\n')
    // 移除行尾空白
    .replace(/[ \t]+$/gm, '')
    // 移除开头空行
    .replace(/^\n+/, '')
    // 移除结尾空行
    .replace(/\n+$/, '');
}

// --- 代码块保护 ---

/**
 * 把代码块/行内代码替换成等长空格,保持字符偏移不变。
 * classifier.ts 等需要在 raw content 上跑 regex(如 [[wikilink]] 计数)
 * 但又要跳过代码块的场景使用——避免引入 preprocessor 的全套开销。
 *
 * 历史 bug(2026-05-09):classifier.ts:111 / :195 直接对原文 regex,代码示例
 * 中的 `[[name]]` 被算成引用 → refCount 虚高 → 内容页被误判 index_page;
 * inDegree 也虚高,影响初始 heat。
 */
export function stripCodeForScan(content: string): string {
  const regions = findCodeRegions(content);
  if (regions.length === 0) {
    // 无 fenced block,但仍要处理行内 ` ... `
    return content.replace(/`[^`\n]*`/g, m => ' '.repeat(m.length));
  }
  // 用空格替换 fenced 区域,再处理行内 backtick
  let out = '';
  let cursor = 0;
  for (const [start, end] of regions) {
    out += content.slice(cursor, start);
    out += ' '.repeat(end - start);
    cursor = end;
  }
  out += content.slice(cursor);
  return out.replace(/`[^`\n]*`/g, m => ' '.repeat(m.length));
}

/**
 * 查找所有 fenced code block 区域（``` 或 ~~~）的字符位置范围
 * 未闭合的 fence 不算代码块
 */
function findCodeRegions(content: string): Array<[number, number]> {
  const regions: Array<[number, number]> = [];
  // fence 必须同字符配对：``` 只能被 ``` 关闭，~~~ 只能被 ~~~ 关闭。
  // 跨类型 fence 否则会吃掉中间的 [[wikilinks]] / ((refs))。
  // 与 obsidian preprocessor 的 markCodeRegions 保持一致的追踪模式。
  const lines = content.split('\n');
  let inFence = false;
  let fenceChar = '';
  let fenceStart = 0;
  let charOffset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inFence) {
      const openMatch = line.match(/^(\s*)(```|~~~)/);
      if (openMatch) {
        inFence = true;
        fenceChar = openMatch[2];
        fenceStart = charOffset;
      }
    } else {
      const closeMatch = line.match(/^(\s*)(```|~~~)\s*$/);
      if (closeMatch && closeMatch[2] === fenceChar) {
        regions.push([fenceStart, charOffset + line.length]);
        inFence = false;
        fenceChar = '';
      }
    }
    charOffset += line.length + 1; // +1 for \n
  }
  // 未闭合的 fence 不作为代码块
  return regions;
}

/**
 * 将字符位置范围转换为行号集合（0-based）
 */
function codeRegionsToLineSet(content: string, regions: Array<[number, number]>): Set<number> {
  if (regions.length === 0) return new Set();

  const lineSet = new Set<number>();
  // 构建行起始偏移表
  const lineStarts: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') {
      lineStarts.push(i + 1);
    }
  }

  for (const [start, end] of regions) {
    // 找到 start 所在行
    let startLine = 0;
    for (let i = lineStarts.length - 1; i >= 0; i--) {
      if (lineStarts[i] <= start) { startLine = i; break; }
    }
    // 找到 end 所在行
    let endLine = startLine;
    for (let i = lineStarts.length - 1; i >= 0; i--) {
      if (lineStarts[i] <= end) { endLine = i; break; }
    }
    for (let l = startLine; l <= endLine; l++) {
      lineSet.add(l);
    }
  }
  return lineSet;
}

// --- 工具函数 ---

/**
 * 从文件路径推断标题
 */
function inferTitle(relPath: string, isJournal: boolean): string {
  const basename = path.basename(relPath, '.md');

  if (isJournal) {
    // journals/2024_01_15.md → 2024-01-15
    // journals/2024-01-15.md → 2024-01-15
    return basename.replace(/_/g, '-');
  }

  // pages/some%2Ftopic.md → some/topic
  // pages/namespace___topic.md → namespace/topic
  // pages/topic.md → topic
  try {
    return decodeURIComponent(basename.replace(/___/g, '/').replace(/%2F/gi, '/'));
  } catch {
    // decodeURIComponent 抛错（URI malformed）时保留 ___ → / 的替换，
    // 避免把 namespace 塞进标题里。
    return basename.replace(/___/g, '/');
  }
}
