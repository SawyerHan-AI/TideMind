import type Database from 'better-sqlite3';
import { getParam } from '../strategy/loader.js';
import { logTimelineEvent } from '../db/log.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('synaptic');

/**
 * 每日突触衰减 + 归档判定
 *
 * 衰减公式: decay_rate = 1 - base × (1 - damping × min(connectivity, 1))
 * 其中 base=0.05, damping=0.8
 * 效果: connectivity=0 → ×0.950（衰减5%）, connectivity=0.5 → ×0.970, connectivity=1.0 → ×0.990
 * 所有节点严格衰减（decay_rate 恒 < 1.0），连通度高的节点衰减更慢但不会增长。
 */
export function runSynapticScaling(db: Database.Database): {
  decayed: number;
} {
  let decayed = 0;

  // 只处理 heat > 0.01 的节点（极低 heat 的自然沉底，不浪费计算）
  const nodes = db.prepare(`
    SELECT n.id, n.heat, n.refinement, n.connectivity, n.is_keystone
    FROM nodes n WHERE n.heat > 0.01
  `).all() as Array<{
    id: string;
    heat: number;
    refinement: number;
    connectivity: number;
    is_keystone: number;
  }>;

  // maturity_score 权重，与 graph/maturity.ts 一致（动态加载策略参数）
  const wH = getParam('recall-rank', 'heat_weight', 0.2);
  const wR = getParam('recall-rank', 'refinement_weight', 0.3);
  const wC = getParam('recall-rank', 'connectivity_weight', 0.3);
  const wI = getParam('recall-rank', 'independence_weight', 0.2);
  // 衰减因子(decayRate)传入 SQL,由 SQL 侧对当前 heat 做 heat = heat * decayRate,
  // 避免跨进程读-改-写覆盖:A 读 heat=0.3 → 期间 B bumpHeat 到 0.9 → A 写回
  // 0.285 这种"衰减覆盖提热"场景。maturity_score 也用当前最新 heat 重新计算。
  const updateStmt = db.prepare(`
    UPDATE nodes SET
      heat = heat * ?,
      maturity_score = ? * MIN(heat * ?, 1.0) + ? * refinement + ? * connectivity + ? * independence
    WHERE id = ?
  `);

  const decayBase = getParam('metabolism-params', 'decay_base', 0.05);
  const decayDamping = getParam('metabolism-params', 'decay_damping', 0.8);

  // 分批事务：每 BATCH_SIZE 个节点一个事务，减少写锁持有时间
  const BATCH_SIZE = 100;
  for (let i = 0; i < nodes.length; i += BATCH_SIZE) {
    const batch = nodes.slice(i, i + BATCH_SIZE);
    db.transaction(() => {
      for (const node of batch) {
        // 衰减率：所有节点严格衰减，连通度高的衰减更慢
        const decayRate = 1 - decayBase * (1 - decayDamping * Math.min(node.connectivity, 1));

        updateStmt.run(decayRate, wH, decayRate, wR, wC, wI, node.id);
        decayed++;
        // 不再归档 — heat 自然衰减到极低值即可，recall 按 heat 排序自然沉底
      }
    })();
  }

  // --- 链接衰减（赫布学习）---
  // 连接强度取决于两端的共同激活频率
  const linkDecayBase = getParam('metabolism-params', 'link_decay_base', 0.03);
  const linkDeleteThreshold = getParam('metabolism-params', 'link_delete_threshold', 0.05);
  let linkDecayed = 0;
  let linkDeleted = 0;

  const confirmedLinks = db.prepare(`
    SELECT l.id, l.strength, l.from_id, l.to_id, l.relation
    FROM links l
    WHERE l.status = 'confirmed' AND l.strength > ?
  `).all(linkDeleteThreshold) as Array<{ id: string; strength: number; from_id: string; to_id: string; relation: string }>;

  // 预取节点 heat
  const heatCache = new Map<string, number>();
  for (const link of confirmedLinks) {
    for (const nid of [link.from_id, link.to_id]) {
      if (!heatCache.has(nid)) {
        const row = db.prepare('SELECT heat FROM nodes WHERE id = ?').get(nid) as { heat: number } | undefined;
        heatCache.set(nid, row?.heat ?? 0);
      }
    }
  }

  const linkUpdateStmt = db.prepare('UPDATE links SET strength = ? WHERE id = ?');
  const linkDeleteStmt = db.prepare('DELETE FROM links WHERE id = ?');

  for (let i = 0; i < confirmedLinks.length; i += BATCH_SIZE) {
    const batch = confirmedLinks.slice(i, i + BATCH_SIZE);
    db.transaction(() => {
      for (const link of batch) {
        // tagged 链接跳过赫布衰减：标签归属是结构性分类关系，
        // 其生命周期跟随 tag 节点的 heat，不受赫布学习影响
        if (link.relation) {
          try {
            const relations: Array<{ type?: string }> = typeof link.relation === 'string'
              ? JSON.parse(link.relation)
              : link.relation;
            if (Array.isArray(relations) && relations.some(r => r?.type === 'tagged')) continue;
          } catch {
            // 解析失败时不跳过，继续衰减
          }
        }

        const heatA = heatCache.get(link.from_id) ?? 0;
        const heatB = heatCache.get(link.to_id) ?? 0;
        const activityFactor = Math.sqrt(heatA * heatB);
        const dailyRetention = 1 - linkDecayBase * (1 - activityFactor);
        const newStrength = link.strength * dailyRetention;

        if (newStrength < linkDeleteThreshold) {
          linkDeleteStmt.run(link.id);
          linkDeleted++;
        } else {
          linkUpdateStmt.run(newStrength, link.id);
          linkDecayed++;
        }
      }
    })();
  }

  log.info(`衰减 ${decayed} 节点, 链接衰减 ${linkDecayed} 条, 删除 ${linkDeleted} 条`);

  if (decayed > 0 || linkDecayed > 0) {
    logTimelineEvent(db, {
      type: 'memory',
      subtype: 'synaptic_scaling',
      title: JSON.stringify({ key: 'synaptic_decayed', params: { nodes: decayed, links: linkDecayed } }),
      detail: { decayed, linkDecayed, linkDeleted },
      important: 0,
    });
  }

  return { decayed };
}


// claimMaintenance 已移除 — 调度职责 2026-03-31 迁移到 scheduler.ts::tryClaimTask,
// 新统一 key 是 `last_task_{id}` (毫秒数字字符串),而非 `last_{daily|weekly}_maintenance`
// (ISO 字符串)。旧函数保留半年后确认无 caller,且格式与 scheduler 冲突
// (scheduler 用 CAST(value AS INTEGER) 对比, ISO 字符串 CAST 得到前导数字,
// 导致 needsWeeklyMaintenance 等读方恒误判),故 2026-04-21 彻底删除。
// 需要新任务的并发声明请直接用 scheduler.ts::tryClaimTask。
