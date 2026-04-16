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
  const updateStmt = db.prepare(`
    UPDATE nodes SET
      heat = ?,
      maturity_score = ? * MIN(?, 1.0) + ? * refinement + ? * connectivity + ? * independence
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
        const newHeat = node.heat * decayRate;

        updateStmt.run(newHeat, wH, newHeat, wR, wC, wI, node.id);
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


/**
 * @deprecated 已迁移到 scheduler.ts 的 claimTask。保留向后兼容。
 */
export function claimMaintenance(db: Database.Database, type: 'daily' | 'weekly'): boolean {
  const key = `last_${type}_maintenance`;
  const nowMs = Date.now();
  const intervalMs = type === 'daily'
    ? (getParam('metabolism-params', 'daily_check_hours', 24) * 3600000)
    : (getParam('metabolism-params', 'weekly_check_days', 7) * 86400000);
  const threshold = nowMs - intervalMs;

  // 尝试原子更新：只有当上次执行时间早于阈值时才成功
  const result = db.prepare(
    `UPDATE metadata SET value = ? WHERE key = ? AND CAST(value AS REAL) < ?`,
  ).run(nowMs.toString(), key, threshold.toString());

  if (result.changes === 1) return true;

  // changes === 0: 可能是行不存在（首次运行），尝试插入
  try {
    db.prepare(
      `INSERT INTO metadata (key, value) VALUES (?, ?)`,
    ).run(key, nowMs.toString());
    return true;
  } catch {
    // INSERT 失败（UNIQUE 冲突）= 另一个进程已插入 = 声明失败
    return false;
  }
}
