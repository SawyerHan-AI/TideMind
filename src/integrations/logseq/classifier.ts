// ============================================================
// Phase 0: 内容分类器
//
// 对 Logseq 文件做初步分类，决定处理路径。
// ============================================================

import path from 'node:path';
import { createLogger } from '../../utils/logger.js';
import { safeReadTextFileSync, safeStatSync } from '../../utils/safe-fs.js';
import { stripCodeForScan } from './preprocessor.js';
import { parseJournalDate, extractJournalDateLoose } from './journal-date.js';

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

    const stat = safeStatSync(filePath);
    if (!stat) {
      log.warn(`文件 stat 失败，跳过: ${filePath}`);
      continue;
    }
    const fileSize = stat.size;
    const readRes = safeReadTextFileSync(filePath);
    if (!readRes.ok) {
      // dataless / stub / missing / error 都跳过，不触发 iCloud 下载
      log.warn(`文件读取跳过 (${readRes.reason}): ${filePath}`);
      continue;
    }
    const content = readRes.content;

    // 判断是否日记
    // 支持 YYYY-MM-DD / YYYY_MM_DD / YYYYMMDD 三种默认格式。
    // 自定义 `:journal/file-name-format`（如 yyyy_MM_dd_EEEE）需用户把文件
    // 放到 journals/ 目录下才会被识别。
    // 与 preprocessor.ts / queue.ts 共用 parseJournalDate(含 month/day 范围校验,防 20229999 这类纯数字
    // ID 误判 journal → created='2022-99-99' → NaN heat 僵尸节点)。journals/ 目录下自定义命名走下方宽松提取。
    const stdJournalDate = parseJournalDate(fileName);
    const isJournal = relPath.startsWith('journals/') || stdJournalDate !== null;

    // 提取标题
    // decodeURIComponent 在文件名含未配对的 % 时（如 100%cotton.md）会抛 URIError，
    // 不捕获会冒泡终止 Phase 0 分类循环、导致整个 Logseq 导入中断。
    // 与 preprocessor.ts:818-824 保持同样的兜底策略。
    let decodedTitle: string;
    if (isJournal) {
      decodedTitle = stdJournalDate ?? fileName.replace(/_/g, '-');
    } else {
      const replaced = fileName.replace(/___/g, '/');
      try {
        decodedTitle = decodeURIComponent(replaced);
      } catch (err) {
        log.debug(`logseq-classifier-decode-failed: fileName=${fileName} err=${err instanceof Error ? err.message : String(err)}`);
        decodedTitle = replaced;
      }
    }
    const title = decodedTitle;

    // 计算引用数:必须跳代码块,否则用户笔记里的 Markdown 示例(代码围栏内
     // 含 `[[name]]`)会被算成引用,refCount 虚高 → 内容页被误判 index_page,
     // 进而被 Phase 3 跳过显式链接(initialization.ts:626)。
    const scanContent = stripCodeForScan(content);
    const refCount = (scanContent.match(/\[\[([^\]]+)\]\]/g) || []).length;

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
    let journalDate: string | undefined = stdJournalDate ?? undefined;
    if (isJournal && !journalDate) {
      // journals/ 目录下非标准命名(自定义格式如 2022_02_17_Thursday)→ 宽松提取内嵌日期(带 month/day 范围校验)。
      // 与增量 queue.inferJournalDate 共用 extractJournalDateLoose,保证 created/heat 一致 + 不产 NaN heat(第三轮审计 HIGH)。
      journalDate = extractJournalDateLoose(fileName) ?? undefined;
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
    const rawContent = readContent(file.filePath);
    if (!rawContent) continue;
    // 同 refCount,跳过代码块/行内代码避免示例内的 [[name]] 污染入度统计
    const content = stripCodeForScan(rawContent);

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
