/**
 * maturity 模块集成测试
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
import { updateConnectivity, refreshMaturityScore } from '../../src/graph/maturity.js';
import { getNode } from '../../src/db/nodes.js';

describe('updateConnectivity', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupTestDb();
  });

  it('无链接节点返回 0', () => {
    const node = seedNode(db);
    const result = updateConnectivity(db, node.id);
    expect(result).toBe(0);
  });

  it('confirmed 链接计算 base = min(1, count * avgStrength / 5)', () => {
    const a = seedNode(db);
    const b = seedNode(db);
    const c = seedNode(db);
    // 2 条 confirmed，strength 都是 0.8
    seedLink(db, a.id, b.id, { strength: 0.8 });
    seedLink(db, a.id, c.id, { strength: 0.8 });

    const result = updateConnectivity(db, a.id);
    // base = min(1, 2 * 0.8 / 5) = min(1, 0.32) = 0.32
    // 1 种 relation type → diversity bonus = 0
    expect(result).toBeCloseTo(0.32, 5);
  });

  it('pending 链接不被计入', () => {
    const a = seedNode(db);
    const b = seedNode(db);
    const c = seedNode(db);
    seedLink(db, a.id, b.id, { strength: 1.0 });
    seedLink(db, a.id, c.id, { strength: 1.0, status: 'pending' });

    const result = updateConnectivity(db, a.id);
    // 只有 1 条 confirmed，base = min(1, 1*1/5) = 0.2
    expect(result).toBeCloseTo(0.2, 5);
  });

  it('多种 relation type 增加 diversity bonus', () => {
    const a = seedNode(db);
    const nodes = Array.from({ length: 3 }, () => seedNode(db));
    const relations = [
      [{ type: 'supports' as const, confidence: 0.7 }],
      [{ type: 'contradicts' as const, confidence: 0.7 }],
      [{ type: 'analogous' as const, confidence: 0.7 }],
    ];
    for (let i = 0; i < 3; i++) {
      seedLink(db, a.id, nodes[i].id, { strength: 0.8, relation: relations[i] });
    }

    const singleTypeNode = seedNode(db);
    const singleNodes = Array.from({ length: 3 }, () => seedNode(db));
    for (const n of singleNodes) {
      seedLink(db, singleTypeNode.id, n.id, { strength: 0.8, relation: [{ type: 'supports', confidence: 0.7 }] });
    }

    const multiResult = updateConnectivity(db, a.id);
    const singleResult = updateConnectivity(db, singleTypeNode.id);
    expect(multiResult).toBeGreaterThan(singleResult);
  });

  it('diversity bonus 上限 25%（6+ 种 relation type），排除 tagged', () => {
    const a = seedNode(db);
    // tagged 链接被排除于 connectivity 计算，只用语义链接
    const semanticRelations: Array<'caused_by' | 'continues' | 'contradicts' | 'analogous' | 'supports' | 'summarizes' | 'part_of'> =
      ['caused_by', 'continues', 'contradicts', 'analogous', 'supports', 'summarizes', 'part_of'];

    for (let i = 0; i < semanticRelations.length; i++) {
      const target = seedNode(db);
      seedLink(db, a.id, target.id, { strength: 0.5, relation: [{ type: semanticRelations[i], confidence: 0.7 }] });
    }
    // 再加一条 tagged 链接，不应计入 connectivity
    const tagTarget = seedNode(db);
    seedLink(db, a.id, tagTarget.id, { strength: 0.5, relation: [{ type: 'tagged', confidence: 0.9 }] });

    const result = updateConnectivity(db, a.id);
    // base = min(1, 7 * 0.5 / 5) = min(1, 0.7) = 0.7（tagged 排除，只有 7 条语义链接）
    // diversity: min(0.25, (7-1)*0.05) = min(0.25, 0.30) = 0.25
    // final = min(1, 0.7 * 1.25) = 0.875
    expect(result).toBeCloseTo(0.875, 5);

    // 验证 bonus 确实被 cap 了：用 6 种 type，bonus 也应该是 0.25
    const b = seedNode(db);
    for (let i = 0; i < 6; i++) {
      const target = seedNode(db);
      seedLink(db, b.id, target.id, { strength: 0.5, relation: [{ type: semanticRelations[i], confidence: 0.7 }] });
    }
    const result6 = updateConnectivity(db, b.id);
    // base = min(1, 6 * 0.5 / 5) = 0.6, bonus = min(0.25, 5*0.05) = 0.25
    // final = min(1, 0.6 * 1.25) = 0.75
    expect(result6).toBeCloseTo(0.75, 5);
  });

  it('结果始终在 [0, 1]', () => {
    // 大量高强度链接
    const a = seedNode(db);
    for (let i = 0; i < 20; i++) {
      const target = seedNode(db);
      seedLink(db, a.id, target.id, { strength: 1.0 });
    }
    const result = updateConnectivity(db, a.id);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(1);
  });

  it('原子更新 connectivity 和 maturity_score', () => {
    const a = seedNode(db, { heat: 0.5, refinement: 0.4, independence: 0.3 });
    const b = seedNode(db);
    seedLink(db, a.id, b.id, { strength: 1.0 });

    updateConnectivity(db, a.id);

    const updated = getNode(db, a.id)!;
    // connectivity = min(1, 1*1/5) = 0.2
    expect(updated.connectivity).toBeCloseTo(0.2, 5);
    // maturity = 0.2*min(0.5,1) + 0.3*0.4 + 0.3*0.2 + 0.2*0.3
    //          = 0.1 + 0.12 + 0.06 + 0.06 = 0.34
    expect(updated.maturity_score).toBeCloseTo(0.34, 5);
  });
});

describe('refreshMaturityScore', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupTestDb();
  });

  it('从当前节点维度正确重算 maturity_score', () => {
    const node = seedNode(db, { heat: 0.8, refinement: 0.6, independence: 0.5 });
    // 手动设 connectivity
    db.prepare('UPDATE nodes SET connectivity = 0.4 WHERE id = ?').run(node.id);

    refreshMaturityScore(db, node.id);

    const updated = getNode(db, node.id)!;
    // 0.2*min(0.8,1) + 0.3*0.6 + 0.3*0.4 + 0.2*0.5
    // = 0.16 + 0.18 + 0.12 + 0.10 = 0.56
    expect(updated.maturity_score).toBeCloseTo(0.56, 5);
  });

  it('不存在的节点不崩溃', () => {
    expect(() => refreshMaturityScore(db, 'nonexistent-id')).not.toThrow();
  });
});
