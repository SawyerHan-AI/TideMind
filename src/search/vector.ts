import type { SearchResult } from '../types.js';
import type { IRepository } from '../db/repository.js';
import { getEmbedding, EMBEDDING_RECALL_TIMEOUT_MS } from '../llm/embedding.js';
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
  // recall 路径用 3s timeout（设计 §6.1），不沿用 indexing 默认 30s
  const queryEmbedding = await getEmbedding(embeddingText, { timeoutMs: EMBEDDING_RECALL_TIMEOUT_MS });
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
    if (node.archived || node.is_superseded) continue;
    if (options.type && node.type !== options.type) continue;
    if (options.excludeMeta && node.is_meta) continue;
    if (options.createdAfter && node.created < options.createdAfter) continue;
    if (options.createdBefore && node.created > options.createdBefore) continue;

    // sqlite-vec 返回 L2 距离，转换为余弦相似度（假设归一化向量）。
    //
    // TODO(embedding-normalize): `l2DistanceToSimilarity` 用的 `1 - d²/2` 公式**仅对
    // L2 范数为 1 的单位向量**成立。nomic-embed-text 默认已归一化,但 Gemini
    // `embedContent` 返回的 3072 维向量是 un-normalized —— 对这种向量,同一个
    // L2 距离会得到系统性偏差,甚至 similarity < 0(被 clamp 到 0)导致排序退化。
    //
    // 正确修法在写入端(`src/search/*repo*` 或 `src/llm/embedding.ts` 的 setter/
    // insertVector 路径):所有 embedding 在 insert 到 sqlite-vec 之前按 L2 范数归一
    // (除以 `Math.sqrt(sum(x²))`),查询端同理归一化 queryEmbedding。归一化后
    // L2 距离与余弦距离等价,`1 - d²/2` 才正确。
    //
    // 本文件不涉及写入路径,先保留此 TODO 给 embedding 写入/查询端处理。
    const similarity = l2DistanceToSimilarity(vr.distance);

    results.push({ node, score: similarity, source: 'vector' });

    if (results.length >= limit) break;
  }

  log.debug(`vec=${vecResults.length} filtered=${results.length}`);
  return results;
}
