import type Database from 'better-sqlite3';
import type { BrainNode, BrainLink, RelationType } from '../types.js';
import { getNode } from '../db/nodes.js';
import { getLinksForNode, createLink } from '../db/links.js';
import { isTaggedLink } from '../graph/maturity.js';
import { generateBridgeInsight, generateCrystal, enrichCrystalContent } from '../llm/extract.js';
import { getGraphVocabulary } from '../db/stats.js';
import { getGateStatus, invalidateGateCache } from '../db/stats.js';
import { now } from '../utils/time.js';
import { generateId } from '../utils/id.js';
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../config.js';
import { getParam } from '../strategy/loader.js';
// inferSemtype removed — no longer needed with JSON relation format
import { logStrategyFeedback, logTimelineEvent } from '../db/log.js';
import { updateConnectivity, computeMaturityScore, refreshMaturityScore } from '../graph/maturity.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('divergent');

/**
 * 发散扫描 — 结构洞检测
 *
 * 找到"共享邻居 ≥ 2 但无直接链接"的节点对
 * 用 LLM 评估是否有意外关联
 */
export async function runDivergentScan(
  db: Database.Database,
  options: { maxPairs?: number } = {},
): Promise<Array<{ nodeA: string; nodeB: string; insight: string }>> {
  const maxPairs = options.maxPairs ?? getParam('scan-divergent', 'max_candidate_pairs', 10);
  const gates = getGateStatus(db);

  if (!gates.features.divergent_scan) return [];

  // 获取活跃节点
  const minHeat = getParam('scan-divergent', 'min_heat_threshold', 0.1);
  const maxActiveNodes = getParam('scan-divergent', 'max_active_nodes', 100);
  const activeNodes = db.prepare(
    `SELECT id FROM nodes WHERE heat > ? AND is_meta = 0 AND is_superseded = 0 ORDER BY heat DESC LIMIT ?`,
  ).all(minHeat, maxActiveNodes) as Array<{ id: string }>;

  if (activeNodes.length < 10) return [];

  // 构建邻接表
  const adjacency = new Map<string, Set<string>>();
  for (const { id } of activeNodes) {
    // 排除 tagged 链接：结构洞检测只基于语义关系的共享邻居
    const links = getLinksForNode(db, id).filter(l => l.status === 'confirmed' && !isTaggedLink(l));
    const neighbors = new Set<string>();
    for (const link of links) {
      const targetId = link.from_id === id ? link.to_id : link.from_id;
      neighbors.add(targetId);
    }
    adjacency.set(id, neighbors);
  }

  // 找候选对：共享邻居 ≥ 2 且无直接链接
  const candidates: Array<{ a: string; b: string; shared: number; sharedIds: string[] }> = [];

  const nodeIds = activeNodes.map(n => n.id);

  // 预加载所有候选节点间的链接到 Set，避免 O(n²) 次 linkExists 查询
  const placeholders = nodeIds.map(() => '?').join(',');
  const existingLinks = db.prepare(`
    SELECT from_id, to_id FROM links
    WHERE from_id IN (${placeholders}) AND to_id IN (${placeholders})
  `).all(...nodeIds, ...nodeIds) as Array<{ from_id: string; to_id: string }>;
  const linkSet = new Set<string>();
  for (const l of existingLinks) {
    linkSet.add(`${l.from_id}|${l.to_id}`);
    linkSet.add(`${l.to_id}|${l.from_id}`);
  }

  for (let i = 0; i < nodeIds.length - 1; i++) {
    for (let j = i + 1; j < nodeIds.length; j++) {
      const a = nodeIds[i];
      const b = nodeIds[j];

      if (linkSet.has(`${a}|${b}`)) continue;

      const neighborsA = adjacency.get(a) ?? new Set();
      const neighborsB = adjacency.get(b) ?? new Set();

      const shared: string[] = [];
      for (const n of neighborsA) {
        if (neighborsB.has(n)) shared.push(n);
      }

      const minShared = getParam('scan-divergent', 'min_shared_neighbors', 2);
      if (shared.length >= minShared) {
        candidates.push({ a, b, shared: shared.length, sharedIds: shared });
      }
    }
  }

  // 按共享邻居数降序
  candidates.sort((x, y) => y.shared - x.shared);

  // 用 LLM 生成桥接洞察
  const minConfidence = getParam('scan-divergent', 'min_confidence', 0.5);
  const bridgeIds: string[] = [];

  for (const candidate of candidates.slice(0, maxPairs)) {
    const nodeA = getNode(db, candidate.a);
    const nodeB = getNode(db, candidate.b);
    if (!nodeA || !nodeB) continue;

    const sharedContents = candidate.sharedIds
      .map(id => getNode(db, id)?.content)
      .filter(Boolean) as string[];

    const result = await generateBridgeInsight(
      nodeA.content,
      nodeB.content,
      sharedContents,
    );

    if (result?.has_insight && result.content && (result.confidence ?? 0) >= minConfidence) {
      // 创建桥接洞察节点（crystal 类型）
      const bridgeId = generateId();
      const bridgeMaturity = computeMaturityScore(1.0, 0.7, 0.0, 0.8);
      const bridgeTitle = result.title || result.content.slice(0, 50);
      db.prepare(`
        INSERT INTO nodes (id, type, content, title, heat, refinement, connectivity, independence,
          maturity_score, is_crystal, specificity, subjectivity, actuality,
          tags, created, version)
        VALUES (?, 'fact', ?, ?, 1.0, 0.7, 0.0, 0.8, ?, 1, 0.3, 0.5, 0.7, ?, datetime('now'), 1)
      `).run(bridgeId, result.content, bridgeTitle, bridgeMaturity, JSON.stringify(result.tags ?? []));

      // 从桥接节点到两个源节点创建 pending 链接
      createLink(db, {
        from_id: bridgeId,
        to_id: candidate.a,
        relation: [{ type: 'summarizes', confidence: result.confidence ?? 0.6 }],
        strength: result.confidence ?? 0.6,
        auto: true,
        status: 'pending',
      });
      createLink(db, {
        from_id: bridgeId,
        to_id: candidate.b,
        relation: [{ type: 'summarizes', confidence: result.confidence ?? 0.6 }],
        strength: result.confidence ?? 0.6,
        auto: true,
        status: 'pending',
      });

      updateConnectivity(db, bridgeId);
      updateConnectivity(db, candidate.a);
      updateConnectivity(db, candidate.b);

      syncCrystalToMarkdown(bridgeId, result.content, result.tags ?? [], false);
      bridgeIds.push(bridgeId);
    }
  }

  log.info(`发散扫描: 候选对=${candidates.length} 桥接洞察=${bridgeIds.length}`);

  if (bridgeIds.length > 0) {
    logTimelineEvent(db, {
      type: 'think_emerge',
      subtype: 'divergent_scan',
      title: JSON.stringify({ key: 'bridge_insights', params: { count: bridgeIds.length } }),
      detail: {
        candidates_evaluated: Math.min(candidates.length, maxPairs),
        bridges_created: bridgeIds.length,
      },
      node_ids: bridgeIds,
      important: 1,
    });
  }

  logStrategyFeedback(db, {
    strategy_name: 'scan-divergent',
    feedback_signal: candidates.length > 0
      ? bridgeIds.length / Math.min(candidates.length, maxPairs)
      : 0,
  });

  return bridgeIds.map(id => {
    const node = getNode(db, id);
    return { nodeA: '', nodeB: '', insight: node?.content ?? '' };
  });
}

