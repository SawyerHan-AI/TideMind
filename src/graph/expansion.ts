import type Database from 'better-sqlite3';
import type { BrainNode, BrainLink, Intent } from '../types.js';
import { getNode } from '../db/nodes.js';
import { getLinksForNode } from '../db/links.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('expansion');

const EXPANSION_HEAT_THRESHOLD = 0.01;

/** creative intent 下类比/发散链接优先 */
const CREATIVE_RELATION_PRIORITY: Record<string, number> = {
  analogous: 0,
  contradicts: 1,
  part_of: 2,
  summarizes: 3,
  supports: 4,
  continues: 5,
  updates: 6,
  caused_by: 7,
  tagged: 8,
};

/**
 * 获取链接的主要关系类型（confidence 最高的）
 */
function primaryRelationType(link: BrainLink): string {
  if (!Array.isArray(link.relation) || link.relation.length === 0) return 'analogous';
  return link.relation.reduce((best, r) => r.confidence > best.confidence ? r : best, link.relation[0]).type;
}

/**
 * 图遍历扩展：从一个节点出发，沿链接 BFS 遍历
 */
export function expandFromNode(
  db: Database.Database,
  startId: string,
  options: {
    depth?: number;
    maxNodes?: number;
    minStrength?: number;
    intent?: Intent;
  } = {},
): BrainNode[] {
  const {
    depth = 1,
    maxNodes = 20,
    intent,
  } = options;

  // creative intent：降低 strength 过滤阈值，优先类比链接
  const minStrength = options.minStrength ?? (intent === 'creative' ? 0.3 : 0.5);

  const visited = new Set<string>([startId]);
  const result: BrainNode[] = [];

  let frontier = [startId];

  for (let d = 0; d < depth && result.length < maxNodes; d++) {
    const nextFrontier: string[] = [];

    for (const nodeId of frontier) {
      let links: BrainLink[] = getLinksForNode(db, nodeId);

      // creative intent：按关系类型优先级排序，analogous（类比）链接优先
      if (intent === 'creative') {
        links = [...links].sort((a, b) => {
          const pa = CREATIVE_RELATION_PRIORITY[primaryRelationType(a)] ?? 99;
          const pb = CREATIVE_RELATION_PRIORITY[primaryRelationType(b)] ?? 99;
          return pa - pb;
        });
      }

      for (const link of links) {
        if (link.status !== 'confirmed') continue;
        if (link.strength < minStrength) continue;

        const targetId = link.from_id === nodeId ? link.to_id : link.from_id;
        if (visited.has(targetId)) continue;

        visited.add(targetId);
        const target = getNode(db, targetId);

        if (target && target.heat > EXPANSION_HEAT_THRESHOLD) {
          result.push(target);
          nextFrontier.push(targetId);

          if (result.length >= maxNodes) break;
        }
      }

      if (result.length >= maxNodes) break;
    }

    frontier = nextFrontier;
  }

  log.debug(`从 ${startId} 扩展: depth=${depth} found=${result.length} nodes`);
  return result;
}
