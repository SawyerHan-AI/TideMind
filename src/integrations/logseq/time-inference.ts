// ============================================================
// 时间推断（六层策略链）
//
// 为 Logseq 页面推断创建日期和最后活跃日期。
// 覆盖率约 98.6%（基于 981 页面 + 1289 日记的真实数据验证）。
//
// 策略链：
//   1. 日记文件名（精确日期）
//   2. 日记 [[引用]]（首次/末次引用日期）
//   3. 页面间 [[引用]] BFS 传播
//   4. 标题关键词全文搜索（日记 + 页面正文）
//   5. 出度页面时间推断
//   5.5. 重复页继承（带 " 2" 后缀）
//   6. 中位数兜底
// ============================================================

import type { ClassifiedFile } from './classifier.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('logseq-time');

// --- 类型定义 ---

export type TimeSource =
  | 'journal_name'
  | 'hls_timestamp'
  | 'journal_ref'
  | 'page_ref_chain'
  | 'keyword_search'
  | 'outdegree'
  | 'duplicate_inherit'
  | 'fallback';

export interface InferredDateInfo {
  /** 推断的创建日期（YYYY-MM-DD） */
  date: string;
  /** 推断来源 */
  source: TimeSource;
  /** 首次被引用日期（仅 journal_ref / keyword_search） */
  firstRef?: string;
  /** 末次被引用日期（用于 T_effective 计算） */
  lastRef?: string;
}

export type InferredDates = Map<string, InferredDateInfo>;

/** [[引用]] 提取正则 */
const REF_PATTERN = /\[\[([^\]]+)\]\]/g;

// --- 主函数 ---

/**
 * 为页面推断创建日期（六层策略链）
 *
 * @param files classifyFiles 的输出
 * @param readContent 读取文件内容的函数（支持缓存）
 * @returns Map<title, InferredDateInfo>
 */
