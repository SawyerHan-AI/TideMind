import type Database from 'better-sqlite3';
import type { BrainLink } from '../types.js';
import { getParam } from '../strategy/loader.js';
import { getLinksForNode } from '../db/links.js';

/**
 * 判断链接的主要关系类型是否为 tagged
 */
export function isTaggedLink(link: BrainLink): boolean {
  if (!Array.isArray(link.relation) || link.relation.length === 0) return false;
  // 取 confidence 最高的关系类型
  const primary = link.relation.reduce((best, r) => r.confidence > best.confidence ? r : best, link.relation[0]);
  return primary.type === 'tagged';
}

/**
 * 计算节点的 maturity_score（汇总分）
 */
export function computeMaturityScore(
  heat: number,
  refinement: number,
  connectivity: number,
  independence: number,
): number {
  const wHeat = getParam('recall-rank', 'heat_weight', 0.2);
  const wRefinement = getParam('recall-rank', 'refinement_weight', 0.3);
  const wConnectivity = getParam('recall-rank', 'connectivity_weight', 0.3);
  const wIndependence = getParam('recall-rank', 'independence_weight', 0.2);
  return wHeat * Math.min(heat, 1) + wRefinement * refinement + wConnectivity * connectivity + wIndependence * independence;
}

/**
 * 重新计算节点的 connectivity 值
 *
 * 基础分: min(1, confirmed_link_count * avg_strength / 5)
 * 多样性加成: 不同 relation type 越多，connectivity 越高（设计文档 §II）
 * 最终: base × (1 + diversity_bonus)，上限 1.0
 */
export function updateConnectivity(db: Database.Database, nodeId: string): number {
  const allLinks = getLinksForNode(db, nodeId).filter(l => l.status === 'confirmed');
  // connectivity 只计算语义链接，排除 tagged（分类索引不反映认知连通度）
  const links = allLinks.filter(l => !isTaggedLink(l));

  if (links.length === 0) return 0;

  const avgStrength = links.reduce((sum, l) => sum + l.strength, 0) / links.length;
  const baseConnectivity = Math.min(1, (links.length * avgStrength) / 5);

  // 链接多样性加成：统计不同 relation type 数量
  const relationTypes = new Set(
    links.flatMap(l => Array.isArray(l.relation) ? l.relation.map(r => r.type) : []),
  );
  // 1 种类型无加成，每多 1 种加 5%，上限 25%（5+ 种类型）
  const diversityBonus = Math.min(0.25, (Math.max(0, relationTypes.size - 1)) * 0.05);
  const connectivity = Math.min(1, baseConnectivity * (1 + diversityBonus));

  // 原子更新 connectivity 和 maturity_score，避免崩溃时两者不一致
  const node = db.prepare('SELECT heat, refinement, independence FROM nodes WHERE id = ?')
    .get(nodeId) as { heat: number; refinement: number; independence: number } | undefined;

  if (node) {
    const score = computeMaturityScore(node.heat, node.refinement, connectivity, node.independence);
    db.prepare('UPDATE nodes SET connectivity = ?, maturity_score = ? WHERE id = ?').run(connectivity, score, nodeId);
  } else {
    db.prepare('UPDATE nodes SET connectivity = ? WHERE id = ?').run(connectivity, nodeId);
  }

  return connectivity;
}

/**
 * 更新节点的 maturity_score
 */
export function refreshMaturityScore(db: Database.Database, nodeId: string): void {
  const node = db.prepare('SELECT heat, refinement, connectivity, independence FROM nodes WHERE id = ?')
    .get(nodeId) as { heat: number; refinement: number; connectivity: number; independence: number } | undefined;

  if (node) {
    const score = computeMaturityScore(node.heat, node.refinement, node.connectivity, node.independence);
    db.prepare('UPDATE nodes SET maturity_score = ? WHERE id = ?').run(score, nodeId);
  }
}
