/**
 * expansion 模块集成测试
 *
 * 使用真实内存数据库 + mock strategy loader。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';

// ---- Mock strategy loader ----
vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, param: string, fallback: number) => {
    const defaults: Record<string, number> = {
      heat_weight: 0.2,
      refinement_weight: 0.3,
      connectivity_weight: 0.3,
      independence_weight: 0.2,
    };
    return defaults[param] ?? fallback;
  },
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

import { setupTestDb, seedNode, seedLink } from '../helpers/test-db.js';
import { expandFromNode } from '../../src/graph/expansion.js';
import { archiveNode } from '../../src/db/nodes.js';

describe('expandFromNode', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupTestDb();
  });

  // 构建测试图: A → B, A → C, B → D, B → E
  function buildTestGraph() {
    const A = seedNode(db, { content: 'node A' });
    const B = seedNode(db, { content: 'node B' });
    const C = seedNode(db, { content: 'node C' });
    const D = seedNode(db, { content: 'node D' });
    const E = seedNode(db, { content: 'node E' });

    seedLink(db, A.id, B.id, { strength: 0.8 });
    seedLink(db, A.id, C.id, { strength: 0.8 });
    seedLink(db, B.id, D.id, { strength: 0.8 });
    seedLink(db, B.id, E.id, { strength: 0.8 });

    return { A, B, C, D, E };
  }

  it('depth=1 只返回直接邻居', () => {
    const { A, B, C } = buildTestGraph();
    const result = expandFromNode(db, A.id, { depth: 1 });
    const ids = result.map(n => n.id);
    expect(ids).toContain(B.id);
    expect(ids).toContain(C.id);
    expect(ids).toHaveLength(2);
  });

  it('depth=2 返回 2 跳邻居', () => {
    const { A, B, C, D, E } = buildTestGraph();
    const result = expandFromNode(db, A.id, { depth: 2 });
    const ids = result.map(n => n.id);
    expect(ids).toContain(B.id);
    expect(ids).toContain(C.id);
    expect(ids).toContain(D.id);
    expect(ids).toContain(E.id);
    expect(ids).toHaveLength(4);
  });

  it('排除极低 heat 节点', () => {
    const { A, B, C } = buildTestGraph();
    // 模拟 cooldown（替代旧的 archive）
    db.prepare('UPDATE nodes SET heat = 0.005 WHERE id = ?').run(B.id);

    const result = expandFromNode(db, A.id, { depth: 2 });
    const ids = result.map(n => n.id);
    expect(ids).not.toContain(B.id);
    // B heat 太低被排除，所以 D、E 也不可达
    expect(ids).toContain(C.id);
  });

  it('排除 pending 链接（只跟随 confirmed）', () => {
    const A = seedNode(db, { content: 'A' });
    const B = seedNode(db, { content: 'B' });
    const C = seedNode(db, { content: 'C' });
    seedLink(db, A.id, B.id, { strength: 0.8, status: 'confirmed' });
    seedLink(db, A.id, C.id, { strength: 0.8, status: 'pending' });

    const result = expandFromNode(db, A.id, { depth: 1 });
    const ids = result.map(n => n.id);
    expect(ids).toContain(B.id);
    expect(ids).not.toContain(C.id);
  });

  it('排除 strength 低于 minStrength（默认 0.5）的链接', () => {
    const A = seedNode(db, { content: 'A' });
    const B = seedNode(db, { content: 'B' });
    const C = seedNode(db, { content: 'C' });
    seedLink(db, A.id, B.id, { strength: 0.6 });
    seedLink(db, A.id, C.id, { strength: 0.3 });

    const result = expandFromNode(db, A.id, { depth: 1 });
    const ids = result.map(n => n.id);
    expect(ids).toContain(B.id);
    expect(ids).not.toContain(C.id);
  });

  it('creative intent 将 minStrength 降至 0.3', () => {
    const A = seedNode(db, { content: 'A' });
    const B = seedNode(db, { content: 'B' });
    const C = seedNode(db, { content: 'C' });
    seedLink(db, A.id, B.id, { strength: 0.4 });
    seedLink(db, A.id, C.id, { strength: 0.2 });

    const result = expandFromNode(db, A.id, { depth: 1, intent: 'creative' });
    const ids = result.map(n => n.id);
    // 0.4 >= 0.3 → included
    expect(ids).toContain(B.id);
    // 0.2 < 0.3 → excluded
    expect(ids).not.toContain(C.id);
  });

  it('遵守 maxNodes 限制', () => {
    const A = seedNode(db, { content: 'A' });
    for (let i = 0; i < 10; i++) {
      const target = seedNode(db, { content: `N${i}` });
      seedLink(db, A.id, target.id, { strength: 0.8 });
    }

    const result = expandFromNode(db, A.id, { depth: 1, maxNodes: 3 });
    expect(result).toHaveLength(3);
  });

  it('起始节点不包含在结果中', () => {
    const { A } = buildTestGraph();
    const result = expandFromNode(db, A.id, { depth: 2 });
    const ids = result.map(n => n.id);
    expect(ids).not.toContain(A.id);
  });

  it('处理环路：A→B→C→A，无死循环无重复', () => {
    const A = seedNode(db, { content: 'A' });
    const B = seedNode(db, { content: 'B' });
    const C = seedNode(db, { content: 'C' });
    seedLink(db, A.id, B.id, { strength: 0.8 });
    seedLink(db, B.id, C.id, { strength: 0.8 });
    seedLink(db, C.id, A.id, { strength: 0.8 });

    const result = expandFromNode(db, A.id, { depth: 5 });
    const ids = result.map(n => n.id);
    // 应包含 B 和 C，无重复
    expect(ids).toContain(B.id);
    expect(ids).toContain(C.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(A.id);
  });

  it('孤立节点（无链接）返回空数组', () => {
    const A = seedNode(db, { content: 'isolated' });
    const result = expandFromNode(db, A.id, { depth: 3 });
    expect(result).toHaveLength(0);
  });

  it('creative intent 下 analogous 关系链接优先排序', () => {
    const A = seedNode(db, { content: 'A' });
    const analogousTarget = seedNode(db, { content: 'analogous-target' });
    const causalTarget = seedNode(db, { content: 'causal-target' });
    const plainTarget = seedNode(db, { content: 'plain-target' });

    seedLink(db, A.id, plainTarget.id, { strength: 0.8, relation: [{ type: 'tagged', confidence: 0.7 }] });
    seedLink(db, A.id, causalTarget.id, { strength: 0.8, relation: [{ type: 'caused_by', confidence: 0.7 }] });
    seedLink(db, A.id, analogousTarget.id, { strength: 0.8, relation: [{ type: 'analogous', confidence: 0.7 }] });

    // maxNodes=2 时 creative 应优先 icon，然后 symbol/index
    const result = expandFromNode(db, A.id, {
      depth: 1,
      maxNodes: 2,
      intent: 'creative',
    });
    const ids = result.map(n => n.id);
    // analogous 应该排第一
    expect(ids[0]).toBe(analogousTarget.id);
    // caused_by 排第二
    expect(ids[1]).toBe(causalTarget.id);
  });

  it('depth=0 返回空数组', () => {
    const { A } = buildTestGraph();
    const result = expandFromNode(db, A.id, { depth: 0 });
    expect(result).toHaveLength(0);
  });
});
