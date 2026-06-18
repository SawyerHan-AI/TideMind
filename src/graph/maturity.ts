import type Database from 'better-sqlite3';
import type { BrainLink } from '../types.js';
import { getParam } from '../strategy/loader.js';
import { getLinksForNode } from '../db/links.js';
import { now } from '../utils/time.js';
import { computeConnectivity as computeConnectivityPure, computeMaturityScore as computeMaturityScorePure, type ConnLink } from '../metabolism/decay-fns.js';

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
  // M8:权重从 recall-rank 策略参数读,公式委托 @core decay-fns(两端单一来源)。
  return computeMaturityScorePure(heat, refinement, connectivity, independence, {
    heat: getParam('recall-rank', 'heat_weight', 0.2),
    refinement: getParam('recall-rank', 'refinement_weight', 0.3),
    connectivity: getParam('recall-rank', 'connectivity_weight', 0.3),
    independence: getParam('recall-rank', 'independence_weight', 0.2),
  });
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
  // M8:connectivity 计算委托给 @core decay-fns(排除 tagged + strength × diversity,
  // 两端单一来源)。空集合也照常写库(2026-05-09 bug:空集合不写回 DB 会留陈旧
  // connectivity,maturity 跟着错);computeConnectivity([]) 返回 0、下面正常写。
  const connLinks: ConnLink[] = allLinks.map(l => ({
    strength: l.strength,
    relationTypes: Array.isArray(l.relation) ? l.relation.map(r => r.type) : [],
    isTagged: isTaggedLink(l),
  }));
  const connectivity = computeConnectivityPure(connLinks);

  // 原子更新 connectivity 和 maturity_score，避免崩溃时两者不一致
  const node = db.prepare('SELECT heat, refinement, independence FROM nodes WHERE id = ?')
    .get(nodeId) as { heat: number; refinement: number; independence: number } | undefined;

  if (node) {
    const score = computeMaturityScore(node.heat, node.refinement, connectivity, node.independence);
    db.prepare('UPDATE nodes SET connectivity = ?, maturity_score = ?, updated = ? WHERE id = ?').run(connectivity, score, now(), nodeId);
  } else {
    db.prepare('UPDATE nodes SET connectivity = ?, updated = ? WHERE id = ?').run(connectivity, now(), nodeId);
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
    db.prepare('UPDATE nodes SET maturity_score = ?, updated = ? WHERE id = ?').run(score, now(), nodeId);
  }
}
