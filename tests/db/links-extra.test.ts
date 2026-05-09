/**
 * links.ts 补充测试 —— 覆盖 parseRelations / createLink / getLinksForNodes / getPendingLinks / getLinkCount
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
import { setupTestDb, seedNode, seedLink } from '../helpers/test-db.js';
import {
  parseRelations,
  createLink,
  getLinksForNodes,
  getPendingLinks,
  getLinkCount,
} from '../../src/db/links.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
});

// ===== parseRelations =====

describe('parseRelations', () => {
  it('合法 JSON 数组正常解析', () => {
    const input = JSON.stringify([{ type: 'supports', confidence: 0.8 }]);
    const result = parseRelations(input);
    expect(result).toEqual([{ type: 'supports', confidence: 0.8 }]);
  });

  it('旧格式 JSON 单字符串兼容', () => {
    // JSON.parse('"supports"') => "supports"
    const result = parseRelations('"supports"');
    expect(result).toEqual([{ type: 'supports', confidence: 0.7 }]);
  });

  it('旧格式纯字符串（非 JSON）一律返回空数组', () => {
    // 2026-05-09 起取消"把垃圾字符串当 RelationType"的兼容路径,避免下游
    // switch 静默走默认分支(M8)。损坏行返回 [] 让上游清楚识别。
    const result = parseRelations('supports');
    expect(result).toEqual([]);
  });

  it('非法 JSON 且以 [ 开头返回空数组', () => {
    expect(parseRelations('[broken')).toEqual([]);
  });

  it('非法 JSON 非 [ 开头返回空数组', () => {
    // 同上 M8:不再做"垃圾值当 RelationType"的兼容
    expect(parseRelations('{broken')).toEqual([]);
  });

  it('空数组返回空数组', () => {
    expect(parseRelations('[]')).toEqual([]);
  });

  it('数组中缺少 type 的元素被过滤', () => {
    const input = JSON.stringify([
      { type: 'supports', confidence: 0.8 },
      { confidence: 0.5 }, // 缺少 type
    ]);
    const result = parseRelations(input);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('supports');
  });

  it('数组中缺少 confidence 的元素被过滤', () => {
    const input = JSON.stringify([
      { type: 'supports', confidence: 0.8 },
      { type: 'contradicts' }, // 缺少 confidence
    ]);
    const result = parseRelations(input);
    expect(result).toHaveLength(1);
  });

  it('数组中 null 元素被过滤', () => {
    const input = JSON.stringify([
      null,
      { type: 'supports', confidence: 0.9 },
    ]);
    const result = parseRelations(input);
    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBe(0.9);
  });
});

// ===== createLink 补充 =====

describe('createLink 补充', () => {
  it('自环链接返回 null', () => {
    const a = seedNode(db);
    const link = createLink(db, {
      from_id: a.id,
      to_id: a.id,
      relation: [{ type: 'supports', confidence: 0.7 }],
    });
    expect(link).toBeNull();
  });

  it('auto 参数默认为 true (1)', () => {
    const a = seedNode(db);
    const b = seedNode(db);
    const link = createLink(db, {
      from_id: a.id,
      to_id: b.id,
      relation: [{ type: 'supports', confidence: 0.7 }],
    });
    expect(link).not.toBeNull();
    expect(link!.auto).toBe(1);
  });

  it('auto 显式设为 false 时为 0', () => {
    const a = seedNode(db);
    const b = seedNode(db);
    const link = createLink(db, {
      from_id: a.id,
      to_id: b.id,
      relation: [{ type: 'supports', confidence: 0.7 }],
      auto: false,
    });
    expect(link!.auto).toBe(0);
  });
});

// ===== getLinksForNodes =====

describe('getLinksForNodes', () => {
  it('空 nodeIds 返回空数组', () => {
    const result = getLinksForNodes(db, []);
    expect(result).toEqual([]);
  });

  it('正确过滤 minStrength', () => {
    const a = seedNode(db);
    const b = seedNode(db);
    const c = seedNode(db);
    seedLink(db, a.id, b.id, { strength: 0.3 });
    seedLink(db, a.id, c.id, { strength: 0.8 });

    const strong = getLinksForNodes(db, [a.id], { minStrength: 0.5 });
    expect(strong).toHaveLength(1);
    expect(strong[0].strength).toBe(0.8);
  });

  it('正确过滤 status', () => {
    const a = seedNode(db);
    const b = seedNode(db);
    const c = seedNode(db);
    seedLink(db, a.id, b.id, { status: 'confirmed' });
    seedLink(db, a.id, c.id, { status: 'pending' });

    const confirmed = getLinksForNodes(db, [a.id], { statusFilter: 'confirmed' });
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].status).toBe('confirmed');

    const pending = getLinksForNodes(db, [a.id], { statusFilter: 'pending' });
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe('pending');
  });

  it('返回双向关联的链接', () => {
    const a = seedNode(db);
    const b = seedNode(db);
    const c = seedNode(db);
    seedLink(db, a.id, b.id); // a -> b
    seedLink(db, c.id, a.id); // c -> a

    const links = getLinksForNodes(db, [a.id]);
    expect(links).toHaveLength(2);
  });
});

// ===== getPendingLinks =====

describe('getPendingLinks 补充', () => {
  it('无 pending 链接时返回空数组', () => {
    expect(getPendingLinks(db)).toEqual([]);
  });

  it('limit 参数生效', () => {
    const nodes = Array.from({ length: 4 }, () => seedNode(db));
    seedLink(db, nodes[0].id, nodes[1].id, { status: 'pending' });
    seedLink(db, nodes[0].id, nodes[2].id, { status: 'pending' });
    seedLink(db, nodes[0].id, nodes[3].id, { status: 'pending' });

    const limited = getPendingLinks(db, 2);
    expect(limited).toHaveLength(2);
    expect(limited.every(l => l.status === 'pending')).toBe(true);
  });

  it('不返回 confirmed 链接', () => {
    const a = seedNode(db);
    const b = seedNode(db);
    const c = seedNode(db);
    seedLink(db, a.id, b.id, { status: 'confirmed' });
    seedLink(db, a.id, c.id, { status: 'pending' });

    const pending = getPendingLinks(db);
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe('pending');
  });
});

// ===== getLinkCount =====

describe('getLinkCount 补充', () => {
  it('无链接时返回 0', () => {
    expect(getLinkCount(db)).toBe(0);
  });

  it('只计数 confirmed 链接', () => {
    const a = seedNode(db);
    const b = seedNode(db);
    const c = seedNode(db);
    seedLink(db, a.id, b.id, { status: 'confirmed' });
    seedLink(db, a.id, c.id, { status: 'pending' });
    seedLink(db, b.id, c.id, { status: 'confirmed' });

    expect(getLinkCount(db)).toBe(2);
  });
});
