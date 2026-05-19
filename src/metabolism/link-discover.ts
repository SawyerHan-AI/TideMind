// ============================================================
// 思考（关联）— 链接发现
//
// 纯启发式候选筛选，不调 LLM。
// 创建 pending 链接，交给 link-evaluate 做 LLM 判断。
//
// 两种扫描策略：
// 1. 向量邻居：相似度高但无直连
// 2. 共同邻居：共享邻居多但无直连
// ============================================================

import type Database from 'better-sqlite3';
import { getNode } from '../db/nodes.js';
import { createLink, linkExists } from '../db/links.js';
import { searchVectors, getVectorForNode } from '../db/vectors.js';
import { isVecLoaded } from '../db/connection.js';
import { inferLinkType } from '../llm/link-judge.js';
import { l2DistanceToSimilarity } from '../utils/similarity.js';
import { getParam } from '../strategy/loader.js';
import { logTimelineEvent } from '../db/log.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('link-discover');

export interface LinkDiscoverResult {
  scanned: number;
  discovered: number;
}

/**
 * 发现新的候选链接（纯启发式，零 LLM 成本）
 *
 * 创建 pending 链接，由 link-evaluate 定时任务做 LLM 判断。
 */
export async function runLinkDiscover(db: Database.Database): Promise<LinkDiscoverResult> {
  let scanned = 0;
  let discovered = 0;

  const [vecResult, sharedResult] = await Promise.all([
    isVecLoaded() ? discoverByVectorNeighbors(db) : Promise.resolve({ scanned: 0, discovered: 0 }),
    discoverBySharedNeighbors(db),
  ]);
  scanned += vecResult.scanned + sharedResult.scanned;
  discovered += vecResult.discovered + sharedResult.discovered;

  if (discovered > 0) {
    log.info(`链接发现: 扫描=${scanned} 候选=${discovered}`);
    logTimelineEvent(db, {
      type: 'think_associate',
      subtype: 'link_discover',
      title: JSON.stringify({ key: 'links_discovered', params: { count: discovered } }),
      detail: { scanned, discovered },
    });
  }

  return { scanned, discovered };
}

// --- 策略 1: 向量邻居 ---

function discoverByVectorNeighbors(db: Database.Database): { scanned: number; discovered: number } {
  const similarityThreshold = getParam('link-discover', 'vector_similarity_threshold', 0.55);
  const maxChecks = getParam('link-discover', 'vector_max_checks', 5);
  const maxActiveNodes = getParam('link-discover', 'max_active_nodes', 50);

  const recentNodes = db.prepare(`
    SELECT id FROM nodes
    WHERE heat > 0.1 AND archived = 0 AND is_meta = 0 AND is_crystal = 0 AND is_superseded = 0
    ORDER BY heat DESC
    LIMIT ?
  `).all(maxActiveNodes) as Array<{ id: string }>;

  let scanned = 0;
  let discovered = 0;

  for (const { id: nodeId } of recentNodes) {
    // 必须用 getVectorForNode 而非直接 `SELECT FROM nodes_vec WHERE id = ?` —
    // nodes_vec.id 存的是 `${nodeId}#${segmentIndex}`,用裸 nodeId 查永远
    // 返回 undefined,整个向量邻居分支从未真正生效过。getVectorForNode
    // 正确地取第一段 embedding。
    const embedding = getVectorForNode(db, nodeId);
    if (!embedding) continue;

    const neighbors = searchVectors(db, embedding, 10);
    const candidates = neighbors
      .filter(n => n.id !== nodeId)
      .map(n => ({ id: n.id, similarity: l2DistanceToSimilarity(n.distance) }))
      .filter(n => n.similarity >= similarityThreshold)
      .slice(0, maxChecks);

    for (const candidate of candidates) {
      if (linkExists(db, nodeId, candidate.id)) continue;
      scanned++;

      const nodeA = getNode(db, nodeId);
      const nodeB = getNode(db, candidate.id);
      if (!nodeA || !nodeB) continue;

      const judgment = inferLinkType(nodeA, nodeB);

      createLink(db, {
        from_id: nodeId,
        to_id: candidate.id,
        relation: [judgment],
        strength: candidate.similarity,
        note: `向量邻居 (similarity=${candidate.similarity.toFixed(3)})`,
        auto: true,
        status: 'pending',
      });
      discovered++;
    }
  }

  return { scanned, discovered };
}

// --- 策略 2: 共同邻居 ---

function discoverBySharedNeighbors(db: Database.Database): { scanned: number; discovered: number } {
  const minSharedNeighbors = getParam('link-discover', 'min_shared_neighbors', 2);
  const maxCandidates = getParam('link-discover', 'max_shared_candidates', 20);

  // 排除 tagged 链接：tag 节点与大量节点之间有结构性 tagged 边,
  // 若纳入共享邻居会把所有带同一 tag 的节点两两连成候选,产生大量噪声
  // 候选对。对齐 divergent.ts:49 的同类过滤。
  const candidates = db.prepare(`
    SELECT a_node AS a, b_node AS b, COUNT(*) AS shared_count
    FROM (
      SELECT l1.from_id AS a_node, l2.from_id AS b_node, l1.to_id AS shared
      FROM links l1
      JOIN links l2 ON l1.to_id = l2.to_id AND l1.from_id < l2.from_id
      WHERE l1.status = 'confirmed' AND l2.status = 'confirmed'
        AND json_extract(l1.relation, '$[0].type') != 'tagged'
        AND json_extract(l2.relation, '$[0].type') != 'tagged'
      UNION ALL
      SELECT l1.to_id AS a_node, l2.to_id AS b_node, l1.from_id AS shared
      FROM links l1
      JOIN links l2 ON l1.from_id = l2.from_id AND l1.to_id < l2.to_id
      WHERE l1.status = 'confirmed' AND l2.status = 'confirmed'
        AND json_extract(l1.relation, '$[0].type') != 'tagged'
        AND json_extract(l2.relation, '$[0].type') != 'tagged'
    )
    GROUP BY a_node, b_node
    HAVING shared_count >= ?
    ORDER BY shared_count DESC
    LIMIT ?
  `).all(minSharedNeighbors, maxCandidates) as Array<{ a: string; b: string; shared_count: number }>;

  let scanned = 0;
  let discovered = 0;

  for (const candidate of candidates) {
    if (linkExists(db, candidate.a, candidate.b)) continue;
    scanned++;

    const nodeA = getNode(db, candidate.a);
    const nodeB = getNode(db, candidate.b);
    if (!nodeA || !nodeB || nodeA.heat < 0.01 || nodeB.heat < 0.01) continue;

    const judgment = inferLinkType(nodeA, nodeB);

    createLink(db, {
      from_id: candidate.a,
      to_id: candidate.b,
      relation: [judgment],
      strength: 0.5,
      note: `共同邻居 (shared=${candidate.shared_count})`,
      auto: true,
      status: 'pending',
    });
    discovered++;
  }

  return { scanned, discovered };
}
