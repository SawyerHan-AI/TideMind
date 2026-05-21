import type Database from 'better-sqlite3';
import { getParam } from '../strategy/loader.js';
import { logTimelineEvent } from '../db/log.js';
import { createLogger } from '../utils/logger.js';
import { now } from '../utils/time.js';

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
  // archived/superseded 节点不参与 heat decay,它们已被冰冻在 0.02
  const nodes = db.prepare(`
    SELECT n.id, n.heat, n.refinement, n.connectivity, n.is_keystone
    FROM nodes n WHERE n.heat > 0.01 AND n.archived = 0 AND n.is_superseded = 0
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
  // 0.285 这种"衰减覆盖提热"场景。
  //
  // ⚠️ SET 子句顺序坑：SQLite 把 SET 表达式右侧统一按"行的旧值"求值，
  // 所以 `maturity_score = ... MIN(heat * decayRate, 1.0) ...` 里的 heat 仍是
  // 衰减前的值，等价于 maturity 永远晚 heat 一个周期。修法是把 heat 衰减
  // 后的乘积直接当 WHERE 子句外的常量传进来，不要在 SET 里再去乘一次。
  // 这里改用子查询 `(SELECT heat * ? FROM nodes WHERE id = ?2)` 让 maturity
  // 引用同一行旧 heat 乘以 decayRate（与赋值给 heat 的值一致），保证
  // maturity_score 与 heat 始终基于同一基准计算。同时仍通过 SQL 侧 `heat * ?`
  // 保留对跨进程 bumpHeat 的安全语义。
  const updateStmt = db.prepare(`
    UPDATE nodes SET
      heat = heat * @rate,
      maturity_score = @wH * MIN((SELECT heat * @rate FROM nodes WHERE id = @id), 1.0)
                     + @wR * refinement + @wC * connectivity + @wI * independence,
      updated = @ts
    WHERE id = @id
  `);

  const decayBase = getParam('metabolism-params', 'decay_base', 0.05);
  const decayDamping = getParam('metabolism-params', 'decay_damping', 0.8);

  // 分批事务：每 BATCH_SIZE 个节点一个事务，减少写锁持有时间
  const BATCH_SIZE = 100;
  for (let i = 0; i < nodes.length; i += BATCH_SIZE) {
    const batch = nodes.slice(i, i + BATCH_SIZE);
    db.transaction(() => {
      const ts = now();
      for (const node of batch) {
        // 衰减率：所有节点严格衰减，连通度高的衰减更慢
        const decayRate = 1 - decayBase * (1 - decayDamping * Math.min(node.connectivity, 1));

        // 用具名参数：rate 在 SET 中出现两处（heat 衰减 / maturity 子查询），
        // id 同理（WHERE / 子查询），具名绑定避免位置参数重复传递。
        updateStmt.run({ rate: decayRate, wH, wR, wC, wI, ts, id: node.id });
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

  // purge + SELECT 必须在同一事务内原子完成:
  // 原写法先 DELETE 再 SELECT,两语句之间并发的 updateLinkStrength 会把一些
  // 链接降到 <= threshold,这些链接既没被 purge 捞走,也可能在 SELECT 里因
  // 时序被再次读进来继续衰减(最坏情况:先读旧值,衰减后写回时又新跌到阈值下)。
  // 统一包进 db.transaction 里,让 DELETE / SELECT 看到一致的数据库快照,
  // 任何并发的 UPDATE 在本事务提交前都看不到。
  // 原 SELECT 用严格 >,strength 恰好等于 threshold 的链接永远不会被扫,
  // 也就不会被衰减/删除,永远挂在图上。这里显式做一次独立 DELETE 兜底。
  const confirmedLinks = db.transaction(() => {
    const purgedBelowThreshold = db.prepare(
      "DELETE FROM links WHERE status = 'confirmed' AND strength <= ?",
    ).run(linkDeleteThreshold).changes;
    linkDeleted += purgedBelowThreshold;

    return db.prepare(`
      SELECT l.id, l.strength, l.from_id, l.to_id, l.relation
      FROM links l
      WHERE l.status = 'confirmed' AND l.strength > ?
    `).all(linkDeleteThreshold) as Array<{ id: string; strength: number; from_id: string; to_id: string; relation: string }>;
  })();

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

  // 必须 bump updated，否则赫布衰减 strength 变化不会被云端 reconcile 看到
  // （manifest LWW 比 updated → 云端 strength 永远胜出，本地衰减无效推送）。
  const linkUpdateStmt = db.prepare('UPDATE links SET strength = ?, updated = ? WHERE id = ?');
  const linkDeleteStmt = db.prepare('DELETE FROM links WHERE id = ?');

  for (let i = 0; i < confirmedLinks.length; i += BATCH_SIZE) {
    const batch = confirmedLinks.slice(i, i + BATCH_SIZE);
    const batchTs = now();
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
        // 2026-05-19 更新:heat 字段已统一钳到 1.0(见 src/db/nodes.ts:298 /
        // src/graph/dedup.ts:95)。activityFactor 现在最大 1.0,dailyRetention 最大 1.0,
        // newStrength 不再单调爬升超过原值。但保留出口 Math.min(1.0, ...) 作为深度防御:
        // 若 heat 重构再次放开上限或 link.strength 因迁移有历史脏数据 >1,此守卫挡住。
        const newStrength = Math.min(1.0, link.strength * dailyRetention);

        // 阈值比较与 L100 的 DELETE WHERE strength <= ? 对齐为 <=(inclusive):
        // 否则 strength 衰减到正好等于 0.05 的链接会延后一个 cycle 才被清(本轮 SELECT
        // 不到、本轮 loop 又走 else 分支留在表里),与 L96-98 注释"strength 恰好等于
        // threshold 永远不会被扫"语义冲突。
        if (newStrength <= linkDeleteThreshold) {
          linkDeleteStmt.run(link.id);
          linkDeleted++;
        } else {
          linkUpdateStmt.run(newStrength, batchTs, link.id);
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
