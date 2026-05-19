/**
 * pending-link-gc 任务测试
 *
 * 覆盖：
 *  - runPendingLinkGc 按 created 时间删除过期 pending（不动 confirmed / 不动新 pending）
 *  - gc_max_per_run 限速生效
 *  - pendingLinkGcGate 的健康度门控逻辑
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 测试可调整的参数表。默认与策略文件一致。
const TEST_PARAMS: Record<string, number> = {
  pending_expire_days: 7,
  gc_max_per_run: 2000,
  gc_health_window_ratio: 0.5,
};

vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, paramName: string, fallback: number) => {
    return paramName in TEST_PARAMS ? TEST_PARAMS[paramName] : fallback;
  },
}));

import type Database from 'better-sqlite3';
import { setupTestDb, seedNode, seedLink } from '../helpers/test-db.js';
import { runPendingLinkGc, pendingLinkGcGate } from '../../src/metabolism/pending-link-gc.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
  vi.clearAllMocks();
  // 还原默认参数
  TEST_PARAMS.pending_expire_days = 7;
  TEST_PARAMS.gc_max_per_run = 2000;
  TEST_PARAMS.gc_health_window_ratio = 0.5;
});

function setLinkCreated(db: Database.Database, linkId: string, daysAgo: number): void {
  const ts = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('UPDATE links SET created = ? WHERE id = ?').run(ts, linkId);
}

describe('runPendingLinkGc', () => {
  it('过期 pending 被删除；新 pending + confirmed 保留', () => {
    const nodeA = seedNode(db, { content: 'A' });
    const nodeB = seedNode(db, { content: 'B' });
    const nodeC = seedNode(db, { content: 'C' });

    // 10 天前的 pending → 应删
    const expiredPending = seedLink(db, nodeA.id, nodeB.id, { status: 'pending', auto: true });
    setLinkCreated(db, expiredPending!.id, 10);

    // 1 天前的 pending → 应保留
    const freshPending = seedLink(db, nodeA.id, nodeC.id, { status: 'pending', auto: true });
    setLinkCreated(db, freshPending!.id, 1);

    // 10 天前但已 confirmed → 应保留（GC 只清 pending）
    const oldConfirmed = seedLink(db, nodeB.id, nodeC.id, { status: 'confirmed', auto: true });
    setLinkCreated(db, oldConfirmed!.id, 10);

    const result = runPendingLinkGc(db);
    expect(result.deleted).toBe(1);

    const remaining = db.prepare('SELECT id FROM links ORDER BY created').all() as Array<{ id: string }>;
    const remainingIds = remaining.map(r => r.id);
    expect(remainingIds).toContain(freshPending!.id);
    expect(remainingIds).toContain(oldConfirmed!.id);
    expect(remainingIds).not.toContain(expiredPending!.id);
  });

  it('gc_max_per_run 限速生效：插入 5 条过期 + max=2 → 只删 2', () => {
    TEST_PARAMS.gc_max_per_run = 2;

    const nodes = Array.from({ length: 6 }).map((_, i) => seedNode(db, { content: `n${i}` }));
    const links = [];
    for (let i = 0; i < 5; i++) {
      const l = seedLink(db, nodes[0].id, nodes[i + 1].id, { status: 'pending', auto: true });
      setLinkCreated(db, l!.id, 10); // 全部 10 天前
      links.push(l!);
    }

    const result = runPendingLinkGc(db);
    expect(result.deleted).toBe(2);

    const remaining = db.prepare("SELECT COUNT(*) as cnt FROM links WHERE status='pending'").get() as { cnt: number };
    expect(remaining.cnt).toBe(3);
  });

  it('空表时返回 deleted=0，不触发副作用', () => {
    const result = runPendingLinkGc(db);
    expect(result.deleted).toBe(0);
  });
});

describe('pendingLinkGcGate', () => {
  function setMetadata(key: string, value: string): void {
    db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(key, value);
  }

  it('从未成功调过 LLM → false', () => {
    expect(pendingLinkGcGate(db)).toBe(false);
  });

  it('value 非数字 → false', () => {
    setMetadata('llm_last_success_at', 'not-a-number');
    expect(pendingLinkGcGate(db)).toBe(false);
  });

  it('LLM 最近 1h 成功过（远 < 7 × 0.5 = 3.5 天阈值）→ true', () => {
    setMetadata('llm_last_success_at', String(Date.now() - 60 * 60 * 1000));
    expect(pendingLinkGcGate(db)).toBe(true);
  });

  it('LLM 最近 5 天成功（> 3.5 天阈值）→ false', () => {
    setMetadata('llm_last_success_at', String(Date.now() - 5 * 24 * 60 * 60 * 1000));
    expect(pendingLinkGcGate(db)).toBe(false);
  });

  it('value 为 0（哨兵值，从未成功）→ false', () => {
    setMetadata('llm_last_success_at', '0');
    expect(pendingLinkGcGate(db)).toBe(false);
  });
});
