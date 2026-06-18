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

    // M10:GC 改软删,过期 pending 行仍在但 deleted=1。存活集 = deleted=0。
    const remaining = db.prepare('SELECT id FROM links WHERE deleted = 0 ORDER BY created').all() as Array<{ id: string }>;
    const remainingIds = remaining.map(r => r.id);
    expect(remainingIds).toContain(freshPending!.id);
    expect(remainingIds).toContain(oldConfirmed!.id);
    expect(remainingIds).not.toContain(expiredPending!.id);
    // 物理行仍在(软删),且确实被标记 deleted=1
    const exp = db.prepare('SELECT deleted FROM links WHERE id = ?').get(expiredPending!.id) as { deleted: number };
    expect(exp.deleted).toBe(1);
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

    // M10:软删后存活 pending = status='pending' AND deleted=0(被软删的 2 条仍是 pending 状态但 deleted=1)
    const remaining = db.prepare("SELECT COUNT(*) as cnt FROM links WHERE status='pending' AND deleted = 0").get() as { cnt: number };
    expect(remaining.cnt).toBe(3);
  });

  it('空表时返回 deleted=0，不触发副作用', () => {
    const result = runPendingLinkGc(db);
    expect(result.deleted).toBe(0);
  });

  // 回归 F2(2026-05-21): pending-link-gc 原先用 datetime('now', '-N days') 字符串对比
  // JS ISO 'YYYY-MM-DDTHH:MM:SS.sssZ' 的 created 列。
  // 同日比较时 ISO 在位置 10 是 'T'(0x54),datetime 是 ' '(0x20),字典序 ISO > datetime。
  // 这意味着对于刚过期(7d + 1h 前)的 pending,字典序对比 created < cutoff = false →
  // 应删却漏删。
  //
  // 验证:7d+1h 前的 pending,旧 SQL 漏删(回归保护),新 SQL 正确删除。
  it('F2 回归: 刚过期(7d + 1h 前)的 pending 必须被正确判定为过期', () => {
    const nodeA = seedNode(db, { content: 'A' });
    const nodeB = seedNode(db, { content: 'B' });

    // 创建一个 pending 链接,把 created 设为 7天 + 1小时前(应删)
    const link = seedLink(db, nodeA.id, nodeB.id, { status: 'pending', auto: true });
    const justPastIso = new Date(Date.now() - (7 * 24 + 1) * 3600_000).toISOString();
    db.prepare('UPDATE links SET created = ? WHERE id = ?').run(justPastIso, link!.id);

    // 旧路径(字典序错判):ISO created 在位置 10 是 'T',cutoff 是 ' ',
    // ISO > cutoff at same date → "created < cutoff" 返回 false → 漏删
    const oldPath = db.prepare(
      `SELECT id FROM links WHERE status='pending' AND created < datetime('now', '-7 days')`,
    ).all() as Array<{ id: string }>;

    // 新路径(ISO vs ISO 字典序 = 时间序):正确判定为过期
    const isoCutoff = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    const newPath = db.prepare(
      `SELECT id FROM links WHERE status='pending' AND created < ?`,
    ).all(isoCutoff) as Array<{ id: string }>;

    // 回归保护:旧路径漏掉这条本应过期的链接
    expect(oldPath.map(r => r.id)).not.toContain(link!.id);
    // 新路径正确判定为过期
    expect(newPath.map(r => r.id)).toContain(link!.id);

    // runPendingLinkGc 自身行为:必须(软)删除这条过期 pending
    const result = runPendingLinkGc(db);
    expect(result.deleted).toBe(1);

    // M10:软删 —— 行仍在(deleted=1),但从存活集(deleted=0)排除
    const active = db.prepare('SELECT COUNT(*) as cnt FROM links WHERE id = ? AND deleted = 0')
      .get(link!.id) as { cnt: number };
    expect(active.cnt).toBe(0);
    const row = db.prepare('SELECT deleted FROM links WHERE id = ?').get(link!.id) as { deleted: number };
    expect(row.deleted).toBe(1);
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
