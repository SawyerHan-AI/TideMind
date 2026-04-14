import type { SearchResult } from '../types.js';
import type { IRepository } from '../db/repository.js';
import { getEmbedding } from '../llm/embedding.js';
import { l2DistanceToSimilarity } from '../utils/similarity.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('vector');

/**
 * 向量语义搜索
 * 将 distance 转换为 similarity (0-1)
 */
export async function searchVector(
  repo: IRepository,
  query: string,
  options: {
    limit?: number;
    type?: string;
    context?: string;
    createdAfter?: string;
    createdBefore?: string;
    excludeMeta?: boolean;
  } = {},
): Promise<SearchResult[]> {
  const limit = options.limit ?? 20;

  // 获取查询向量（有 context 时拼接，增强语义信号）
  const embeddingText = options.context
    ? `${query}\n背景: ${options.context}`
    : query;
  const queryEmbedding = await getEmbedding(embeddingText);
  if (!queryEmbedding) {
    log.warn('query embedding 获取失败');
    return [];
  }

  const vecResults = repo.vectors.searchVectors(queryEmbedding, limit * 2);
  if (vecResults.length === 0) return [];

  const results: SearchResult[] = [];

  // 批量获取所有向量结果对应的节点，避免 N+1 查询
  const nodeMap = repo.nodes.getNodesByIds(vecResults.map(v => v.id));

  for (const vr of vecResults) {
    const node = nodeMap.get(vr.id);
    if (!node || node.heat < 0.01) continue;
    if (options.type && node.type !== options.type) continue;
    if (options.excludeMeta && node.is_meta) continue;
    if (options.createdAfter && node.created < options.createdAfter) continue;
    if (options.createdBefore && node.created > options.createdBefore) continue;

    // sqlite-vec 返回 L2 距离，转换为余弦相似度（假设归一化向量）
    const similarity = l2DistanceToSimilarity(vr.distance);

    results.push({ node, score: similarity, source: 'vector' });

    if (results.length >= limit) break;
  }

  log.debug(`vec=${vecResults.length} filtered=${results.length}`);
  return results;
}
