import type { SearchResult, HybridWeights, Intent, BrainNode, RelationType, BrainLink } from '../types.js';
import type { IRepository } from '../db/repository.js';
import { searchBM25 } from './bm25.js';
import { searchVector } from './vector.js';
import { getParam } from '../strategy/loader.js';
import { getGateStatus } from '../db/stats.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('search');

/**
 * 混合搜索：BM25 + 向量 + 热度 + 成熟度
 *
 * @param repo - Repository 接口
 * @param db - 仅用于 getGateStatus（待 stats 模块迁移后移除）
 */
export async function searchHybrid(
  repo: IRepository,
  db: import('better-sqlite3').Database,
  query: string,
  options: {
    limit?: number;
    type?: string;
    intent?: Intent;
    context?: string;
    createdAfter?: string;
    createdBefore?: string;
    excludeMeta?: boolean;
  } = {},
): Promise<SearchResult[]> {
  const limit = options.limit ?? 10;
  const gates = getGateStatus(db);
  const weights = getIntentWeights(options.intent);
  log.debug(`hybrid query="${query.slice(0, 60)}" intent=${options.intent ?? 'default'} vectorEnabled=${gates.features.vector_search}`);

  // BM25 搜索（始终可用）
  const bm25Results = searchBM25(repo, query, {
    limit: 20,
    type: options.type,
    createdAfter: options.createdAfter,
    createdBefore: options.createdBefore,
    excludeMeta: options.excludeMeta,
  });

  // 向量搜索（需要门控通过）
  let vectorResults: SearchResult[] = [];
  if (gates.features.vector_search) {
    vectorResults = await searchVector(repo, query, {
      limit: 20,
      type: options.type,
      context: options.context,
      createdAfter: options.createdAfter,
      createdBefore: options.createdBefore,
      excludeMeta: options.excludeMeta,
    });
  }

  // 合并结果
  const merged = new Map<string, {
    node: BrainNode;
    bm25Score: number;
    vectorScore: number;
  }>();

  for (const r of bm25Results) {
    merged.set(r.node.id, {
      node: r.node,
      bm25Score: r.score,
      vectorScore: 0,
    });
  }

  for (const r of vectorResults) {
    const existing = merged.get(r.node.id);
    if (existing) {
      existing.vectorScore = r.score;
    } else {
      merged.set(r.node.id, {
        node: r.node,
        bm25Score: 0,
        vectorScore: r.score,
      });
    }
  }

  // 计算综合评分
  const results: SearchResult[] = [];
  for (const [, item] of merged) {
    const maxHeat = 10.0; // heat 上限
    const heatBonus = Math.log(1 + item.node.heat) / Math.log(1 + maxHeat);
    const maturityBonus = computeIntentMaturity(item.node, options.intent);

    const score =
      weights.alpha * item.bm25Score +
      weights.beta * item.vectorScore +
      weights.gamma * heatBonus +
      weights.delta * maturityBonus;

    results.push({ node: item.node, score, source: 'hybrid' });
  }

  // 排序，取 top 结果用于邻居扩展
  results.sort((a, b) => b.score - a.score);

  // 邻居扩展：从 top-5 结果出发，沿链接扩展一跳
  // 按 intent 差异化：factual 沿因果链、creative 优先 analogous 且接受弱关联
  const expansionConfig = getExpansionConfig(options.intent);
  const EXPAND_TOP_N = 5;
  const resultIds = new Set(results.map(r => r.node.id));
  const neighborResults: SearchResult[] = [];

  const topForExpansion = results.slice(0, EXPAND_TOP_N);
  const topIds = topForExpansion.map(r => r.node.id);

  // 批量获取所有 top 结果的链接，避免 N+1
  const allLinks = repo.links.getLinksForNodes(topIds, { minStrength: expansionConfig.minStrength, statusFilter: 'confirmed' });

  // 收集所有邻居 ID
  const neighborIdSet = new Set<string>();
  for (const link of allLinks) {
    neighborIdSet.add(link.from_id);
    neighborIdSet.add(link.to_id);
  }
  // 移除已在结果中的 ID
  for (const id of resultIds) neighborIdSet.delete(id);

  // 批量获取所有邻居节点
  const neighborNodeMap = repo.nodes.getNodesByIds([...neighborIdSet]);

  // 按 top 结果遍历链接，计算邻居分数
  for (const result of topForExpansion) {
    for (const link of allLinks) {
      // 确保链接属于当前 result
      if (link.from_id !== result.node.id && link.to_id !== result.node.id) continue;

      const neighborId = link.from_id === result.node.id ? link.to_id : link.from_id;
      if (resultIds.has(neighborId)) continue;

      const neighborNode = neighborNodeMap.get(neighborId);
      if (!neighborNode || neighborNode.heat < 0.01) continue;
      if (options.excludeMeta && neighborNode.is_meta) continue;

      // 标记已处理，避免重复
      resultIds.add(neighborId);

      // 用相同公式计算分数，乘以衰减系数
      const maxHeat = 10.0;
      const heatBonus = Math.log(1 + neighborNode.heat) / Math.log(1 + maxHeat);
      const maturityBonus = computeIntentMaturity(neighborNode, options.intent);

      // 邻居没有直接的 BM25/向量分数，仅用 heat + maturity，再乘衰减
      let neighborScore =
        (weights.gamma * heatBonus + weights.delta * maturityBonus) * expansionConfig.decay;

      // 按 intent 对链接关系类型加权
      neighborScore *= getLinkRelationBoost(link, expansionConfig);

      neighborResults.push({ node: neighborNode, score: neighborScore, source: 'hybrid' });
    }
  }

  // 合并邻居结果，重新排序并截断
  const allResults = results.concat(neighborResults);
  allResults.sort((a, b) => b.score - a.score);
  log.debug(`bm25=${bm25Results.length} vector=${vectorResults.length} merged=${merged.size} 邻居=${neighborResults.length} final=${Math.min(allResults.length, limit)}`);
  return allResults.slice(0, limit);
}

