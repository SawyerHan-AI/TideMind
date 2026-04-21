// ============================================================
// Phase 0: 内容分类器
//
// 对 Logseq 文件做初步分类，决定处理路径。
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('logseq-classifier');

export type PageCategory =
  | 'empty_tag'       // 空白/占位页 → tag 节点
  | 'short_definition' // 极短定义页 < 200 字节
  | 'index_page'       // 排行/索引页（纯列表，大量引用）
  | 'pdf_annotation'   // PDF 注释页（hls__ 前缀）
  | 'journal'          // 日记
  | 'normal'           // 普通内容页
  ;

export interface ClassifiedFile {
  filePath: string;
  relPath: string;
  category: PageCategory;
  title: string;
  fileSize: number;
  /** 日记的日期（YYYY-MM-DD），从文件名推断 */
  journalDate?: string;
  /** 页面引用数（用于判断索引页） */
  refCount: number;
}

export interface ClassificationResult {
  files: ClassifiedFile[];
  summary: {
    total: number;
    byCategory: Record<PageCategory, number>;
  };
}

const INDEX_PAGE_REF_THRESHOLD = 30; // 引用数超过此值视为索引页
const SHORT_PAGE_THRESHOLD = 200;    // 字节数低于此值视为极短页
const EMPTY_PAGE_THRESHOLD = 2;      // 字节数低于此值视为空白页

/**
 * 分类所有 Logseq 文件
 */
export function classifyFiles(
  filePaths: string[],
  graphRoot: string,
): ClassificationResult {
  const files: ClassifiedFile[] = [];
  const byCategory: Record<PageCategory, number> = {
    empty_tag: 0,
    short_definition: 0,
    index_page: 0,
    pdf_annotation: 0,
    journal: 0,
    normal: 0,
  };

  for (const filePath of filePaths) {
    const relPath = path.relative(graphRoot, filePath).replace(/\\/g, '/');
    const fileName = path.basename(filePath, '.md');

    let content: string;
    let fileSize: number;
    try {
      const stat = fs.statSync(filePath);
      fileSize = stat.size;
      content = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      log.warn(`文件读取失败，跳过: ${filePath} — ${(err as Error).message}`);
      continue;
    }

    // 判断是否日记
    // 支持 YYYY-MM-DD / YYYY_MM_DD / YYYYMMDD 三种默认格式。
    // 自定义 `:journal/file-name-format`（如 yyyy_MM_dd_EEEE）需用户把文件
    // 放到 journals/ 目录下才会被识别。
    const journalMatch =
      fileName.match(/^(\d{4})[-_](\d{2})[-_](\d{2})$/) ||
      fileName.match(/^(\d{4})(\d{2})(\d{2})$/);
    const isJournal = relPath.startsWith('journals/') || !!journalMatch;

    // 提取标题
    const title = isJournal
      ? (journalMatch
          ? `${journalMatch[1]}-${journalMatch[2]}-${journalMatch[3]}`
          : fileName.replace(/_/g, '-'))
      : decodeURIComponent(fileName.replace(/___/g, '/'));

    // 计算引用数
    const refCount = (content.match(/\[\[([^\]]+)\]\]/g) || []).length;

    // 分类
    let category: PageCategory;

    if (isJournal) {
      category = 'journal';
    } else if (relPath.includes('hls__')) {
      category = 'pdf_annotation';
    } else if (fileSize <= EMPTY_PAGE_THRESHOLD) {
      category = 'empty_tag';
    } else if (fileSize < SHORT_PAGE_THRESHOLD) {
      // 极短页：检查是否是纯定义（一行内容）
      const lines = content.trim().split('\n').filter(l => l.trim().length > 0);
      if (lines.length <= 2) {
        category = 'short_definition';
      } else {
        category = 'normal';
      }
    } else if (refCount >= INDEX_PAGE_REF_THRESHOLD) {
      category = 'index_page';
    } else {
      category = 'normal';
    }

    // 提取日记日期
    let journalDate: string | undefined;
    if (isJournal && journalMatch) {
      journalDate = `${journalMatch[1]}-${journalMatch[2]}-${journalMatch[3]}`;
    } else if (isJournal) {
      // 尝试从文件名提取日期
      const dateMatch = fileName.match(/(\d{4})[-_](\d{2})[-_](\d{2})/);
      if (dateMatch) {
        journalDate = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
      }
    }

    files.push({
      filePath,
      relPath,
      category,
      title,
      fileSize,
      journalDate,
      refCount,
    });

    byCategory[category]++;
  }

  log.info(`分类完成: ${files.length} 个文件 — ${Object.entries(byCategory).map(([k, v]) => `${k}:${v}`).join(', ')}`);

  return {
    files,
    summary: {
      total: files.length,
      byCategory,
    },
  };
}

/**
 * 统计每个页面的入度（被多少其他文件 [[引用]]）
 *
 * 遍历所有文件内容提取 [[引用]]，统计每个 title 被引用次数。
 * 自引用不计入。
 *
 * @param files classifyFiles 的输出
 * @param readContent 读取文件内容的函数（支持缓存）
 * @returns Map<title, inDegree>
 */
export function buildInDegreeMap(
  files: ClassifiedFile[],
  readContent: (filePath: string) => string | null,
): Map<string, number> {
  const titleSet = new Set(files.map(f => f.title));
  const inDegree = new Map<string, number>();

  for (const file of files) {
    const content = readContent(file.filePath);
    if (!content) continue;

    // 去重：同一文件内多次引用同一页面只计 1 次
    const seen = new Set<string>();
    for (const match of content.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const refTitle = match[1];
      if (refTitle === file.title) continue; // 跳过自引用
      if (seen.has(refTitle)) continue;
      seen.add(refTitle);

      if (titleSet.has(refTitle)) {
        inDegree.set(refTitle, (inDegree.get(refTitle) ?? 0) + 1);
      }
    }
  }

  log.info(`入度统计: ${inDegree.size} 个页面有入度 (max=${Math.max(0, ...inDegree.values())})`);
  return inDegree;
}
