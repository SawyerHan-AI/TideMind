/**
 * nodes.ts CRUD 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mock strategy loader（在所有 import 之前） ----
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

import type Database from 'better-sqlite3';
import { setupTestDb, seedNode } from '../helpers/test-db.js';
import {
  createNode,
  getNode,
  updateNode,
  archiveNode,
  listNodes,
  getNodeCount,
  bumpHeat,
} from '../../src/db/nodes.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
});

// ===== createNode =====

describe('createNode', () => {
  it('should create a node and return it with an id', () => {
    const node = createNode(db, { type: 'fact', content: 'hello world' });
    expect(node.id).toBeTruthy();
    expect(node.content).toBe('hello world');
    expect(node.type).toBe('fact');
  });

  it('should compute maturity_score on creation', () => {
    const node = createNode(db, {
      type: 'idea',
      content: 'test maturity',
      heat: 1.0,
      refinement: 0.5,
      independence: 0.5,
    });
    // maturity = 0.2 * min(1,1) + 0.3 * 0.5 + 0.3 * 0 + 0.2 * 0.5 = 0.2 + 0.15 + 0 + 0.1 = 0.45
    expect(node.maturity_score).toBeCloseTo(0.45, 5);
  });

  it('should use default values for optional fields', () => {
    const node = createNode(db, { type: 'fact', content: 'defaults' });
    expect(node.heat).toBe(1.0);
    expect(node.refinement).toBe(0.0);
    expect(node.independence).toBe(0.0);
    expect(node.connectivity).toBe(0.0);
    expect(node.version).toBe(1);
    expect(node.archived).toBe(0);
    expect(node.is_keystone).toBe(0);
    expect(node.tags).toBeNull();
  });

  it('should store tags as JSON string', () => {
    const node = createNode(db, {
      type: 'fact',
      content: 'tagged',
      tags: ['alpha', 'beta'],
    });
    expect(node.tags).toBe(JSON.stringify(['alpha', 'beta']));
  });

  it('should set source fields when provided', () => {
    const node = createNode(db, {
      type: 'context',
      content: 'sourced',
      source_tool: 'cursor',
      source_session: 'sess-1',
    });
    expect(node.source_tool).toBe('cursor');
    expect(node.source_session).toBe('sess-1');
  });

  it('should set tags when provided', () => {
    const node = createNode(db, {
      type: 'fact',
      content: 'tagged node',
      tags: ['my-proj', 'important'],
    });
    expect(node.tags).toBe(JSON.stringify(['my-proj', 'important']));
  });
});

// ===== getNode =====

describe('getNode', () => {
  it('should return null for nonexistent id', () => {
    // better-sqlite3 .get() returns undefined when no row found
    expect(getNode(db, 'nonexistent-id')).toBeFalsy();
  });

  it('should return the correct node for a valid id', () => {
    const created = seedNode(db, { content: 'find me' });
    const found = getNode(db, created.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.content).toBe('find me');
  });
});

// ===== updateNode =====

describe('updateNode', () => {
  it('should create version history when content changes', () => {
    const node = seedNode(db, { content: 'original content' });
    updateNode(db, node.id, { content: 'updated content' }, 'test change');

    const versions = db
      .prepare('SELECT * FROM node_versions WHERE node_id = ?')
      .all(node.id) as Array<{ node_id: string; version: number; content: string; change_reason: string | null }>;
    expect(versions).toHaveLength(1);
    expect(versions[0].content).toBe('original content');
    expect(versions[0].version).toBe(1);
    expect(versions[0].change_reason).toBe('test change');

    const updated = getNode(db, node.id)!;
    expect(updated.content).toBe('updated content');
    expect(updated.version).toBe(2);
  });

  it('should not create version history for non-content changes', () => {
    const node = seedNode(db, { content: 'stable content' });
    updateNode(db, node.id, { heat: 0.7 });

    const versions = db
      .prepare('SELECT * FROM node_versions WHERE node_id = ?')
      .all(node.id);
    expect(versions).toHaveLength(0);

    const updated = getNode(db, node.id)!;
    expect(updated.heat).toBe(0.7);
    expect(updated.version).toBe(1);
  });

  it('should be a no-op for nonexistent node', () => {
    // Should not throw
    updateNode(db, 'nonexistent', { content: 'ghost' });
  });

  it('should be a no-op for empty patch', () => {
    const node = seedNode(db, { content: 'unchanged' });
    updateNode(db, node.id, {});
    const after = getNode(db, node.id)!;
    expect(after.content).toBe('unchanged');
    expect(after.version).toBe(1);
  });
});

// ===== archiveNode =====

describe('archiveNode', () => {
  it('should set archived=1 and cooldown heat to 0.02', () => {
    const node = seedNode(db);
    expect(node.heat).toBe(1.0);
    expect(node.archived).toBe(0);

    archiveNode(db, node.id);
    const after = getNode(db, node.id)!;
    expect(after.archived).toBe(1);
    expect(after.heat).toBeCloseTo(0.02);
  });

  it('should make archived node disappear from default UI filters (archived=0 gate)', () => {
    const node = seedNode(db);
    archiveNode(db, node.id);
    // listNodes 的 archived=false 过滤应该排除已归档
    const visible = listNodes(db, { archived: false });
    expect(visible.find(n => n.id === node.id)).toBeUndefined();
  });
});

// ===== bumpHeat 地板自强制 =====

describe('bumpHeat', () => {
  it('加热活跃节点', () => {
    const node = seedNode(db, { heat: 0.5 });
    bumpHeat(db, node.id, 0.3);
    expect(getNode(db, node.id)!.heat).toBeCloseTo(0.8);
  });

  // 地板自强制(2026-06-18 审计):退休节点恒为地板 heat,任何 caller 误传 superseded id
  // (如 recall node_id/index_ref 直取分支)都不会把它加热顶回去并经同步下行污染。
  it('不加热 superseded 节点(WHERE is_superseded=0 守卫)', () => {
    const node = seedNode(db, { heat: 0.5 });
    db.prepare('UPDATE nodes SET is_superseded = 1 WHERE id = ?').run(node.id);
    bumpHeat(db, node.id, 0.3);
    expect(getNode(db, node.id)!.heat).toBeCloseTo(0.5); // 未被加热
  });
});

// ===== listNodes =====

describe('listNodes', () => {
  it('should filter by type', () => {
    seedNode(db, { type: 'fact', content: 'fact-1' });
    seedNode(db, { type: 'idea', content: 'idea-1' });
    seedNode(db, { type: 'fact', content: 'fact-2' });

    const facts = listNodes(db, { type: 'fact' });
    expect(facts).toHaveLength(2);
    expect(facts.every(n => n.type === 'fact')).toBe(true);
  });

  it('should filter by type', () => {
    seedNode(db, { type: 'idea', content: 'idea-a' });
    seedNode(db, { type: 'fact', content: 'fact-b' });
    seedNode(db, { type: 'idea', content: 'idea-c' });

    const ideas = listNodes(db, { type: 'idea' });
    expect(ideas).toHaveLength(2);
    expect(ideas.every(n => n.type === 'idea')).toBe(true);
  });

  it('should filter out archived nodes', () => {
    const n1 = seedNode(db, { content: 'active' });
    const n2 = seedNode(db, { content: 'archived' });
    // 标记为归档
    db.prepare('UPDATE nodes SET archived = 1 WHERE id = ?').run(n2.id);

    const active = listNodes(db, { archived: false });
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(n1.id);
  });

  it('should support limit and offset', () => {
    for (let i = 0; i < 5; i++) {
      seedNode(db, { content: `node-${i}` });
    }
    const page = listNodes(db, { limit: 2, offset: 1 });
    expect(page).toHaveLength(2);
  });

  it('should reject invalid orderBy and fall back to created DESC', () => {
    seedNode(db, { content: 'first' });
    seedNode(db, { content: 'second' });

    // Should not throw with SQL injection attempt
    const result = listNodes(db, { orderBy: 'id; DROP TABLE nodes;--' });
    expect(result).toHaveLength(2);
  });

  it('should accept valid orderBy values', () => {
    seedNode(db, { content: 'low heat', heat: 0.1 });
    seedNode(db, { content: 'high heat', heat: 0.9 });

    const result = listNodes(db, { orderBy: 'heat DESC' });
    expect(result[0].heat).toBeGreaterThanOrEqual(result[1].heat);
  });
});

// ===== getNodeCount =====

describe('getNodeCount', () => {
  it('should count all nodes without filter', () => {
    seedNode(db);
    seedNode(db);
    seedNode(db);
    expect(getNodeCount(db)).toBe(3);
  });

  it('should count only non-archived nodes when filtered', () => {
    const n1 = seedNode(db);
    seedNode(db);
    db.prepare('UPDATE nodes SET archived = 1 WHERE id = ?').run(n1.id);

    expect(getNodeCount(db, false)).toBe(1);
  });
});

// ===== bumpHeat =====

describe('bumpHeat', () => {
  // 2026-05-19:heat 字段语义统一为 [0,1] 后,bump 上限也是 1.0。
  // 之前测试期望 1.5 / 10.0 / 1.1 是依赖旧的"钳到 10"行为(语义不一致已修)。
  it('should increase heat by delta', () => {
    const node = seedNode(db, { heat: 0.4 });
    bumpHeat(db, node.id, 0.5);
    const after = getNode(db, node.id)!;
    expect(after.heat).toBeCloseTo(0.9, 5);
  });

  it('should cap heat at 1.0', () => {
    const node = seedNode(db, { heat: 0.8 });
    bumpHeat(db, node.id, 0.5);
    const after = getNode(db, node.id)!;
    expect(after.heat).toBe(1.0);
  });

  it('should update maturity_score atomically', () => {
    const node = seedNode(db, { heat: 0.5, refinement: 0.4, independence: 0.3 });
    const before = getNode(db, node.id)!;
    bumpHeat(db, node.id, 0.3);
    const after = getNode(db, node.id)!;

    // heat went from 0.5 to 0.8; min(0.8, 1) = 0.8
    // expected maturity = 0.2 * 0.8 + 0.3 * 0.4 + 0.3 * 0 + 0.2 * 0.3 = 0.16 + 0.12 + 0 + 0.06 = 0.34
    expect(after.maturity_score).toBeCloseTo(0.34, 5);
    expect(after.maturity_score).not.toBe(before.maturity_score);
  });

  it('should use default delta of 0.1', () => {
    const node = seedNode(db, { heat: 0.5 });
    bumpHeat(db, node.id);
    const after = getNode(db, node.id)!;
    expect(after.heat).toBeCloseTo(0.6, 5);
  });
});

// ===== updated 字段语义（cloud LWW + UI watcher 用）=====
//
// 核心不变量：本地任何 nodes 修改都必须 bump `updated`，否则
// (1) cloud reconcile 把 client.updated == server.updated 视作 'same' 不同步
// (2) UI 端 data-watcher 用 MAX(updated) 检测变化，漏触发会让 UI 看到陈旧状态
// 详见 docs/work-logs/2026-05-10.md。

describe('updated field bumping', () => {
  function rawUpdated(id: string): string | null {
    return (db.prepare('SELECT updated FROM nodes WHERE id = ?').get(id) as { updated: string | null } | undefined)?.updated ?? null;
  }

  it('createNode should set updated = created on INSERT', () => {
    const node = seedNode(db, { content: 'fresh' });
    const updated = rawUpdated(node.id);
    expect(updated).not.toBeNull();
    expect(updated).toBe(node.created);
  });

  it('updateNode should advance updated on every patch', async () => {
    const node = seedNode(db, { content: 'original' });
    const before = rawUpdated(node.id)!;
    // 必须等至少 1ms，否则同毫秒内 ISO 字符串相同
    await new Promise(r => setTimeout(r, 5));
    updateNode(db, node.id, { heat: 0.7 });
    const after = rawUpdated(node.id)!;
    expect(after > before).toBe(true);
  });

  it('updateNode should bump updated even for non-content changes', async () => {
    const node = seedNode(db, { refinement: 0.0 });
    const before = rawUpdated(node.id)!;
    await new Promise(r => setTimeout(r, 5));
    // 模拟 annotate 完成的 patch（仅改维度 / refinement）
    updateNode(db, node.id, { refinement: 0.1, specificity: 0.8, subjectivity: 0.2, actuality: 0.9 });
    const after = rawUpdated(node.id)!;
    expect(after > before).toBe(true);
  });

  it('updateNode no-op (empty patch) should NOT change updated', async () => {
    const node = seedNode(db, { content: 'stable' });
    const before = rawUpdated(node.id)!;
    await new Promise(r => setTimeout(r, 5));
    updateNode(db, node.id, {});
    const after = rawUpdated(node.id)!;
    expect(after).toBe(before);
  });

  it('updateNode for nonexistent node should NOT throw or write', () => {
    // 守卫：早 return false，不留下幽灵更新痕迹
    expect(() => updateNode(db, 'nonexistent-id', { heat: 5 })).not.toThrow();
  });

  it('bumpHeat should advance updated', async () => {
    const node = seedNode(db, { heat: 1.0 });
    const before = rawUpdated(node.id)!;
    await new Promise(r => setTimeout(r, 5));
    bumpHeat(db, node.id, 0.3);
    const after = rawUpdated(node.id)!;
    expect(after > before).toBe(true);
  });

  it('archiveNode should advance updated', async () => {
    const node = seedNode(db);
    const before = rawUpdated(node.id)!;
    await new Promise(r => setTimeout(r, 5));
    archiveNode(db, node.id);
    const after = rawUpdated(node.id)!;
    expect(after > before).toBe(true);
  });
});
