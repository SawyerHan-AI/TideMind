import type Database from 'better-sqlite3';
import { createLogger } from '../utils/logger.js';

const log = createLogger('fts');

export interface FtsResult {
  rowid: number;
  id: string;
  content: string;
  rank: number;
}

/**
 * FTS5 全文搜索
 * 返回按 BM25 排序的结果，rank 为负数（越小越好）
 */
export function searchFTS(
  db: Database.Database,
  query: string,
  limit: number = 20,
): FtsResult[] {
  // 转义 FTS5 特殊字符，防止语法错误
  const safeQuery = escapeFtsQuery(query);
  if (!safeQuery) return [];

  try {
    // archived 必须显式过滤:archive 路径设 heat = 0.02(node-lifecycle.ts:93),
    // 正好 > 0.01 阈值 → 不加 archived=0 时已归档节点会出现在搜索结果。
    return db.prepare(`
      SELECT nodes.id, nodes.content, nodes_fts.rank
      FROM nodes_fts
      JOIN nodes ON nodes.rowid = nodes_fts.rowid
      WHERE nodes_fts MATCH ?
        AND nodes.heat > 0.01
        AND nodes.is_superseded = 0
        AND nodes.archived = 0
      ORDER BY bm25(nodes_fts, 5.0, 1.0, 2.0)
      LIMIT ?
    `).all(safeQuery, limit) as FtsResult[];
  } catch (err) {
    log.warn(`FTS 查询失败，降级为 LIKE 搜索: ${(err as Error).message}`);
    const escapedQuery = query.replace(/[%_]/g, '\\$&');
    return db.prepare(`
      SELECT id, content, -1.0 as rank
      FROM nodes
      WHERE content LIKE ? ESCAPE '\\'
        AND heat > 0.01
        AND is_superseded = 0
        AND archived = 0
      ORDER BY heat DESC
      LIMIT ?
    `).all(`%${escapedQuery}%`, limit) as FtsResult[];
  }
}

/**
 * 转义 FTS5 查询
 * 将用户输入转为安全的 FTS5 查询语法
 */
function escapeFtsQuery(query: string): string {
  // 去掉 FTS5 运算符字符和引号
  const cleaned = query
    .replace(/[(){}[\]*:^~"'/\\]/g, ' ')
    .replace(/\bAND\b|\bOR\b|\bNOT\b|\bNEAR\b/gi, '')
    .replace(/^[-+]+/, '')       // 去除开头的 +/-
    .replace(/[-+]+$/, '')       // 去除结尾的 +/-
    .trim();

  if (!cleaned) return '';

  // 将空格分隔的词用双引号包裹，过滤空词和纯符号
  const words = cleaned.split(/\s+/).filter(w => w.length > 0 && /\w/.test(w));
  if (words.length === 0) return '';

  // 多个词用空格连接（FTS5 默认 AND 语义）
  return words.map(w => `"${w}"`).join(' ');
}

/**
 * 重建 FTS 索引
 */
export function rebuildFTS(db: Database.Database): void {
  db.exec("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild');");
}
