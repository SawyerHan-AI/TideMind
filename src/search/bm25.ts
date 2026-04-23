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

  // BM25 归一化不变量:
  //   - FTS5 的 rank 是负数,越负 = 匹配越好;
  //   - 最佳得分 → 1.0,最差 → 0.0,线性映射 [minRank, maxRank] → [1.0, 0.0]。
  // 防御性地用 Math.min / Math.max 而不是 ftsResults[0] / ftsResults[length-1] —
  // FTS5 行序虽然在底层 query 里有 `ORDER BY bm25(...)`,但中间一旦没排序、
  // 或将来切到别的 retrieval 策略,假设排序就会引入 silent bug。
  // 退化情况:
  //   - length === 1   → 单一最佳匹配,得分 1.0(完整权重,与单结果场景下游期待一致)
  //   - 全部并列(maxRank === minRank 但 length > 1)→ 都给 0.5,
  //     避免 N 个并列结果各拿 1.0 反而压垮 hybrid 评分另一支(向量)。
  const ranks = ftsResults.map(r => r.rank);
  const minRank = Math.min(...ranks);  // 最佳(最负)
  const maxRank = Math.max(...ranks);  // 最差(最接近 0)
  const range = maxRank - minRank;     // 正数,可能为 0(全并列)

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

    let score: number;
    if (ftsResults.length === 1) {
      score = 1.0;            // 单结果:满分
    } else if (range === 0) {
      score = 0.5;            // 全部并列:给中点,避免压垮 hybrid 评分
    } else {
      // (maxRank - rank) / range:rank=minRank → 1.0,rank=maxRank → 0.0
      score = (maxRank - fts.rank) / range;
    }

    results.push({ node, score, source: 'bm25' });

    if (results.length >= limit) break;
  }

  log.debug(`FTS=${ftsResults.length} filtered=${results.length}`);
  return results;
}
