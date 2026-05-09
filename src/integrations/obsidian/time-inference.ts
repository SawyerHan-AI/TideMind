// ============================================================
// Obsidian 时间推断（五层策略链）
//
// 为 Obsidian vault 文件推断创建日期。
// 相比 Logseq，Obsidian 有更可靠的时间数据来源（frontmatter、fs birthtime），
// 因此策略链更简洁。
//
// 策略链：
//   1. Frontmatter 日期字段（date/created/modified 等）
//   2. Daily Note 文件名（按 vault 配置的日期格式解析）
//   3. 文件系统 birthtime（macOS/Windows 可靠）
//   4. 文件系统 mtime（修改时间兜底）
//   5. 中位数兜底
// ============================================================

import fs from 'node:fs';
import type { ClassifiedFile, ObsidianVaultConfig } from './types.js';
import { DATE_FIELD_PRIORITY } from './types.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('obsidian:time');

// --- 类型定义 ---

export interface InferredDateInfo {
  /** 推断的创建日期（YYYY-MM-DD） */
  date: string;
  /** 推断来源 */
  source: string;
  /** 置信度 0-1 */
  confidence: number;
}

// --- Frontmatter 解析 ---

/** Templater 占位符，跳过不解析 */
const TEMPLATER_PATTERN = /<%.*%>/;

/** ISO 日期格式：2024-06-15 或带时间 */
const ISO_DATE_PATTERN = /^(\d{4}-\d{2}-\d{2})/;

/**
 * 解析自然语言日期字符串为 YYYY-MM-DD
 *
 * 支持格式：
 * - "Friday, December 9th 2022, 1:37:28 am"
 * - "September 7th 2021"
 * - "2024-04-02"
 * - "2024-06-15 00:00"
 */
function parseNaturalDate(value: string): string | null {
  if (!value || typeof value !== 'string') return null;

  const trimmed = value.trim();

  // 跳过 Templater 占位符
  if (TEMPLATER_PATTERN.test(trimmed)) return null;

  // ISO 格式优先匹配
  const isoMatch = trimmed.match(ISO_DATE_PATTERN);
  if (isoMatch) return isoMatch[1];

  // 自然语言格式：提取月份、日、年
  const MONTHS: Record<string, string> = {
    january: '01', february: '02', march: '03', april: '04',
    may: '05', june: '06', july: '07', august: '08',
    september: '09', october: '10', november: '11', december: '12',
  };

  // "December 9th 2022" 或 "Friday, December 9th 2022, 1:37:28 am"
  const naturalMatch = trimmed.match(
    /(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{4})/i,
  );
  if (naturalMatch) {
    const month = MONTHS[naturalMatch[1].toLowerCase()];
    if (month) {
      const day = naturalMatch[2].padStart(2, '0');
      return `${naturalMatch[3]}-${month}-${day}`;
    }
  }

  return null;
}

/**
 * 从文件内容的 frontmatter 中提取日期
 *
 * 修复 M17(2026-05-09):原 indexOf('\n---', 3) 子串搜索会被 YAML block-scalar
 * 值里字面的 \n--- 误命中,frontmatter 被截短 → 日期推断回退到 birthtime/mtime,
 * 不可靠但不报错。改用 frontmatter.ts::findFrontmatterTerminatorLine 行扫描,
 * 与 extractFrontmatter 行为完全一致。
 */
function extractFrontmatterDate(content: string): string | null {
  // 统一换行：CRLF 文件的 '\r\n---' 会让 indexOf('\n---') 匹配到错误位置
  const normalized = content.replace(/\r\n/g, '\n');

  // 检查是否有 YAML frontmatter
  if (!normalized.startsWith('---')) return null;

  const lines = normalized.split('\n');
  // 行扫描找结束行(整行仅 ---,允许尾随空白)
  let terminatorLine = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i])) { terminatorLine = i; break; }
  }
  if (terminatorLine === -1) return null;

  const frontmatter = lines.slice(1, terminatorLine).join('\n');

  // 按优先级遍历日期字段
  for (const field of DATE_FIELD_PRIORITY) {
    // 匹配 "field: value" 或 "field: 'value'" 或 "field: \"value\""
    const pattern = new RegExp(`^${field.replace(/\s+/g, '\\s+')}:\\s*['"]?(.+?)['"]?\\s*$`, 'im');
    const match = frontmatter.match(pattern);
    if (match) {
      const parsed = parseNaturalDate(match[1]);
      if (parsed) return parsed;
    }
  }

  return null;
}

// --- Daily Note 文件名解析 ---