/**
 * 结晶涌现 — 识别自然涌现的枢纽节点并提升为 crystal
 *
 * 两条路径，统一使用 generateCrystal 生成全新的结晶节点：
 * - Path A（枢纽结晶）：从 keystone 节点 + 邻居中提炼结晶（输入中用 ★枢纽★ 标记核心节点）
 * - Path B（聚类合成）：密集团簇无单一枢纽时，LLM 从平等的多个节点中合成结晶
 */
export async function runCrystalEmergence(
  db: Database.Database,
): Promise<string[]> {
  const gates = getGateStatus(db);
  if (!gates.features.crystal_generation) return [];

  const promotedIds: string[] = [];

  // --- Path A: 识别自然枢纽并提升 ---
  const hubMinLinks = getParam('metabolism-params', 'hub_min_links', 5);
  const hubMinDiversity = getParam('metabolism-params', 'hub_min_diversity', 3);
  const hubMinIndegree = getParam('metabolism-params', 'hub_min_indegree', 3);

  const candidates = db.prepare(`
    SELECT
      n.id, n.content, n.independence, n.refinement,
      (SELECT COUNT(*) FROM links WHERE (from_id = n.id OR to_id = n.id) AND status = 'confirmed') as link_count,
      (SELECT COUNT(DISTINCT json_extract(j.value, '$.type')) FROM links l2, json_each(l2.relation) j WHERE (l2.from_id = n.id OR l2.to_id = n.id) AND l2.status = 'confirmed') as link_diversity,
      (SELECT COUNT(*) FROM links WHERE to_id = n.id AND status = 'confirmed') as in_degree
    FROM nodes n
    WHERE n.heat > 0.01 AND n.is_crystal = 0 AND n.is_meta = 0 AND n.is_superseded = 0
    ORDER BY link_count DESC
    LIMIT 20
  `).all() as Array<{
    id: string; content: string; independence: number; refinement: number;
    link_count: number; link_diversity: number; in_degree: number;
  }>;

  const hubCandidates = candidates.filter(c =>
    c.link_count >= hubMinLinks &&
    c.link_diversity >= hubMinDiversity &&
    c.in_degree >= hubMinIndegree,
  );

  // Path A: 满足条件的枢纽节点 → 从枢纽+邻居生成全新结晶节点
  // Path A 和 Path B 统一使用 generateCrystal，区别在于 Path A 输入中标记枢纽
  const pathBPool: Array<{ id: string; content: string }> = [];
  let pathACount = 0;

  const vocab = getGraphVocabulary(db);

  for (const hub of hubCandidates) {
    const isSpecific = hub.independence >= 0.4 && hub.content.length >= 30 && hub.refinement >= 0.2;

    if (isSpecific) {
      // 收集枢纽 + 邻居内容
      const neighborRows = db.prepare(`
        SELECT n.id, n.content FROM nodes n
        JOIN links l ON (l.to_id = n.id OR l.from_id = n.id)
        WHERE (l.from_id = ? OR l.to_id = ?) AND n.id != ?
          AND l.status = 'confirmed' AND n.heat > 0.01 AND n.is_superseded = 0
        ORDER BY l.strength DESC LIMIT 5
      `).all(hub.id, hub.id, hub.id) as Array<{ id: string; content: string }>;

      // 用 ★枢纽★ 标记区分枢纽节点，让 LLM 知道哪个是核心
      const contents = [
        `★枢纽★ ${hub.content}`,
        ...neighborRows.map(r => r.content),
      ];

      if (contents.length < 2) {
        // 枢纽没有邻居，放入 Path B 池
        pathBPool.push({ id: hub.id, content: hub.content });
        continue;
      }

      try {
        const crystal = await generateCrystal(contents, vocab.crystalSummaries);
        if (crystal) {
          const crystalId = generateId();
          const crystalMaturity = computeMaturityScore(1.0, 0.8, 0.0, 0.8);
          const crystalTitle = crystal.title || crystal.content.slice(0, 50);
          db.prepare(`
            INSERT INTO nodes (id, type, content, title, heat, refinement, connectivity, independence,
              maturity_score, is_crystal, specificity, subjectivity, actuality,
              tags, created, version)
            VALUES (?, 'fact', ?, ?, 1.0, 0.8, 0.0, 0.8, ?, 1, 0.2, 0.5, 0.8, ?, datetime('now'), 1)
          `).run(crystalId, crystal.content, crystalTitle, crystalMaturity, JSON.stringify(crystal.tags ?? []));

          // 链接到枢纽及其邻居
          const sourceNodes = [{ id: hub.id }, ...neighborRows];
          for (const node of sourceNodes) {
            createLink(db, {
              from_id: crystalId,
              to_id: node.id,
              relation: [{ type: 'summarizes', confidence: crystal.confidence }],
              strength: crystal.confidence,
              auto: true,
            });
          }
          updateConnectivity(db, crystalId);
          for (const node of sourceNodes) {
            updateConnectivity(db, node.id);
          }

          syncCrystalToMarkdown(crystalId, crystal.content, crystal.tags ?? [], false);
          promotedIds.push(crystalId);
          pathACount++;
        }
      } catch { /* crystal generation is optional */ }
    } else {
      pathBPool.push({ id: hub.id, content: hub.content });
    }
  }

  // --- Path B: 密集团簇 → 综合 crystal ---
  if (pathBPool.length >= 3) {
    const contents = pathBPool.slice(0, 10).map(n => n.content);
    const crystal = await generateCrystal(contents, vocab.crystalSummaries);
    if (crystal) {
      const crystalId = generateId();
      const crystalMaturity = computeMaturityScore(1.0, 0.8, 0.0, 0.8);
      const crystalTitle = crystal.title || crystal.content.slice(0, 50);
      db.prepare(`
        INSERT INTO nodes (id, type, content, title, heat, refinement, connectivity, independence,
          maturity_score, is_crystal, specificity, subjectivity, actuality,
          tags, created, version)
        VALUES (?, 'fact', ?, ?, 1.0, 0.8, 0.0, 0.8, ?, 1, 0.2, 0.5, 0.8, ?, datetime('now'), 1)
      `).run(crystalId, crystal.content, crystalTitle, crystalMaturity, JSON.stringify(crystal.tags ?? []));

      for (const node of pathBPool.slice(0, 10)) {
        createLink(db, {
          from_id: crystalId,
          to_id: node.id,
          relation: [{ type: 'summarizes', confidence: crystal.confidence }],
          strength: crystal.confidence,
          auto: true,
        });
      }
      updateConnectivity(db, crystalId);
      for (const node of pathBPool.slice(0, 10)) {
        updateConnectivity(db, node.id);
      }

      syncCrystalToMarkdown(crystalId, crystal.content, crystal.tags ?? [], false);
      promotedIds.push(crystalId);
    }
  }

  log.info(`crystal 涌现: Path A(枢纽结晶)=${pathACount} Path B(聚类合成)=${pathBPool.length >= 3 ? 1 : 0}`);

  for (const crystalId of promotedIds) {
    const node = getNode(db, crystalId);
    logTimelineEvent(db, {
      type: 'think_emerge',
      subtype: 'crystal_update',
      title: JSON.stringify({ key: 'crystal_generated' }),
      detail: {
        action: hubCandidates.some(h => h.id === crystalId) ? 'promoted' : 'generated',
        crystal_id: crystalId,
        summary: node?.content.slice(0, 80) ?? '',
      },
      node_ids: [crystalId],
      important: 1,
    });
  }

  // 检查已有 crystal 的证据变化
  const refreshedIds = await checkCrystalEvidence(db);
  promotedIds.push(...refreshedIds);

  if (promotedIds.length > 0) {
    invalidateGateCache();
  }

  // 策略反馈
  logStrategyFeedback(db, {
    strategy_name: 'crystal-emergence',
    feedback_signal: promotedIds.length > 0 ? 0.5 : 0,
  });

  return promotedIds;
}

