import type Database from 'better-sqlite3';
import type { GateStatus } from '../types.js';
import { getNodeCount, parseTags } from './nodes.js';
import { getLinkCount } from './links.js';
import { getRecallCount } from './log.js';
import { getConfig } from '../config.js';
import { getParam } from '../strategy/loader.js';

let cachedGates: GateStatus | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 60_000; // 60 秒缓存

/**
 * 读取门控阈值：策略文件参数优先，config.toml 作为 fallback。
 */
function getGateThreshold(strategyName: string, paramName: string, configFallback: number): number {
  return getParam(strategyName, paramName, configFallback);
}

export function getGateStatus(db: Database.Database): GateStatus {
  const elapsed = Date.now() - cacheTime;
  if (cachedGates && elapsed < CACHE_TTL_MS) {
    return cachedGates;
  }

  const config = getConfig();
  const nodeCount = getNodeCount(db, false);
  const linkCount = getLinkCount(db);
  const recallCount = getRecallCount(db);

  cachedGates = {
    node_count: nodeCount,
    link_count: linkCount,
    recall_count: recallCount,
    features: {
      basic_digest: true,
      bm25_search: true,
      vector_search: nodeCount >= getGateThreshold('recall-search', 'gate_min_nodes', config.gates.vector_search),
      graph_expansion: nodeCount >= getGateThreshold('recall-search', 'gate_expansion_min_nodes', config.gates.graph_expansion)
        && linkCount >= getGateThreshold('recall-search', 'gate_expansion_min_links', config.gates.graph_expansion_links),
      crystal_generation: nodeCount >= getGateThreshold('crystal-emerge', 'gate_min_nodes', config.gates.crystal_generation),
      divergent_scan: nodeCount >= getGateThreshold('scan-divergent', 'gate_min_nodes', config.gates.divergent_scan),
    },
  };
  cacheTime = Date.now();

  return cachedGates;
}

export function invalidateGateCache(): void {
  cachedGates = null;
  cacheTime = 0;
  cachedVocab = null;
  vocabCacheTime = 0;
}

// ============================================================
// 图谱词汇表 — 为 LLM 调用提供一致性上下文
// ============================================================

export interface GraphVocabulary {
  /** 核心标签（is_tag=1 的活跃节点） */
  coreTags: string[];
  /** 高频标签（top 50，按频率降序） */
  tags: string[];
  /** 已有结晶摘要（top 10） */
  crystalSummaries: string[];
}

let cachedVocab: GraphVocabulary | null = null;
let vocabCacheTime = 0;
const VOCAB_CACHE_TTL_MS = 120_000; // 2 分钟缓存

export function getGraphVocabulary(db: Database.Database): GraphVocabulary {
  const elapsed = Date.now() - vocabCacheTime;
  if (cachedVocab && elapsed < VOCAB_CACHE_TTL_MS) return cachedVocab;

  // 核心标签（is_tag=1 的活跃节点）
  const coreTags = (db.prepare(`
    SELECT content FROM nodes WHERE is_tag = 1 AND heat > 0.01 AND is_superseded = 0 AND archived = 0
  `).all() as Array<{ content: string }>).map(r => r.content);

  // 高频标签（解析 JSON 数组后统计）
  // Note: SQLite json_each would be more efficient but requires SQLite 3.38+.
  // Using JS-side aggregation for compatibility.
  const tagRows = db.prepare(`
    SELECT tags FROM nodes WHERE tags IS NOT NULL AND heat > 0.01 AND is_superseded = 0 AND archived = 0
  `).all() as Array<{ tags: string }>;
  const tagCounter = new Map<string, number>();
  for (const row of tagRows) {
    for (const tag of parseTags(row.tags)) {
      tagCounter.set(tag, (tagCounter.get(tag) ?? 0) + 1);
    }
  }
  const tags = [...tagCounter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50)
    .map(([tag]) => tag);

  // 已有结晶摘要
  const crystalSummaries = (db.prepare(`
    SELECT content FROM nodes WHERE is_crystal = 1 AND heat > 0.01 AND is_superseded = 0 AND archived = 0 ORDER BY heat DESC LIMIT 10
  `).all() as Array<{ content: string }>).map(r => r.content.slice(0, 120));

  cachedVocab = { coreTags, tags, crystalSummaries };
  vocabCacheTime = Date.now();
  return cachedVocab;
}