/**
 * 将 Obsidian 日期格式转为正则（简化版，覆盖常见格式）
 *
 * 支持 YYYY-MM-DD、YYYY.MM.DD、YYYYMMDD 等
 */
function parseDailyNoteFilename(relPath: string, dateFormat: string): string | null {
  // 取文件名（不含扩展名和目录）
  const filename = relPath.replace(/^.*\//, '').replace(/\.md$/, '');

  // 将 moment 格式转为捕获正则
  const pattern = dateFormat
    .replace(/YYYY/g, '(\\d{4})')
    .replace(/MM/g, '(\\d{2})')
    .replace(/DD/g, '(\\d{2})')
    .replace(/[.\-/]/g, (ch) => `\\${ch}`);

  // 确定 YYYY、MM、DD 在格式中的顺序
  const parts = dateFormat.match(/(YYYY|MM|DD)/g);
  if (!parts || parts.length !== 3) return null;

  const regex = new RegExp(`^${pattern}$`);
  const match = filename.match(regex);
  if (!match) return null;

  const values: Record<string, string> = {};
  parts.forEach((p, i) => { values[p] = match[i + 1]; });

  return `${values.YYYY}-${values.MM}-${values.DD}`;
}

// --- 主函数 ---

/**
 * 为 Obsidian vault 文件推断创建日期（五层策略链）
 *
 * @param files 分类后的文件列表
 * @param readContent 读取文件内容的函数（支持缓存）
 * @param vaultConfig vault 配置信息
 * @returns Map<relPath, InferredDateInfo>
 */
export function inferPageDates(
  files: ClassifiedFile[],
  readContent: (path: string) => string | null,
  vaultConfig: ObsidianVaultConfig,
): Map<string, InferredDateInfo> {
  const result = new Map<string, InferredDateInfo>();
  const dateFormat = vaultConfig.dailyNotes?.format ?? 'YYYY-MM-DD';

  // --- 层 1：Frontmatter 日期字段 ---
  for (const file of files) {
    const content = readContent(file.absPath);
    if (!content) continue;

    const date = extractFrontmatterDate(content);
    if (date) {
      result.set(file.relPath, { date, source: 'frontmatter', confidence: 0.95 });
    }
  }

  // --- 层 2：Daily Note 文件名 ---
  for (const file of files) {
    if (result.has(file.relPath)) continue;
    if (file.category !== 'daily_note') continue;

    const date = parseDailyNoteFilename(file.relPath, dateFormat);
    if (date) {
      result.set(file.relPath, { date, source: 'daily_note_filename', confidence: 0.95 });
    }
  }

  // --- 层 3：文件系统 birthtime ---
  for (const file of files) {
    if (result.has(file.relPath)) continue;

    try {
      const stat = fs.statSync(file.absPath);
      const birthtime = stat.birthtime;
      // birthtime 在 macOS/Windows 上可靠；Linux 上可能等于 ctime
      if (birthtime.getTime() > 0) {
        const date = birthtime.toISOString().slice(0, 10);
        result.set(file.relPath, { date, source: 'fs_birthtime', confidence: 0.7 });
      }
    } catch {
      // 文件不可读，跳过
    }
  }

  // --- 层 4：文件系统 mtime ---
  for (const file of files) {
    if (result.has(file.relPath)) continue;

    try {
      const stat = fs.statSync(file.absPath);
      const date = stat.mtime.toISOString().slice(0, 10);
      result.set(file.relPath, { date, source: 'fs_mtime', confidence: 0.5 });
    } catch {
      // 文件不可读，跳过
    }
  }

  // --- 层 5：中位数兜底 ---
  const orphans = files.filter(f => !result.has(f.relPath));
  if (orphans.length > 0) {
    const allDates = [...result.values()]
      .map(v => v.date)
      .sort();
    const medianDate = allDates.length > 0
      ? allDates[Math.floor(allDates.length / 2)]
      : new Date().toISOString().slice(0, 10);

    for (const orphan of orphans) {
      result.set(orphan.relPath, { date: medianDate, source: 'median_fallback', confidence: 0.3 });
    }
  }

  // --- 日志统计 ---
  const sourceCounts: Record<string, number> = {};
  for (const info of result.values()) {
    sourceCounts[info.source] = (sourceCounts[info.source] ?? 0) + 1;
  }

  const total = files.length;
  const fallbackCount = sourceCounts['median_fallback'] ?? 0;
  const covered = total - fallbackCount;
  const pct = total > 0 ? Math.round((covered / total) * 100) : 0;
  log.info(`时间推断: ${covered}/${total} 文件有可靠日期 (${pct}%)`);
  log.info(`各层覆盖: ${JSON.stringify(sourceCounts)}`);

  return result;
}