export function inferPageDates(
  files: ClassifiedFile[],
  readContent: (filePath: string) => string | null,
): InferredDates {
  const result: InferredDates = new Map();

  const journals = files
    .filter(f => f.category === 'journal' && f.journalDate)
    .sort((a, b) => a.journalDate!.localeCompare(b.journalDate!));
  const pages = files.filter(f => f.category !== 'journal');

  // 缓存日记内容（层 2 和层 4 都要用）
  const journalContentCache = new Map<string, string>();
  for (const j of journals) {
    const content = readContent(j.filePath);
    if (content) journalContentCache.set(j.filePath, content);
  }

  // 缓存页面内容（层 3、4、5 都要用）
  const pageContentCache = new Map<string, string>();
  for (const p of pages) {
    const content = readContent(p.filePath);
    if (content) pageContentCache.set(p.filePath, content);
  }

  // --- 层 1：日记文件名 ---
  for (const j of journals) {
    result.set(j.title, {
      date: j.journalDate!,
      source: 'journal_name',
    });
  }

  // --- 层 1.5：PDF 注释文件名时间戳 ---
  for (const p of pages) {
    if (p.category !== 'pdf_annotation') continue;
    if (result.has(p.title)) continue;
    // 提取 hls__xxx_1667967586558_0 中的 Unix 毫秒时间戳
    const tsMatch = p.title.match(/_(\d{13})_/);
    if (tsMatch) {
      const date = new Date(parseInt(tsMatch[1], 10)).toISOString().slice(0, 10);
      result.set(p.title, { date, source: 'hls_timestamp' });
    }
  }

  // --- 层 2：日记 [[引用]] ---
  const pageFirstRef = new Map<string, string>();
  const pageLastRef = new Map<string, string>();

  for (const journal of journals) {
    const content = journalContentCache.get(journal.filePath);
    if (!content) continue;

    for (const match of content.matchAll(REF_PATTERN)) {
      const refTitle = match[1];
      if (!pageFirstRef.has(refTitle)) {
        pageFirstRef.set(refTitle, journal.journalDate!);
      }
      pageLastRef.set(refTitle, journal.journalDate!);
    }
  }

  for (const [title, firstDate] of pageFirstRef) {
    if (!result.has(title)) {
      result.set(title, {
        date: firstDate,
        source: 'journal_ref',
        firstRef: firstDate,
        lastRef: pageLastRef.get(title),
      });
    }
  }

  // --- 层 3：页面间 [[引用]] 链 BFS 传播 ---
  // 构建页面引用图（谁引用了谁 → incoming）
  const incomingRefs = new Map<string, Set<string>>(); // title → set of titles that reference it
  const outgoingRefs = new Map<string, Set<string>>(); // title → set of titles it references

  for (const p of pages) {
    const content = pageContentCache.get(p.filePath);
    if (!content) continue;
    const refs = new Set<string>();
    for (const match of content.matchAll(REF_PATTERN)) {
      const refTitle = match[1];
      if (refTitle !== p.title) {
        refs.add(refTitle);
        if (!incomingRefs.has(refTitle)) incomingRefs.set(refTitle, new Set());
        incomingRefs.get(refTitle)!.add(p.title);
      }
    }
    outgoingRefs.set(p.title, refs);
  }

  // BFS：从有日期的页面向引用它的页面传播，最多 2 跳
  for (let hop = 0; hop < 2; hop++) {
    let changed = false;
    for (const [title, referencedBy] of incomingRefs) {
      if (result.has(title)) continue;
      // 找引用我的页面中有日期的
      for (const refBy of referencedBy) {
        const refInfo = result.get(refBy);
        if (refInfo) {
          result.set(title, { date: refInfo.date, source: 'page_ref_chain' });
          changed = true;
          break;
        }
      }
    }
    if (!changed) break;
  }

  // --- 层 4：标题关键词全文搜索 ---
  // 4a: 搜日记正文
  let orphans = pages.filter(p => !result.has(p.title));
  for (const orphan of orphans) {
    const titleLower = orphan.title.toLowerCase();
    let firstDate: string | undefined;
    let lastDate: string | undefined;

    for (const journal of journals) {
      const content = journalContentCache.get(journal.filePath);
      if (!content) continue;
      if (content.toLowerCase().includes(titleLower)) {
        if (!firstDate) firstDate = journal.journalDate!;
        lastDate = journal.journalDate!;
      }
    }

    if (firstDate) {
      result.set(orphan.title, {
        date: firstDate,
        source: 'keyword_search',
        firstRef: firstDate,
        lastRef: lastDate,
      });
    }
  }

  // 4b: 搜页面正文
  orphans = pages.filter(p => !result.has(p.title));
  for (const orphan of orphans) {
    const titleLower = orphan.title.toLowerCase();

    for (const p of pages) {
      if (p.title === orphan.title) continue;
      const content = pageContentCache.get(p.filePath);
      if (!content) continue;
      if (content.toLowerCase().includes(titleLower)) {
        const refInfo = result.get(p.title);
        if (refInfo) {
          result.set(orphan.title, { date: refInfo.date, source: 'keyword_search' });
          break;
        }
      }
    }
  }

  // --- 层 5：出度页面时间推断 ---
  orphans = pages.filter(p => !result.has(p.title));
  for (const orphan of orphans) {
    const refs = outgoingRefs.get(orphan.title);
    if (!refs || refs.size === 0) continue;

    let earliest: string | undefined;
    let latest: string | undefined;
    for (const ref of refs) {
      const refInfo = result.get(ref);
      if (refInfo) {
        if (!earliest || refInfo.date < earliest) earliest = refInfo.date;
        const refLast = refInfo.lastRef ?? refInfo.date;
        if (!latest || refLast > latest) latest = refLast;
      }
    }

    if (earliest) {
      result.set(orphan.title, {
        date: earliest,
        source: 'outdegree',
        lastRef: latest,
      });
    }
  }

  // --- 层 5.5：重复页继承 ---
  // Logseq 把重复页重命名为 "title 2"、"title 3" ...。匹配 ` \d+$` 时
  // 必须再验证 originalTitle 真的是一个 canonical 页（pages 中存在），
  // 否则用户正常叫 "Chapter 2" 的笔记会被错误继承为 "Chapter" 的日期。
  const canonicalTitleSet = new Set(pages.map(p => p.title));
  orphans = pages.filter(p => !result.has(p.title));
  for (const orphan of orphans) {
    const m = orphan.title.match(/^(.+?) \d+$/);
    if (!m) continue;
    const originalTitle = m[1];
    if (!canonicalTitleSet.has(originalTitle)) continue; // originalTitle 必须存在
    const originalInfo = result.get(originalTitle);
    if (originalInfo) {
      result.set(orphan.title, {
        date: originalInfo.date,
        source: 'duplicate_inherit',
        lastRef: originalInfo.lastRef,
      });
    }
  }

  // --- 层 6：兜底（中位数日期） ---
  orphans = pages.filter(p => !result.has(p.title));
  if (orphans.length > 0) {
    const allDates = [...result.values()]
      .map(v => v.date)
      .filter(d => d !== undefined)
      .sort();
    const medianDate = allDates.length > 0
      ? allDates[Math.floor(allDates.length / 2)]
      : new Date().toISOString().slice(0, 10);

    for (const orphan of orphans) {
      result.set(orphan.title, { date: medianDate, source: 'fallback' });
    }
  }

  // --- 日志统计 ---
  const sourceCoverage: Record<TimeSource, number> = {
    journal_name: 0,
    hls_timestamp: 0,
    journal_ref: 0,
    page_ref_chain: 0,
    keyword_search: 0,
    outdegree: 0,
    duplicate_inherit: 0,
    fallback: 0,
  };
  for (const info of result.values()) {
    sourceCoverage[info.source]++;
  }
  const totalPages = pages.length;
  const coveredPages = totalPages > 0
    ? totalPages - sourceCoverage.fallback
    : 0;
  const coveragePct = totalPages > 0 ? Math.round((coveredPages / totalPages) * 100) : 0;
  log.info(`时间推断: ${coveredPages}/${totalPages} 页面有推断日期 (${coveragePct}%)`);
  log.info(`各层覆盖: ${JSON.stringify(sourceCoverage)}`);

  return result;
}

// --- 排序 ---

/**
 * 对文件列表按时间排序
 */
export function sortByTime(
  files: ClassifiedFile[],
  inferredDates: InferredDates,
): ClassifiedFile[] {
  return [...files].sort((a, b) => {
    const dateA = getEffectiveDate(a, inferredDates);
    const dateB = getEffectiveDate(b, inferredDates);

    if (dateA && !dateB) return -1;
    if (!dateA && dateB) return 1;
    if (!dateA && !dateB) return 0;

    return dateA!.localeCompare(dateB!);
  });
}

/**
 * 获取文件的有效日期（用于排序）
 */
export function getEffectiveDate(
  file: ClassifiedFile,
  inferredDates: InferredDates,
): string | null {
  if (file.journalDate) return file.journalDate;
  const info = inferredDates.get(file.title);
  if (!info) return null;
  // T_effective = max(date, lastRef)
  if (info.lastRef && info.lastRef > info.date) return info.lastRef;
  return info.date;
}