/**
 * 根据 intent 调整权重
 */
function getIntentWeights(intent?: Intent): HybridWeights {
  const base: HybridWeights = {
    alpha: getParam('recall-rank', 'alpha', 0.3),
    beta: getParam('recall-rank', 'beta', 0.5),
    gamma: getParam('recall-rank', 'gamma', 0.1),
    delta: getParam('recall-rank', 'delta', 0.1),
  };

  switch (intent) {
    case 'factual':
      break;
    case 'exploratory':
      break;
    case 'creative':
      base.beta = 0.6;
      base.alpha = 0.2;
      break;
  }

  return base;
}

/**
 * 按 intent 调整成熟度维度权重
 * factual: 独立度翻倍（优先返回自包含的结论）
 * exploratory: 连通度翻倍（优先返回枢纽节点）
 */
function computeIntentMaturity(node: BrainNode, intent?: Intent): number {
  let wH = getParam('recall-rank', 'heat_weight', 0.2);
  let wR = getParam('recall-rank', 'refinement_weight', 0.3);
  let wC = getParam('recall-rank', 'connectivity_weight', 0.3);
  let wI = getParam('recall-rank', 'independence_weight', 0.2);

  switch (intent) {
    case 'factual':
      wI *= 2;
      break;
    case 'exploratory':
      wC *= 2;
      break;
  }

  const total = wH + wR + wC + wI;
  let base = (wH * Math.min(node.heat, 1) + wR * node.refinement + wC * node.connectivity + wI * node.independence) / total;

  // 原则 11（下行因果）：crystal 和 keystone 节点在搜索中获得额外提升
  // crystal 是涌现的高层洞察，应优先呈现；keystone 是图的结构枢纽
  if (node.is_crystal) base += 0.15;
  if (node.is_keystone) base += 0.05;

  return base;
}

/**
 * 图扩展配置——按 intent 差异化链接遍历策略
 * factual: 沿因果/事实链扩展，strength 阈值正常
 * exploratory: 所有链接类型，衰减更慢鼓励探索
 * creative: 优先 analogous，接受弱关联 (strength >= 0.3)
 */
interface ExpansionConfig {
  minStrength: number;
  decay: number;
  preferRelations: RelationType[] | null;
  boostRelations: RelationType[];
}

function getExpansionConfig(intent?: Intent): ExpansionConfig {
  switch (intent) {
    case 'factual':
      return {
        minStrength: 0.5,
        preferRelations: ['caused_by', 'supports', 'updates', 'continues', 'summarizes'],
        boostRelations: [],
        decay: 0.7,
      };
    case 'exploratory':
      return {
        minStrength: 0.5,
        preferRelations: null,
        boostRelations: [],
        decay: 0.8,
      };
    case 'creative':
      return {
        minStrength: 0.3,
        preferRelations: ['analogous', 'contradicts'],
        boostRelations: ['analogous'],
        decay: 0.7,
      };
    default:
      return {
        minStrength: 0.5,
        preferRelations: null,
        boostRelations: [],
        decay: 0.7,
      };
  }
}

/**
 * 根据链接关系类型和扩展配置计算加权系数
 * - preferRelations 非空时，不匹配的链接分数 ×0.5
 * - boostRelations 中的链接分数 ×1.5
 */
function getLinkRelationBoost(link: BrainLink, config: ExpansionConfig): number {
  const linkTypes = link.relation.map(r => r.type);
  let boost = 1.0;

  // 如果有偏好的关系类型，非匹配的降权
  if (config.preferRelations) {
    const hasPreferred = linkTypes.some(t => config.preferRelations!.includes(t));
    if (!hasPreferred) boost *= 0.5;
  }

  // boost 类型额外加分
  if (config.boostRelations.length > 0) {
    const hasBoosted = linkTypes.some(t => config.boostRelations.includes(t));
    if (hasBoosted) boost *= 1.5;
  }

  return boost;
}
