/**
 * A 类代谢确定性纯函数(M8)。无 DB、无时钟、无策略加载 —— 两端(client daemon +
 * cloud worker)经 `@core` import 复用,golden-vector 保证逐位一致。
 *
 * 公式来源(M8 抽取为单一权威,云端不再用 flat heat / log connectivity 版本):
 *  - heat 衰减:src/metabolism/synaptic.ts:72(connectivity 加权)
 *  - connectivity:src/graph/maturity.ts:40-66(strength × diversity,排除 tagged)
 *  - maturity:src/graph/maturity.ts:20-30(加权汇总)
 *
 * heat 衰减从"按 wall-clock 每日"改为"按 generation 代数"(generation-anchored):
 * decayHeat(heat, conn, G - decay_gen)。各端用同一函数 + 同步的 generation + 一致的
 * connectivity(links 已同步)→ 逐位一致。
 */

export interface HeatDecayParams {
  /** decay_base,默认 0.05 */
  base: number;
  /** decay_damping,默认 0.8 */
  damping: number;
}

export const DEFAULT_HEAT_DECAY_PARAMS: HeatDecayParams = { base: 0.05, damping: 0.8 };

/**
 * 单代 heat 衰减率(connectivity 加权:连通度高衰减慢)。
 * rate = 1 − base × (1 − damping × min(connectivity, 1))
 * conn=0 → 0.95;conn=0.5 → 0.97;conn=1 → 0.99(base=0.05, damping=0.8)。
 */
export function heatDecayRate(connectivity: number, params: HeatDecayParams = DEFAULT_HEAT_DECAY_PARAMS): number {
  return 1 - params.base * (1 - params.damping * Math.min(connectivity, 1));
}

/**
 * heat 衰减 `generations` 代(generation-anchored)。heat × rate^generations。
 * generations ≤ 0 原样返回(新节点 decay_gen = 当前 G,差值 0 不衰减,避免过度衰减)。
 */
export function decayHeat(
  heat: number,
  connectivity: number,
  generations: number,
  params: HeatDecayParams = DEFAULT_HEAT_DECAY_PARAMS,
): number {
  if (generations <= 0) return heat;
  return heat * Math.pow(heatDecayRate(connectivity, params), generations);
}

/** computeConnectivity 的单条链接输入(tagged 判定由调用方按各自语义完成)。 */
export interface ConnLink {
  strength: number;
  /** 该链接 relation 的 type 列表(用于 diversity 统计) */
  relationTypes: string[];
  /** 是否 tagged 链接(主关系 type==='tagged');tagged 不计入认知连通度 */
  isTagged: boolean;
}

/**
 * connectivity:语义链接(排除 tagged)的 strength + 多样性。
 * base = min(1, count × avgStrength / 5);diversity = min(0.25, (typeCount−1) × 0.05);
 * 结果 = min(1, base × (1 + diversity))。无语义链接 → 0。
 */
export function computeConnectivity(links: ConnLink[]): number {
  const semantic = links.filter((l) => !l.isTagged);
  if (semantic.length === 0) return 0;
  const avgStrength = semantic.reduce((s, l) => s + l.strength, 0) / semantic.length;
  const base = Math.min(1, (semantic.length * avgStrength) / 5);
  // filter(Boolean):归一两端 call site 的 relationTypes 预处理差异(空/缺失 type 不计入
   // 多样性),避免 client 把 undefined/'' 计入而云端过滤 → diversity size 差 1 → connectivity 发散。
  const types = new Set(semantic.flatMap((l) => l.relationTypes).filter(Boolean));
  const diversityBonus = Math.min(0.25, Math.max(0, types.size - 1) * 0.05);
  return Math.min(1, base * (1 + diversityBonus));
}

/**
 * 主关系(confidence 最高)是否 tagged。connectivity 排除分类索引链接(tagged 不反映
 * 认知连通度)。两端一致:client `maturity.ts isTaggedLink` / cloud `link-count-update` 复用。
 */
export function isTaggedRelation(relation: Array<{ type?: string; confidence?: number }>): boolean {
  if (!Array.isArray(relation) || relation.length === 0) return false;
  const primary = relation.reduce((best, r) => ((r.confidence ?? 0) > (best.confidence ?? 0) ? r : best), relation[0]);
  return primary?.type === 'tagged';
}

export interface MaturityWeights {
  heat: number;
  refinement: number;
  connectivity: number;
  independence: number;
}

/** 默认 maturity 权重(对齐 recall-rank 策略参数 heat/refinement/connectivity/independence)。 */
export const DEFAULT_MATURITY_WEIGHTS: MaturityWeights = {
  heat: 0.2, refinement: 0.3, connectivity: 0.3, independence: 0.2,
};

/** maturity_score 加权汇总。heat 钳到 1。权重显式可选(默认 recall-rank 参数值)。 */
export function computeMaturityScore(
  heat: number,
  refinement: number,
  connectivity: number,
  independence: number,
  weights: MaturityWeights = DEFAULT_MATURITY_WEIGHTS,
): number {
  return (
    weights.heat * Math.min(heat, 1) +
    weights.refinement * refinement +
    weights.connectivity * connectivity +
    weights.independence * independence
  );
}
