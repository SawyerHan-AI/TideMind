import type Database from 'better-sqlite3';
import { getNode, createNode } from '../db/nodes.js';
import { getLinksForNode, createLink } from '../db/links.js';
import { isTaggedLink } from '../graph/maturity.js';
import { generateBridgeInsight, generateCrystal, enrichCrystalContent } from '../llm/extract.js';
import { getGraphVocabulary } from '../db/stats.js';
import { getGateStatus, invalidateGateCache } from '../db/stats.js';
import { now } from '../utils/time.js';
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../config.js';
import { getParam } from '../strategy/loader.js';
// inferSemtype removed — no longer needed with JSON relation format
import { logStrategyFeedback, logTimelineEvent } from '../db/log.js';
import { updateConnectivity, refreshMaturityScore } from '../graph/maturity.js';
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
  const candidates: Array<{ a: string; b: string; shared: number; sharedIds: string[]; score?: number }> = [];

  const nodeIds = activeNodes.map(n => n.id);

  // 预加载所有候选节点间的链接到 Set，避免 O(n²) 次 linkExists 查询
  // SQLite 参数上限 999：每批最多 400 个 id（两侧各一份 → 最多 800 个参数）
  const existingLinksAll: Array<{ from_id: string; to_id: string }> = [];
  const BATCH_ID_SIZE = 400;
  for (let bi = 0; bi < nodeIds.length; bi += BATCH_ID_SIZE) {
    const batchIds = nodeIds.slice(bi, bi + BATCH_ID_SIZE);
    const placeholders = batchIds.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT from_id, to_id FROM links
      WHERE from_id IN (${placeholders}) AND to_id IN (${placeholders})
    `).all(...batchIds, ...batchIds) as Array<{ from_id: string; to_id: string }>;
    existingLinksAll.push(...rows);
  }
  const linkSet = new Set<string>();
  for (const l of existingLinksAll) {
    linkSet.add(`${l.from_id}|${l.to_id}`);
    linkSet.add(`${l.to_id}|${l.from_id}`);
  }

  // 修复 M15(2026-05-09):候选对原本只用"共享邻居 >= 2"过滤,O(n²) 跑完
  // 配合按 shared 绝对数排序,hub 节点(高度数)会和很多其它节点共享 ≥ 2 邻居,
  // 占满 maxPairs 预算 — 实际并不是真正的"发散桥接信号"。改为共享邻居数 /
  // sqrt(degA * degB) 归一化后再排序,把"hub-everyone"压低,让真正稀有共享
  // 邻居的对子排前。
  const minShared = getParam('scan-divergent', 'min_shared_neighbors', 2);
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

      if (shared.length >= minShared) {
        // 归一化 score:共享邻居数 / 几何平均度数。两端度数都很大时会被压低,
        // 真正稀有的对(度数小、共享邻居多)分数高。
        const degA = neighborsA.size;
        const degB = neighborsB.size;
        const denom = Math.sqrt(degA * degB) || 1;
        const score = shared.length / denom;
        candidates.push({ a, b, shared: shared.length, sharedIds: shared, score });
      }
    }
  }

  // 按归一化 score 降序(hub 节点对子被压到后面)
  candidates.sort((x, y) => (y.score ?? 0) - (x.score ?? 0));

  // 用 LLM 生成桥接洞察
  const minConfidence = getParam('scan-divergent', 'min_confidence', 0.5);
  const bridges: Array<{ bridgeId: string; nodeA: string; nodeB: string; insight: string }> = [];

  // Dedup: 已经存在为 (a,b) 对生成的 is_crystal=1 bridge 节点,且创建日期在近 N 天内,
  // 则跳过 — 避免每周 tick 对同一 hub 无限堆 crystal。
  // 签名: 一个 crystal 节点通过 summarizes 链接同时指向 a 和 b(顺序无关),
  // 且节点 created 在 dedup_window_days 内。
  const dedupWindowDays = getParam('scan-divergent', 'bridge_dedup_days', 30);
  const dedupCutoffMs = Date.now() - dedupWindowDays * 24 * 60 * 60 * 1000;
  const hasRecentBridge = (a: string, b: string): boolean => {
    const row = db.prepare(`
      SELECT n.id, n.created FROM nodes n
      WHERE n.is_crystal = 1 AND n.is_superseded = 0
        AND EXISTS (
          SELECT 1 FROM links l, json_each(l.relation) j
          WHERE l.from_id = n.id AND l.to_id = ?
            AND json_extract(j.value, '$.type') = 'summarizes'
        )
        AND EXISTS (
          SELECT 1 FROM links l, json_each(l.relation) j
          WHERE l.from_id = n.id AND l.to_id = ?
            AND json_extract(j.value, '$.type') = 'summarizes'
        )
      LIMIT 1
    `).get(a, b) as { id: string; created: string } | undefined;
    if (!row) return false;
    // created 既可能是 JS ISO("2026-04-23T..."),也可能是 SQLite datetime('now')
    // 的 "YYYY-MM-DD HH:MM:SS" 无 Z 格式;统一拼 Z 解析。
    const createdMs = new Date(
      row.created.endsWith('Z') ? row.created : row.created.replace(' ', 'T') + 'Z',
    ).getTime();
    return Number.isFinite(createdMs) && createdMs >= dedupCutoffMs;
  };

  for (const candidate of candidates.slice(0, maxPairs)) {
    // 近 N 天已有同对 bridge → 跳过,别再堆新的 crystal 节点
    if (hasRecentBridge(candidate.a, candidate.b)) continue;

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
      // 创建桥接洞察节点（crystal 类型）— 统一走 createNode,避免手工 INSERT
      // 绕过 maturity 计算 / 维度派生 / source_* 字段 / now() 格式等。
      const bridgeTitle = result.title || result.content.slice(0, 50);
      const bridgeNode = createNode(db, {
        type: 'fact',
        content: result.content,
        title: bridgeTitle,
        heat: 1.0,
        refinement: 0.7,
        independence: 0.8,
        specificity: 0.3,
        subjectivity: 0.5,
        actuality: 0.7,
        is_crystal: 1,
        tags: result.tags ?? [],
        source_tool: 'divergent-scan',
      });
      const bridgeId = bridgeNode.id;

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
      bridges.push({
        bridgeId,
        nodeA: candidate.a,
        nodeB: candidate.b,
        insight: result.content,
      });
    }
  }

  log.info(`发散扫描: 候选对=${candidates.length} 桥接洞察=${bridges.length}`);

  if (bridges.length > 0) {
    logTimelineEvent(db, {
      type: 'think_emerge',
      subtype: 'divergent_scan',
      title: JSON.stringify({ key: 'bridge_insights', params: { count: bridges.length } }),
      detail: {
        candidates_evaluated: Math.min(candidates.length, maxPairs),
        bridges_created: bridges.length,
      },
      node_ids: bridges.map(b => b.bridgeId),
      important: 1,
    });
  }

  logStrategyFeedback(db, {
    strategy_name: 'scan-divergent',
    feedback_signal: candidates.length > 0
      ? bridges.length / Math.min(candidates.length, maxPairs)
      : 0,
  });

  // 发散扫描会创建 is_crystal=1 的 bridge 节点,crystal gate 依赖 crystal 计数,
  // 新增后必须让下一次 getGateStatus 读到最新值。
  if (bridges.length > 0) {
    invalidateGateCache();
  }

  return bridges.map(b => ({ nodeA: b.nodeA, nodeB: b.nodeB, insight: b.insight }));
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
  const pathACrystalIds = new Set<string>();
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
          const crystalTitle = crystal.title || crystal.content.slice(0, 50);
          const crystalNode = createNode(db, {
            type: 'fact',
            content: crystal.content,
            title: crystalTitle,
            heat: 1.0,
            refinement: 0.8,
            independence: 0.8,
            specificity: 0.2,
            subjectivity: 0.5,
            actuality: 0.8,
            is_crystal: 1,
            tags: crystal.tags ?? [],
            source_tool: 'crystal-emergence',
          });
          const crystalId = crystalNode.id;

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
          pathACrystalIds.add(crystalId);
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
      // 统一走 createNode,与 Path A / runDivergentScan 保持一致。
      const crystalTitle = crystal.title || crystal.content.slice(0, 50);
      const crystalNode = createNode(db, {
        type: 'fact',
        content: crystal.content,
        title: crystalTitle,
        heat: 1.0,
        refinement: 0.8,
        independence: 0.8,
        specificity: 0.2,
        subjectivity: 0.5,
        actuality: 0.8,
        is_crystal: 1,
        tags: crystal.tags ?? [],
        source_tool: 'crystal-emerge',
      });
      const crystalId = crystalNode.id;

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
        action: pathACrystalIds.has(crystalId) ? 'promoted' : 'generated',
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
    // 坑:SQLite 的 datetime('now') 返回 "YYYY-MM-DD HH:MM:SS"(无 Z,空格分隔),
    // 而 JS 的 new Date(...).toISOString() 返回 "YYYY-MM-DDTHH:MM:SS.sssZ"。
    // 这两种字符串丢给 new Date() 解析,前者会被当作本地时区,后者是 UTC —
    // 跨时区直接错几小时。统一按 UTC 规范化再比较。
    const normalizeTs = (s: string): number =>
      new Date(s.endsWith('Z') ? s : s.replace(' ', 'T') + 'Z').getTime();
    const crystalTime = crystal.last_reconsolidated || crystal.created;
    const crystalTs = normalizeTs(crystalTime);
    const modifiedSupporters = supporters.filter(s => {
      if (!s.last_reconsolidated) return false;
      return normalizeTs(s.last_reconsolidated) > crystalTs;
    });

    // 如果超过 30% 的支撑节点被修改，刷新 crystal
    if (modifiedSupporters.length >= Math.max(1, supporters.length * 0.3)) {
      try {
        const supporterContents = supporters.map(s => s.content);
        const enriched = await enrichCrystalContent(crystal.content, supporterContents);
        if (enriched && enriched !== crystal.content) {
          // 时区坑见上：last_reconsolidated 被 freshness.ts / daysAgo 经 new Date()
          // 解析，datetime('now') 无 Z 会被当本地时区 → 统一走 JS ISO。
          const ts = now();
          db.prepare(`
            UPDATE nodes SET content = ?, version = version + 1, last_reconsolidated = ?
            WHERE id = ?
          `).run(enriched, ts, crystal.id);

          // 版本历史
          db.prepare(`
            INSERT INTO node_versions (node_id, version, content, change_reason, changed_at)
            VALUES (?, (SELECT version FROM nodes WHERE id = ?), ?, 'crystal evidence refresh', ?)
          `).run(crystal.id, crystal.id, enriched, ts);

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
 *
 * 1. 使用完整 id 作为 filename 前缀:原本 `id.slice(0, 8)` 在 65k+ crystal
 *    节点下有生日攻击级碰撞概率(8 字符 hex ≈ 4.3e9 空间,sqrt ≈ 65k),
 *    两个不同 crystal 会互相覆盖。完整 id 保证唯一。
 * 2. 用 fs.promises.writeFile + 目录同步 mkdir + 返回 Promise,
 *    调用点按 fire-and-forget 走(错误在内部记 log,不影响调度器 tick)。
 *    同步 writeFileSync 会阻塞 scheduler 串行链路,触发其他到期任务错过窗口。
 */
function syncCrystalToMarkdown(id: string, content: string, tags: string[], promoted: boolean = false): void {
  const crystalDir = path.join(getDataDir(), 'crystal');
  try {
    // mkdir 用同步是安全的:它只在首个 crystal 时真建目录,后续是无开销 noop。
    fs.mkdirSync(crystalDir, { recursive: true });
  } catch (err) {
    log.error('Crystal 镜像目录创建失败:', (err as Error).message);
    return;
  }

  const title = Array.from(content).slice(0, 30).join('').replace(/[/\\:*?"<>|]/g, '_').trim();
  // 用完整 id 避免 slice(0,8) 的生日碰撞;文件系统 255 字节限制对 uuid+30 字符标题 (< 100) 绰绰有余。
  const fileName = `${id}_${title}.md`;
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

  // 改用异步 writeFile,避免阻塞 scheduler 串行 tick。
  // 错误在回调里吞并记 log —— crystal 镜像仅为可视化辅助,写失败不影响业务。
  fs.promises.writeFile(filePath, md).catch(err => {
    log.error('Crystal 镜像同步失败:', (err as Error).message);
  });
}

// needsWeeklyMaintenance 已于 2026-04-21 删除:
// - 读的 key `last_weekly_maintenance` 早已无人写入(claimMaintenance 亦同日删除);
// - 任务调度全面迁到 scheduler.ts::tryClaimTask + 任务级 last_task_{id};
// - 业务代码无 caller,仅 tests 里有单测,一并清理。
// 如有新需求应按任务粒度查 last_task_{id},不再用全局 weekly 维护概念。

/**
 * 关键种识别 — connectivity top-5% 的节点标记为 keystone
 */
export function runKeystoneIdentification(db: Database.Database): number {
  // 获取活跃节点总数
  const total = (db.prepare('SELECT COUNT(*) as cnt FROM nodes WHERE heat > 0.01 AND is_superseded = 0').get() as { cnt: number }).cnt;
  if (total < 20) return 0; // 太少没意义

  // Top 5% 节点标记为 keystone
  const topN = Math.max(1, Math.ceil(total * 0.05));
  // 原子: clear + set 必须在同一事务,否则中间有窗口"无人是 keystone",
  // 并发读到的 is_keystone 状态全错。better-sqlite3 同步 → 事务直接包起来。
  const result = db.transaction(() => {
    db.prepare('UPDATE nodes SET is_keystone = 0 WHERE is_keystone = 1').run();
    return db.prepare(`
      UPDATE nodes SET is_keystone = 1
      WHERE id IN (
        SELECT id FROM nodes
        WHERE heat > 0.01 AND is_meta = 0 AND is_superseded = 0
        ORDER BY connectivity DESC
        LIMIT ?
      )
    `).run(topN);
  })();

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