/**
 * 检查已有 crystal 的底层证据是否有变
 * 如果支撑节点被修改/删除，标记 crystal 需要刷新
 */
async function checkCrystalEvidence(db: Database.Database): Promise<string[]> {
  const refreshed: string[] = [];

  // 找所有 crystal 节点
  const crystals = db.prepare(`
    SELECT id, content, last_reconsolidated, created
    FROM nodes WHERE is_crystal = 1 AND heat > 0.01 AND is_superseded = 0
    ORDER BY heat DESC LIMIT 10
  `).all() as Array<{ id: string; content: string; last_reconsolidated: string | null; created: string }>;

  for (const crystal of crystals) {
    // 找支撑节点（通过 summarizes 链接连接的节点）
    const supporters = db.prepare(`
      SELECT n.id, n.content, n.version, n.last_reconsolidated
      FROM nodes n
      JOIN links l ON (l.to_id = n.id OR l.from_id = n.id)
      WHERE (l.from_id = ? OR l.to_id = ?) AND n.id != ?
        AND l.status = 'confirmed' AND n.heat > 0.01 AND n.is_superseded = 0
      ORDER BY l.strength DESC LIMIT 10
    `).all(crystal.id, crystal.id, crystal.id) as Array<{
      id: string; content: string; version: number; last_reconsolidated: string | null;
    }>;

    if (supporters.length === 0) continue;

    // 检查支撑节点是否在 crystal 创建/更新后被修改
    const crystalTime = crystal.last_reconsolidated || crystal.created;
    const modifiedSupporters = supporters.filter(s => {
      if (!s.last_reconsolidated) return false;
      return new Date(s.last_reconsolidated) > new Date(crystalTime);
    });

    // 如果超过 30% 的支撑节点被修改，刷新 crystal
    if (modifiedSupporters.length >= Math.max(1, supporters.length * 0.3)) {
      try {
        const supporterContents = supporters.map(s => s.content);
        const enriched = await enrichCrystalContent(crystal.content, supporterContents);
        if (enriched && enriched !== crystal.content) {
          db.prepare(`
            UPDATE nodes SET content = ?, version = version + 1, last_reconsolidated = datetime('now')
            WHERE id = ?
          `).run(enriched, crystal.id);

          // 版本历史
          db.prepare(`
            INSERT INTO node_versions (node_id, version, content, change_reason, changed_at)
            VALUES (?, (SELECT version FROM nodes WHERE id = ?), ?, 'crystal evidence refresh', datetime('now'))
          `).run(crystal.id, crystal.id, enriched);

          refreshMaturityScore(db, crystal.id);
          refreshed.push(crystal.id);
          log.debug(`crystal 证据刷新 id=${crystal.id}`);
        }
      } catch { /* enrichment failure is non-fatal */ }
    }
  }

  return refreshed;
}

