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
 * FTS 输入抽象（跨实现统一接口）
 * 设计 doc: docs/design/brain-recall-redesign-2026-05.md §9.4
 *
 * 跟 brain_recall schema 一致：只有 tokens + mode，不支持 query string 语法
 * (`+词` / `-词` / `"短语"`)。Agent 心智极轻：写 query 字符串 + 选 match。
 */
export interface FtsInput {
  tokens: string[];
  mode: 'and' | 'or';
}

/**
 * Tokenize query into FtsInput. 跨平台共享的入口。
 *
 * 切分规则跟旧 escapeFtsQuery 兼容：
 * - 去掉 FTS5 运算符字符和引号（防注入）
 * - 显式删除 AND/OR/NOT/NEAR 关键词（agent 写到 query 里时按字面词处理而不是运算符）
 * - 切分按空格
 * - 过滤掉纯符号 token（必须含 Unicode 字母/数字）
 *
 * 中文 query 不分词（FTS5 默认 tokenizer 不分中文）—— 整串中文作为单 token，
 * 在 FTS 里几乎查不到，由向量召回兜底。详见 §9.6 中文分词独立 backlog。
 */
export function tokenizeQuery(query: string, mode: 'and' | 'or' = 'or'): FtsInput {
  const cleaned = query
    .replace(/[(){}[\]*:^~"'/\\]/g, ' ')
    .replace(/\bAND\b|\bOR\b|\bNOT\b|\bNEAR\b/gi, '')
    .replace(/^[-+]+/, '')
    .replace(/[-+]+$/, '')
    .trim();
  if (!cleaned) return { tokens: [], mode };

  // 必须用 Unicode 字母/数字类 \p{L}\p{N}，否则 JS `\w` 只匹配 [A-Za-z0-9_]，
  // 纯中文 query (如 "研发周报") 会被全部过滤掉 → tokens=[] → 返回空 →
  // FTS 完全失效。
  const tokens = cleaned.split(/\s+/).filter(w => w.length > 0 && /[\p{L}\p{N}]/u.test(w));
  return { tokens, mode };
}

/**
 * 把 FtsInput 转换成 SQLite FTS5 MATCH 表达式。
 *
 * mode=or：用 OR 运算符连接 → 默认 OR 召回 + BM25 排序（全命中的天然排前）
 * mode=and：默认行为（空格分隔的引号短语在 FTS5 里是隐式 AND）
 *
 * 修复 2026-05-22 事故：旧 escapeFtsQuery 永远 AND，多词必 0 召回。
 */
export function buildFts5Query(input: FtsInput): string {
  if (input.tokens.length === 0) return '';
  // 单 token 时 mode 没区别，省一道 OR 关键字
  if (input.tokens.length === 1) return `"${input.tokens[0]}"`;
  const quoted = input.tokens.map(t => `"${t}"`);
  return input.mode === 'or' ? quoted.join(' OR ') : quoted.join(' ');
}

/**
 * FTS5 全文搜索
 * 返回按 BM25 排序的结果，rank 为负数（越小越好）
 *
 * @param query 用户原始 query 字符串
 * @param mode 'or' (默认) / 'and'。OR 是 brain_recall match=any 的实现；
 *             AND 是 brain_recall match=all 的实现。
 */
export function searchFTS(
  db: Database.Database,
  query: string,
  limit: number = 20,
  mode: 'and' | 'or' = 'or',
): FtsResult[] {
  // 转义 FTS5 特殊字符，防止语法错误
  const safeQuery = buildFts5Query(tokenizeQuery(query, mode));
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
    // 复用主路径的分词,按 mode 用 OR/AND 组合 per-token LIKE,
    // 否则多词 query 退化为整串连续子串匹配,近似 0 召回(与主路径 OR 召回语义相反)。
    // tokens 非空:safeQuery 为空时上面已 return [],catch 必有 >=1 token。
    const { tokens, mode: m } = tokenizeQuery(query, mode);
    const joiner = m === 'or' ? ' OR ' : ' AND ';
    const likeClause = tokens.map(() => "content LIKE ? ESCAPE '\\'").join(joiner);
    const params = tokens.map(t => `%${t.replace(/[%_]/g, '\\$&')}%`);
    return db.prepare(`
      SELECT id, content, -1.0 as rank
      FROM nodes
      WHERE (${likeClause})
        AND heat > 0.01
        AND is_superseded = 0
        AND archived = 0
      ORDER BY heat DESC
      LIMIT ?
    `).all(...params, limit) as FtsResult[];
  }
}

/**
 * 重建 FTS 索引
 */
export function rebuildFTS(db: Database.Database): void {
  db.exec("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild');");
}
