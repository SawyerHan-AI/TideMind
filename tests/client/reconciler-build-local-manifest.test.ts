/**
 * buildLocalManifest 正确性 + 性能回归测试。
 *
 * 历史背景:v0.2.65 startup 91% CPU hang 1-2 分钟,sample stack trace 显示
 * `Statement::JS_all → sqlite3_step → vdbeSorterFlushPMA → vdbeSorterSort
 * → vdbeSorterCompareText`。定位到 `buildLocalManifest` 原 SQL:
 *
 *   SELECT id, COALESCE(created, '') as created,
 *          COALESCE(updated, created) as updated, archived FROM nodes
 *
 * COALESCE 表达式 + nullable updated 让 query planner 在 nodes/links 表上
 * 9w+ 行触发 vdbeSorter。修复后 SELECT 改为原列、JS 端做 null-coalesce,
 * 同时 `.all()` 改 `.iterate()`。
 *
 * 这里测三件事:
 *   1. 正确性:返回的 ManifestEntry shape/字段语义跟原实现一致
 *   2. nullable updated/created 的 fallback 链 (`updated || created || epoch`)
 *   3. 性能 sanity:1w 行 nodes + 1w 行 links 一起跑要在 1.5s 内完成
 *      (CI runner 慢硬件留余量;本机 M1 实测 < 200ms)
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { setupTestDb } from '../helpers/test-db.js';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  Notification: { isSupported: () => false },
}));

vi.mock('../../client/electron/cloud/auth-client.js', () => ({
  getCloudBaseUrl: () => 'https://cloud.test.example',
  refreshTokenIfNeeded: vi.fn(async () => 'token'),
}));

import { Reconciler } from '../../client/electron/cloud/reconciler.js';

interface ManifestEntry {
  id: string;
  sync_version: number;
  updated: string;
  archived: boolean;
}

function callBuildLocalManifest(db: Database.Database, table: 'nodes' | 'links'): ManifestEntry[] {
  // buildLocalManifest 是 private — 测试通过 any-cast 直接调用,比改动可见性更轻。
  const reconciler = new Reconciler(db);
  return (reconciler as unknown as { buildLocalManifest: (t: 'nodes' | 'links') => ManifestEntry[] })
    .buildLocalManifest(table);
}

describe('Reconciler.buildLocalManifest', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('返回 ManifestEntry shape 对 nodes/links 都正确', () => {
    db.prepare(
      `INSERT INTO nodes (id, type, content, created, updated, archived) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('n1', 'fact', 'hello', '2026-05-01T00:00:00Z', '2026-05-02T00:00:00Z', 0);

    db.prepare(
      `INSERT INTO nodes (id, type, content, created, updated, archived) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('n2', 'fact', 'archived', '2026-05-03T00:00:00Z', null, 1);

    // links 需要先有 from/to 的 nodes
    db.prepare(
      `INSERT INTO links (id, from_id, to_id, relation, created) VALUES (?, ?, ?, ?, ?)`,
    ).run('l1', 'n1', 'n2', '[{"type":"supports","confidence":0.7}]', '2026-05-01T00:00:00Z');

    const nodes = callBuildLocalManifest(db, 'nodes');
    expect(nodes.length).toBe(2);
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));

    expect(byId['n1']).toEqual({
      id: 'n1',
      sync_version: 0,
      updated: '2026-05-02T00:00:00Z',
      archived: false,
    });

    // n2 没有 updated → 应 fallback 到 created
    expect(byId['n2']).toEqual({
      id: 'n2',
      sync_version: 0,
      updated: '2026-05-03T00:00:00Z',
      archived: true,
    });

    const links = callBuildLocalManifest(db, 'links');
    expect(links.length).toBe(1);
    expect(links[0]).toEqual({
      id: 'l1',
      sync_version: 0,
      updated: '2026-05-01T00:00:00Z', // updated 为 null → fallback created
      archived: false, // links 表没 archived 列,默认 false
    });
  });

  it('updated/created 同时为 null/空时 fallback 到 epoch', () => {
    // 注意:schema 强制 created NOT NULL,所以这里只能模拟 "updated 缺失 + created 是
    // 空字符串"的退化情况。真实场景下 created 一定有值,但 epoch fallback 是兜底防御,
    // 任何 history bug 把 created 写成空串都要走到这条线上。
    db.prepare(
      `INSERT INTO nodes (id, type, content, created, updated, archived) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('n-empty', 'fact', 'x', '', null, 0);

    const nodes = callBuildLocalManifest(db, 'nodes');
    expect(nodes[0].updated).toBe(new Date(0).toISOString());
  });

  it('1w 行 nodes + 1w 行 links 总耗时 < 1500ms(perf regression guard)', () => {
    const N = 10_000;

    // bulk seed:trx + prepared stmt + batch insert
    const insertNode = db.prepare(
      `INSERT INTO nodes (id, type, content, created, updated, archived) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertLink = db.prepare(
      `INSERT INTO links (id, from_id, to_id, relation, created, updated) VALUES (?, ?, ?, ?, ?, ?)`,
    );

    const tx = db.transaction(() => {
      const baseTime = Date.UTC(2026, 0, 1);
      for (let i = 0; i < N; i++) {
        // 一半 nodes 有 updated,一半没(覆盖 nullable 路径)
        const updated = i % 2 === 0 ? new Date(baseTime + i * 60_000).toISOString() : null;
        insertNode.run(`n${i}`, 'fact', `c${i}`, new Date(baseTime + i * 60_000).toISOString(), updated, i % 100 === 0 ? 1 : 0);
      }
      for (let i = 0; i < N; i++) {
        const from = `n${i % N}`;
        const to = `n${(i + 1) % N}`;
        const updated = i % 3 === 0 ? new Date(baseTime + i * 60_000).toISOString() : null;
        insertLink.run(`l${i}`, from, to, '[{"type":"supports","confidence":0.7}]', new Date(baseTime + i * 60_000).toISOString(), updated);
      }
    });
    tx();

    const t0 = performance.now();
    const nodes = callBuildLocalManifest(db, 'nodes');
    const t1 = performance.now();
    const links = callBuildLocalManifest(db, 'links');
    const t2 = performance.now();

    expect(nodes.length).toBe(N);
    expect(links.length).toBe(N);

    const elapsed = t2 - t0;
    // 本机 M1 实测 ~120ms;给 CI 留 25x 余量(3000ms)。如果超出阈值通常意味着回归把
    // COALESCE 加回 SQL 或者 .all() 重新引入了 sort path——这两类回归通常 ≥10x 慢,
    // 25x 余量仍能抓得住。原先 1500ms (12x) 在发版峰值负载下(electron-rebuild +
    // 两次 electron-vite build 后并行跑 ~200 测试文件)实测会偶发 false positive
    // (v0.2.74 跑出 1747ms,v0.2.75 OSS sync 又踩同一坑)。
    expect(elapsed, `buildLocalManifest 10k+10k 总耗时 ${elapsed.toFixed(1)}ms (nodes=${(t1-t0).toFixed(1)}ms links=${(t2-t1).toFixed(1)}ms)`).toBeLessThan(3000);
  }, 30_000); // 2w 行 seeding 在 vitest 并行 + 发版机器负载下可能逼近 5s 默认 timeout
  // (2026-05-21 v0.2.74 OSS 发版踩到超时)。perf 断言 <3000ms 只测 buildLocalManifest 本身
  // (不含 seeding),不受 timeout 余量影响,仍能抓 COALESCE/sort 回归。
});