/**
 * 将 crystal 节点内容同步写入 ~/.tidemind/crystal/ 目录
 */
function syncCrystalToMarkdown(id: string, content: string, tags: string[], promoted: boolean = false): void {
  try {
    const crystalDir = path.join(getDataDir(), 'crystal');
    fs.mkdirSync(crystalDir, { recursive: true });
    const title = content.slice(0, 30).replace(/[/\\:*?"<>|]/g, '_').trim();
    const fileName = `${id.slice(0, 8)}_${title}.md`;
    const filePath = path.join(crystalDir, fileName);

    const md = [
      `# ${content.slice(0, 60)}`,
      '',
      content,
      '',
      tags.length > 0 ? `标签: ${tags.join(', ')}` : '',
      '',
      `---`,
      `节点 ID: ${id}`,
      `来源: ${promoted ? '自然涌现（提升）' : '综合生成'}`,
      `时间: ${now()}`,
    ].filter(Boolean).join('\n');

    fs.writeFileSync(filePath, md);
  } catch (err) {
    log.error('Crystal 镜像同步失败:', (err as Error).message);
  }
}

/**
 * 检查是否需要执行每周维护
 */
export function needsWeeklyMaintenance(db: Database.Database, checkDays: number = 7): boolean {
  const row = db.prepare(
    "SELECT value FROM metadata WHERE key = 'last_weekly_maintenance'",
  ).get() as { value: string } | undefined;

  if (!row) return true;

  const lastRun = new Date(row.value).getTime();
  const elapsed = Date.now() - lastRun;
  return elapsed > checkDays * 24 * 60 * 60 * 1000;
}

/**
 * 关键种识别 — connectivity top-5% 的节点标记为 keystone
 */
export function runKeystoneIdentification(db: Database.Database): number {
  // 清除旧标记
  db.prepare('UPDATE nodes SET is_keystone = 0 WHERE is_keystone = 1').run();

  // 获取活跃节点总数
  const total = (db.prepare('SELECT COUNT(*) as cnt FROM nodes WHERE heat > 0.01 AND is_superseded = 0').get() as { cnt: number }).cnt;
  if (total < 20) return 0; // 太少没意义

  // Top 5% 节点标记为 keystone
  const topN = Math.max(1, Math.ceil(total * 0.05));
  const result = db.prepare(`
    UPDATE nodes SET is_keystone = 1
    WHERE id IN (
      SELECT id FROM nodes
      WHERE heat > 0.01 AND is_meta = 0 AND is_superseded = 0
      ORDER BY connectivity DESC
      LIMIT ?
    )
  `).run(topN);

  if (result.changes > 0) {
    const keystoneIds = db.prepare(
      'SELECT id FROM nodes WHERE is_keystone = 1'
    ).all() as Array<{ id: string }>;
    logTimelineEvent(db, {
      type: 'think_emerge',
      subtype: 'keystone_identification',
      title: JSON.stringify({ key: 'keystones_identified', params: { count: result.changes } }),
      detail: { total_active: total, keystones_marked: result.changes, threshold_percentile: 0.05 },
      node_ids: keystoneIds.map(k => k.id),
    });
  }

  return result.changes;
}

