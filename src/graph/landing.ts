import type Database from 'better-sqlite3';
import type { BrainLink } from '../types.js';
import { searchVectors } from '../db/vectors.js';
import { getNode } from '../db/nodes.js';
import { createLink, linkExists } from '../db/links.js';
import { updateConnectivity } from './maturity.js';
import { getParam } from '../strategy/loader.js';
import { inferLinkType } from '../llm/link-judge.js';
import { l2DistanceToSimilarity } from '../utils/similarity.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('landing');

export interface LandingResult {
  action: 'new' | 'merge';
  mergeTarget?: string;
  confirmedLinks: BrainLink[];
  pendingLinks: BrainLink[];
}

/**
 * 着陆连接算法
 *
 * 新节点进入图时，自动找到最近邻并建立连接
 */
export function findLandingConnections(
  db: Database.Database,
  nodeId: string,
  embedding: Float32Array,
  options: {
    dedupThreshold?: number;
    landingThreshold?: number;
    pendingThreshold?: number;
    topK?: number;
  } = {},
): LandingResult {
  const {
    dedupThreshold = getParam('metabolism-params', 'dedup_threshold', 0.92),
    landingThreshold = getParam('metabolism-params', 'landing_link_threshold', 0.80),
    pendingThreshold = getParam('metabolism-params', 'pending_link_threshold', 0.60),
    topK = getParam('metabolism-params', 'landing_link_top_k', 2),
  } = options;

  const result: LandingResult = {
    action: 'new',
    confirmedLinks: [],
    pendingLinks: [],
  };

  if (!embedding || embedding.length === 0) {
    log.warn(`节点 ${nodeId} 无 embedding，跳过 landing connections`);
    return result;
  }

  // 向量搜索 top-10 最近邻
  const neighbors = searchVectors(db, embedding, 10);

  // 转换为 similarity 并过滤自身
  const candidates = neighbors
    .filter(n => n.id !== nodeId)
    .map(n => ({
      id: n.id,
      similarity: l2DistanceToSimilarity(n.distance),
    }))
    .sort((a, b) => b.similarity - a.similarity);

  if (candidates.length === 0) return result;

  // 检查去重：最高相似度 > 0.92
  if (candidates[0].similarity >= dedupThreshold) {
    result.action = 'merge';
    result.mergeTarget = candidates[0].id;
    return result;
  }

  // 获取新节点信息用于链接类型推断
  const sourceNode = getNode(db, nodeId);
  if (!sourceNode) return result;

  // 设计原则 10（混沌边缘）：高确定性需要更高置信度，低确定性允许更自由的连接
  let adjustedLandingThreshold = landingThreshold;
  let adjustedPendingThreshold = pendingThreshold;
  if (sourceNode.actuality > 0.8) {
    adjustedLandingThreshold += 0.05; // 高确定性 → 更严格
    adjustedPendingThreshold += 0.05;
  } else if (sourceNode.actuality < 0.3) {
    adjustedLandingThreshold -= 0.05; // 低确定性 → 更宽松（鼓励发散）
    adjustedPendingThreshold -= 0.05;
  }

  // 着陆连接：top-K with similarity > landingThreshold → confirmed
  let confirmedCount = 0;
  for (const c of candidates) {
    if (c.similarity < adjustedPendingThreshold) break;

    if (c.similarity >= adjustedLandingThreshold && confirmedCount < topK) {
      // 检查是否已有链接
      if (!linkExists(db, nodeId, c.id)) {
        const targetNode = getNode(db, c.id);
        const judgment = targetNode
          ? inferLinkType(sourceNode, targetNode)
          : { type: 'analogous' as const, confidence: 0.4 };

        const link = createLink(db, {
          from_id: nodeId,
          to_id: c.id,
          relation: [judgment],
          strength: c.similarity,
          note: `着陆连接 (similarity=${c.similarity.toFixed(3)})`,
          auto: true,
          status: 'confirmed',
        });
        if (!link) continue;
        result.confirmedLinks.push(link);
        confirmedCount++;

        // 更新双方的 connectivity
        updateConnectivity(db, nodeId);
        updateConnectivity(db, c.id);
      }
    } else if (c.similarity >= adjustedPendingThreshold) {
      // pending 候选
      if (!linkExists(db, nodeId, c.id)) {
        const targetNode = getNode(db, c.id);
        const judgment = targetNode
          ? inferLinkType(sourceNode, targetNode)
          : { type: 'analogous' as const, confidence: 0.4 };

        const link = createLink(db, {
          from_id: nodeId,
          to_id: c.id,
          relation: [judgment],
          strength: c.similarity,
          note: `待确认连接 (similarity=${c.similarity.toFixed(3)})`,
          auto: true,
          status: 'pending',
        });
        if (!link) continue;
        result.pendingLinks.push(link);
      }
    }
  }

  log.debug(`node=${nodeId} action=${result.action} confirmed=${result.confirmedLinks.length} pending=${result.pendingLinks.length}`);
  return result;
}
