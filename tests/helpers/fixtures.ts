/**
 * 测试数据工厂（不入库，用于纯函数测试）
 */
import type { BrainNode, BrainLink } from '../../src/types.js';

let counter = 0;

export function makeNode(overrides: Partial<BrainNode> = {}): BrainNode {
  counter++;
  return {
    id: overrides.id ?? `node-${counter}`,
    type: overrides.type ?? 'fact',
    content: overrides.content ?? `test content ${counter}`,
    heat: overrides.heat ?? 1.0,
    refinement: overrides.refinement ?? 0.0,
    connectivity: overrides.connectivity ?? 0.0,
    independence: overrides.independence ?? 0.0,
    specificity: overrides.specificity ?? 0.5,
    subjectivity: overrides.subjectivity ?? 0.5,
    actuality: overrides.actuality ?? 0.5,
    source_tool: overrides.source_tool ?? null,
    source_session: overrides.source_session ?? null,
    source_stream: overrides.source_stream ?? null,
    source_timestamp: overrides.source_timestamp ?? null,
    tags: overrides.tags ?? null,
    created: overrides.created ?? new Date().toISOString(),
    last_reconsolidated: overrides.last_reconsolidated ?? null,
    version: overrides.version ?? 1,
    archived: overrides.archived ?? 0,
    is_keystone: overrides.is_keystone ?? 0,
    is_crystal: overrides.is_crystal ?? 0,
    is_tag: overrides.is_tag ?? 0,
    is_meta: overrides.is_meta ?? 0,
    maturity_score: overrides.maturity_score ?? 0.2,
  };
}

export function makeLink(overrides: Partial<BrainLink> = {}): BrainLink {
  counter++;
  return {
    id: overrides.id ?? `link-${counter}`,
    from_id: overrides.from_id ?? `node-from-${counter}`,
    to_id: overrides.to_id ?? `node-to-${counter}`,
    relation: overrides.relation ?? [{ type: 'supports', confidence: 0.7 }],
    strength: overrides.strength ?? 0.5,
    note: overrides.note ?? null,
    auto: overrides.auto ?? 1,
    status: overrides.status ?? 'confirmed',
    created: overrides.created ?? new Date().toISOString(),
  };
}

export function makeFakeEmbedding(seed: number = 1): Float32Array {
  const arr = new Float32Array(3072);
  for (let i = 0; i < 3072; i++) {
    arr[i] = Math.sin(seed * (i + 1)) * 0.5;
  }
  // 归一化
  let norm = 0;
  for (let i = 0; i < 3072; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < 3072; i++) arr[i] /= norm;
  return arr;
}
