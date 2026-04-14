import type { SearchResult } from '../types.js';
import type { IRepository } from '../db/repository.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('bm25');

/**
 * BM25 搜索，返回归一化评分的节点列表
 */
export function searchBM25(
  repo: IRepository,
  query: string,
  options: {
    limit?: number;
    type?: string;
    createdAfter?: string;
    createdBefore?: string;
    excludeMeta?: boolean;
  } = {},
): SearchResult[] {
  const limit = options.limit ?? 20;
  const ftsResults = repo.fts.search(query, limit * 2); // 多取一些，后续过滤

  if (ftsResults.length === 0) return [];

  // FTS5 rank 是负数，越小（越负）越好
  // ftsResults 按 rank 升序排列：[0] 最负（最好），[last] 最接近 0（最差）
  const bestRank = ftsResults[0].rank;               // 最负，如 -15
  const worstRank = ftsResults[ftsResults.length - 1].rank;  // 最接近 0，如 -1
  const range = bestRank - worstRank;                 // 负数，如 -14

  const results: SearchResult[] = [];

  // 批量获取所有 FTS 结果对应的节点，避免 N+1 查询
  const nodeMap = repo.nodes.getNodesByIds(ftsResults.map(f => f.id));

  for (const fts of ftsResults) {
    const node = nodeMap.get(fts.id);
    if (!node || node.heat < 0.01) continue;

    // 过滤
    if (options.type && node.type !== options.type) continue;
    if (options.excludeMeta && node.is_meta) continue;
    if (options.createdAfter && node.created < options.createdAfter) continue;
    if (options.createdBefore && node.created > options.createdBefore) continue;

    // BM25 归一化：rank 最负（最好）→ 1.0，最接近 0（最差）→ 0.0
    const score = range === 0 ? 1.0 : (fts.rank - worstRank) / range;

    results.push({ node, score, source: 'bm25' });

    if (results.length >= limit) break;
  }

  log.debug(`FTS=${ftsResults.length} filtered=${results.length}`);
  return results;
}
