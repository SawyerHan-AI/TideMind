/**
 * M8.5 客户端 generation 驱动重算:本地把 active 节点 heat lazy 衰减到云端 generation G。
 *
 * heat = max(decayHeat(heat, connectivity, G − decay_gen), 0.01),maturity 重算,decay_gen = G。
 * 用现有 connectivity 列值(由下行 / 本地 link 变化 updateConnectivity 维护,不在此重算)。
 * 与云端 synaptic-decay 同一 `@core` 公式 + 同步的 G + 一致的 connectivity → 逐位一致。
 *
 * **不 bump updated**:heat 是派生字段,不应改内容版本(否则 reconcile manifest 比 updated 会
 * 误判本地较新而上行)。调用方(sync-client)用 withApplyGuard 包裹,避免进 cloud_dirty 上行。
 */

import type Database from 'better-sqlite3';
import { decayHeat, computeMaturityScore, type MaturityWeights, type HeatDecayParams } from './decay-fns.js';
import { getParam } from '../strategy/loader.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('generation-decay');

const HEAT_FLOOR = 0.01;
const GEN_KEY = 'cloud.decay_generation';

/** 读本地 generation 锚点(metadata)。无则 0。 */
export function getLocalGeneration(db: Database.Database): number {
  try {
    const row = db.prepare(`SELECT value FROM metadata WHERE key = ?`).get(GEN_KEY) as { value?: string } | undefined;
    const v = row?.value ? parseInt(row.value, 10) : 0;
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

function setLocalGeneration(db: Database.Database, G: number): void {
  db.prepare(`INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)`).run(GEN_KEY, String(G));
}

/** 读 metadata 数值(云端下发的 decay 参数)。无/非法 → undefined,调用方回退本地策略参数。 */
function readMetaNum(db: Database.Database, key: string): number | undefined {
  try {
    const row = db.prepare(`SELECT value FROM metadata WHERE key = ?`).get(key) as { value?: string } | undefined;
    if (row?.value == null) return undefined;
    const n = parseFloat(row.value);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

function maturityWeights(): MaturityWeights {
  return {
    heat: getParam('recall-rank', 'heat_weight', 0.2),
    refinement: getParam('recall-rank', 'refinement_weight', 0.3),
    connectivity: getParam('recall-rank', 'connectivity_weight', 0.3),
    independence: getParam('recall-rank', 'independence_weight', 0.2),
  };
}

/**
 * 把本地 active 节点 heat/maturity 重算到 generation G。G ≤ 本地 G 时不动(幂等)。
 * 返回重算的节点数。不 bump updated;调用方负责 withApplyGuard 抑制上行。
 */
export function recomputeToGeneration(db: Database.Database, G: number): number {
  const localG = getLocalGeneration(db);
  if (!Number.isFinite(G) || G <= localG) return 0;

  // CRITICAL 修复:首次采纳 generation 模型(localG=0)。存量节点 decay_gen 迁移默认 0,
  // 但其 heat 是旧 wall-clock / 下行维护的**当前态**,不对应"generation 0"。直接
  // gen=G−0=G 衰减会把全表 heat 一次性砸向下限(暴跌、摧毁 recall 排序;部署 skew 下
  // 云端 G 已涨到 N)。故首次只**锚定** decay_gen=G、不衰减 heat,之后再按 delta 正常衰减。
  if (localG <= 0) {
    const anchored = db.prepare(`UPDATE nodes SET decay_gen = ? WHERE archived = 0 AND decay_gen < ?`).run(G, G);
    setLocalGeneration(db, G);
    log.info(`generation 首次采纳: 锚定 ${anchored.changes} 节点 decay_gen=${G}(不衰减,heat 保持旧态)`);
    return 0;
  }

  const weights = maturityWeights();
  // 审计修复:衰减参数**优先用云端随锚点下发的值**(metadata cloud.decay_base/damping,由
  // sync-client recomputeMetabolismGeneration 写入),与云端 synaptic-decay 逐位一致 —— 这才
  // 真正关死 learning2 本地调参导致两端发散。无下发(纯本地/未同步)回退本地策略参数。
  const heatParams: HeatDecayParams = {
    base: readMetaNum(db, 'cloud.decay_base') ?? getParam('metabolism-params', 'decay_base', 0.05),
    damping: readMetaNum(db, 'cloud.decay_damping') ?? getParam('metabolism-params', 'decay_damping', 0.8),
  };
  const nodes = db.prepare(`
    SELECT id, heat, connectivity, refinement, independence, decay_gen
    FROM nodes WHERE archived = 0 AND is_superseded = 0 AND heat > ?
  `).all(HEAT_FLOOR) as Array<{
    id: string; heat: number; connectivity: number; refinement: number; independence: number; decay_gen: number;
  }>;

  const update = db.prepare(`UPDATE nodes SET heat = ?, maturity_score = ?, decay_gen = ? WHERE id = ?`);
  const BATCH = 200;
  let count = 0;
  for (let i = 0; i < nodes.length; i += BATCH) {
    const batch = nodes.slice(i, i + BATCH);
    db.transaction(() => {
      for (const n of batch) {
        const gen = G - (n.decay_gen ?? 0);
        if (gen <= 0) continue; // 节点已 anchor 到 ≥G(新节点/已重算),跳过
        const newHeat = Math.max(decayHeat(n.heat, n.connectivity, gen, heatParams), HEAT_FLOOR);
        const maturity = computeMaturityScore(newHeat, n.refinement, n.connectivity, n.independence, weights);
        update.run(newHeat, maturity, G, n.id);
        count++;
      }
    })();
  }
  setLocalGeneration(db, G);
  log.info(`generation 重算: G ${localG}→${G}, ${count} 节点`);
  return count;
}
