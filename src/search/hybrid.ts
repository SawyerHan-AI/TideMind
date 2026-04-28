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
 */
export async function searchHybrid(
  repo: IRepository,
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
  // 过渡期：getGateStatus 尚未迁移到 repo 接口
  const gates = getGateStatus(repo.rawDb);
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

  // 批量获取所有 top 结果的链接，避免 N+1。
  //
  // 对称性保证(verified 2026-04-23):`repo.links.getLinksForNodes` 在 sqlite 实现
  // (`src/db/links.ts:135-162`)中 SQL 用的是 `from_id IN (...) OR to_id IN (...)`,
  // 返回的链接两端谁在 topIds 里都可能。下方按 (sourceNode, neighborNode) 分组时
  // 显式 swap from_id/to_id,所以入向和出向的邻居都会被展开,不会漏。
  // 如果将来替换 repo 实现(例如 pg-repository),必须保持同样的对称语义。
  const allLinks = repo.links.getLinksForNodes(topIds, { minStrength: expansionConfig.minStrength, statusFilter: 'confirmed' });

  // 按 (sourceNode, neighborNode) 分组链接,选择确定性的"代表链接"后再打分。
  // 原实现对 allLinks 直接迭代,如果同一 (source, neighbor) 对有多条 relation
  // 类型不同的链接(例如同时 caused_by + supports),首条被看到的 link 决定
  // boost 倍率,而 boost 又影响 neighborScore → 顺序依赖非确定性。
  // 修正: 每对只留 strength 最大(strength 并列时 id 字典序小)的链接,
  // 这样即便 DB 返回顺序不稳定,打分也稳定。
  const linksBySourceNeighbor = new Map<string, typeof allLinks[number]>();
  for (const link of allLinks) {
    // 确保链接两端包含某个 topResult
  let sourceId: string | null;
  let neighborId: string | null;
    if (resultIds.has(link.from_id) && !resultIds.has(link.to_id)) {
      sourceId = link.from_id;
      neighborId = link.to_id;
    } else if (resultIds.has(link.to_id) && !resultIds.has(link.from_id)) {
      sourceId = link.to_id;
      neighborId = link.from_id;
    } else {
      continue; // 两端都是 topResult 或都不是 → 不是"扩展到新邻居"的链接
    }
    const key = `${sourceId}|${neighborId}`;
    const existing = linksBySourceNeighbor.get(key);
    if (
      !existing ||
      link.strength > existing.strength ||
      (link.strength === existing.strength && link.id < existing.id)
    ) {
      linksBySourceNeighbor.set(key, link);
    }
  }

  // 收集所有邻居 ID
  const neighborIdSet = new Set<string>();
  for (const link of linksBySourceNeighbor.values()) {
    if (!resultIds.has(link.from_id)) neighborIdSet.add(link.from_id);
    if (!resultIds.has(link.to_id)) neighborIdSet.add(link.to_id);
  }

  // 批量获取所有邻居节点
  const neighborNodeMap = repo.nodes.getNodesByIds([...neighborIdSet]);

  // 对每个邻居,按 topForExpansion 顺序选第一个"有边"的 source;邻居分数只算一次。
  // topForExpansion 顺序由 results.sort(b.score - a.score) 得到,本身是确定性的。
  const seenNeighbors = new Set<string>();
  for (const result of topForExpansion) {
    for (const [key, link] of linksBySourceNeighbor) {
      if (!key.startsWith(`${result.node.id}|`)) continue;
      const neighborId = key.slice(result.node.id.length + 1);
      if (seenNeighbors.has(neighborId) || resultIds.has(neighborId)) continue;

      const neighborNode = neighborNodeMap.get(neighborId);
      if (!neighborNode || neighborNode.heat < 0.01) continue;
      if (options.excludeMeta && neighborNode.is_meta) continue;

      seenNeighbors.add(neighborId);

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

  // 合并邻居结果,按分数降序、ID 字典序升序(tiebreak,避免两条同分节点顺序随机)。
  const allResults = results.concat(neighborResults);
  allResults.sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id));
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
  const wH = getParam('recall-rank', 'heat_weight', 0.2);
  const wR = getParam('recall-rank', 'refinement_weight', 0.3);
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
  if (!Array.isArray(link.relation)) return 1.0;
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
