/**
 * pushOutbox per-item JSON.parse 防御测试(HIGH bug 修复)。
 *
 * 背景:
 *   原版 `items.map(i => JSON.parse(i.payload))` 一条坏 JSON 整批 throw,
 *   整个 outbox 永久卡住——任何 push 都因为同一条 corrupted row 失败,
 *   后续好的也推不上去。
 *
 * 修复后的不变量:
 *   1. 坏的 row 立即进 dead-letter(corrupted_payload 是确定性失败,
 *      retry 5 次也修不好,直接跳过 retry)。
 *   2. 好的 row 仍然被打包发出,fetch 请求体只包含 valid items。
 *   3. 全是坏的 → 不发空请求,直接返回 0。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

// CloudSyncClient 顶层 import 'electron',测试需 stub
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  Notification: { isSupported: () => false },
}));

vi.mock('../../client/electron/cloud/auth-client.js', () => ({
  initAuth: vi.fn(),
  getCloudAuth: vi.fn(() => null),
  getCloudBaseUrl: () => 'https://cloud.test.example',
  refreshTokenIfNeeded: vi.fn(async () => 'token-xxx'),
  isLoggedIn: vi.fn(() => true),
}));

vi.mock('../../client/electron/cloud/reconciler.js', () => ({
  Reconciler: vi.fn().mockImplementation(() => ({
    runAll: vi.fn(async () => []),
  })),
}));

vi.mock('../../client/electron/cloud/cache-manager.js', () => ({
  CacheManager: vi.fn().mockImplementation(() => ({
    applyChanges: vi.fn(),
    getLastSyncedVersion: () => 0,
  })),
}));

vi.mock('../../client/electron/cloud/device.js', () => ({
  registerDevice: vi.fn(async () => {}),
}));

import { CloudSyncClient } from '../../client/electron/cloud/sync-client.js';
import {
  createOutboxTable,
  getOutboxCount,
  getDeadLetterCount,
} from '../../client/electron/cloud/outbox.js';

describe('pushOutbox per-item JSON.parse 防御', () => {
  let db: Database.Database;
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ url: string; body: unknown }>;

  beforeEach(() => {
    db = new Database(':memory:');
    createOutboxTable(db);
    originalFetch = globalThis.fetch;
    fetchCalls = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    db.close();
  });

  /**
   * 不走 enqueueOutbox(它会 JSON.stringify object 进去,无法产生"坏 JSON")。
   * 直接 INSERT 原始字符串,模拟磁盘损坏 / 历史 schema / 手工编辑场景。
   */
  function rawInsert(id: string, operation: string, payload: string): void {
    db.prepare('INSERT INTO local_outbox (id, operation, payload, source, created) VALUES (?, ?, ?, ?, ?)').run(
      id, operation, payload, null, new Date().toISOString(),
    );
  }

  it('一条坏 JSON + 一条好 JSON → 坏的进 dead-letter,好的发出', async () => {
    rawInsert('bad-1', 'digest', '{this is not valid json'); // 坏的
    rawInsert('good-1', 'digest', JSON.stringify({ content: 'real data' })); // 好的

    globalThis.fetch = vi.fn(async (url, init) => {
      const body = init && typeof init === 'object' && 'body' in init && typeof init.body === 'string'
        ? JSON.parse(init.body)
        : null;
      fetchCalls.push({ url: String(url), body });
      // 新服务端协议:返回 results,每条 ok。index=0 对应 valid batch 第一条(good-1)
      return new Response(JSON.stringify({
        processed: 1,
        results: [{ index: 0, status: 'ok' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof globalThis.fetch;

    const client = new CloudSyncClient(db);
    const removed = await client.pushOutbox('token-xxx');

    // 不变量 1:fetch 调用了一次
    expect(fetchCalls.length).toBe(1);

    // 不变量 2:发出去的 body 只有 1 个 item(good-1 的 payload)
    const body = fetchCalls[0].body as { items: Array<{ operation: string; payload: unknown }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].operation).toBe('digest');
    expect(body.items[0].payload).toEqual({ content: 'real data' });

    // 不变量 3:好的删除了(收到 ok),坏的进 dead-letter
    expect(removed).toBe(1);
    expect(getOutboxCount(db)).toBe(0); // 好的删了,坏的搬到 dead 表
    expect(getDeadLetterCount(db)).toBe(1);

    // 不变量 4:dead-letter row 的 last_error 标记了 corrupted_payload
    const dead = db.prepare('SELECT * FROM local_outbox_dead WHERE id = ?').get('bad-1') as
      | { id: string; last_error: string; payload: string } | undefined;
    expect(dead).toBeDefined();
    expect(dead?.last_error).toBe('corrupted_payload');
    // payload 原文保留(给人工 debug 用)
    expect(dead?.payload).toBe('{this is not valid json');
  });

  it('全部都是坏 JSON → 不发 fetch 请求,直接返回 0,所有坏的进 dead-letter', async () => {
    rawInsert('bad-a', 'digest', '{broken');
    rawInsert('bad-b', 'digest', 'not json at all');
    rawInsert('bad-c', 'digest', '{{}');

    globalThis.fetch = vi.fn(async (url, init) => {
      fetchCalls.push({ url: String(url), body: init });
      return new Response('should not be called', { status: 500 });
    }) as typeof globalThis.fetch;

    const client = new CloudSyncClient(db);
    const removed = await client.pushOutbox('token-xxx');

    // 关键:没有发任何请求(避免发空 body 浪费 quota / 制造服务端日志噪音)
    expect(fetchCalls.length).toBe(0);
    expect(removed).toBe(0);

    // 3 条全进 dead-letter
    expect(getOutboxCount(db)).toBe(0);
    expect(getDeadLetterCount(db)).toBe(3);
  });

  it('坏 JSON 不被 markOutboxFailed 5 次循环卡住 — 一次性直接搬到 dead-letter', async () => {
    rawInsert('bad-once', 'digest', '{broken');
    rawInsert('good-once', 'digest', JSON.stringify({ content: 'ok' }));

    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      processed: 1, results: [{ index: 0, status: 'ok' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof globalThis.fetch;

    const client = new CloudSyncClient(db);
    await client.pushOutbox('token-xxx');

    // 关键:**一次 push** 就让坏的进 dead-letter(不是 5 次)。
    // 老逻辑会让坏的 retry_count=1 留在 local_outbox,下次 push 时整批又因为同一坏 JSON
    // 抛 SyntaxError,直接卡住——所以 dead-letter 出现的速度本身就是修复正确性的判定。
    expect(getDeadLetterCount(db)).toBe(1);
    // dead-letter retry_count 应当从 0(original)+1 进入,不是 5
    const dead = db.prepare('SELECT retry_count FROM local_outbox_dead WHERE id = ?').get('bad-once') as
      | { retry_count: number } | undefined;
    expect(dead?.retry_count).toBe(1);
  });
});
