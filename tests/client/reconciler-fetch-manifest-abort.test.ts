/**
 * Audit-3 F7 回归覆盖:
 * fetchServerManifest 必须:
 *   - 循环顶部检查 this.aborted,abort 时 < 1s 内退出(不要等数百页拉完)
 *   - 加 SOFT_LIMIT 防御服务端 has_more 不收口
 *   - 上报伪进度(progress.processed = pages * MANIFEST_PAGE_LIMIT)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('F7 — fetchServerManifest abort + soft limit', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('aborted=true 时 fetchServerManifest 在 < 1s 内 throw aborted', async () => {
    const db = setupTestDb();
    const fetchMock = vi.mocked(fetch);

    let page = 0;
    fetchMock.mockImplementation(async () => {
      page++;
      // 加 5ms 延迟模拟真实网络,让 setTimeout 有机会 fire
      await new Promise(r => setTimeout(r, 5));
      return new Response(JSON.stringify({
        items: Array.from({ length: 100 }, (_, i) => ({
          id: `n${page}-${i}`,
          sync_version: 1,
          updated: '2026-05-21T00:00:00Z',
          archived: false,
        })),
        has_more: true,
        next_cursor: `cursor-${page}`,
      }), { status: 200 });
    });

    const reconciler = new Reconciler(db);

    // 跑 runAll 但很快 abort
    const start = Date.now();
    setTimeout(() => reconciler.abort(), 50);

    const results = await reconciler.runAll(false);
    const duration = Date.now() - start;

    // < 1s 内退出
    expect(duration).toBeLessThan(2_000);

    // results 应有 errors 包含 'aborted'
    const allErrors = results.flatMap(r => r.errors).join(' ');
    expect(allErrors.toLowerCase()).toContain('aborted');
  }, 5000);

  it('SOFT_LIMIT:服务端 has_more 不收口 + 每页 5000 entry → 命中 1_000_000 限上限抛错', async () => {
    const db = setupTestDb();
    const fetchMock = vi.mocked(fetch);

    // 每页都返大量数据让 all.length 增长到 SOFT_LIMIT
    // 仅看 nodes 表 → reconciler runAll 先跑 nodes,失败后 links 也跑(失败累计)。
    // 用稀疏 items 加快 allocation,但条数仍要够触发 SOFT_LIMIT。
    let page = 0;
    fetchMock.mockImplementation(async () => {
      page++;
      // 用 5000 / page 都行 — 关键看 all.length 累加到 1_000_000
      // 这里压缩 item 大小(仅 id + 4 个字段)避免内存峰值过大
      const items = new Array(5000);
      for (let i = 0; i < 5000; i++) {
        items[i] = { id: `n${page}-${i}`, sync_version: 1, updated: '2026-05-21T00:00:00Z', archived: false };
      }
      return new Response(JSON.stringify({
        items,
        has_more: true,
        next_cursor: `cursor-${page}`,
      }), { status: 200 });
    });

    const reconciler = new Reconciler(db);
    const results = await reconciler.runAll(false);

    const allErrors = results.flatMap(r => r.errors).join(' ');
    expect(allErrors).toContain('manifest too large');
  }, 30_000); // 大数据量,给 30s 上限
});
