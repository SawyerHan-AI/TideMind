/**
 * F14 (audit-7): triggerFullRescan 必须先检查 syncLock,active 时抛错给 UI,
 * 不再静默 resetProgress + 跑并发 sync。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { setupTestDb } from '../../helpers/test-db.js';

// 在 vi.hoisted 提供共享 mock,让 mock 工厂能拿到。
const ctx = vi.hoisted(() => ({
  // listAllPages: 占住 syncLock 的关键 —— 让 runSync 进 await 一直拿不到 page,
  // 同时第 2 个调用进 triggerFullRescan 能抛错。
  resolveBlock: null as ((v: void) => void) | null,
  block: null as Promise<void> | null,
  reset() {
    this.block = new Promise<void>((res) => { this.resolveBlock = res; });
  },
}));

vi.mock('../../../src/integrations/notion/api-client.js', () => ({
  listAllPages: async function* () {
    // 进 generator 时 wait,let 测试有机会让 triggerFullRescan 拿到 syncLock active
    await ctx.block;
    // yield 一个空数组 — 不真的处理页面
  },
  getPageProperties: vi.fn(),
  validateToken: vi.fn(async () => ({ valid: true, pageCount: 1 })),
  isConfirmedNotionPageGoneError: () => false,
}));

vi.mock('../../../src/integrations/notion/initialization.js', () => ({
  isNotionInitializing: vi.fn(() => false),
}));

vi.mock('../../../src/integrations/notion/queue.js', () => ({
  processNotionPages: vi.fn(),
  resetProgress: vi.fn(),
  getImportProgress: vi.fn(() => ({
    phase: 'idle', totalFiles: 0, processedFiles: 0, skippedFiles: 0,
    failedFiles: 0, currentFile: null, startedAt: null,
  })),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

import { triggerFullRescan } from '../../../src/integrations/notion/index.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS notion_sync (
      page_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      last_edited_time TEXT NOT NULL,
      page_type TEXT NOT NULL DEFAULT 'page',
      last_synced TEXT NOT NULL,
      node_ids TEXT,
      source_id TEXT DEFAULT '',
      PRIMARY KEY (page_id, source_id)
    );
  `);
  ctx.reset();
});

describe('triggerFullRescan F14 syncLock 守护', () => {
  it('已有 sync 进行中 → 抛错而不静默继续', async () => {
    // path 用 notion://token=t 形式,extractToken 才能拿到 token
    const fakeNotionPath = 'notion://token=secret_test_token';

    // 第 1 个 triggerFullRescan:不 await,让它进 runSync → listAllPages → 等 ctx.block
    const p1 = triggerFullRescan(db, 'src-notion', fakeNotionPath);

    // 让 p1 进 listAllPages 拿到 syncLock
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // 第 2 个 triggerFullRescan(同 sourceId):应抛错
    await expect(
      triggerFullRescan(db, 'src-notion', fakeNotionPath),
    ).rejects.toThrow(/Sync in progress/);

    // 让 p1 跑完
    ctx.resolveBlock!();
    await p1;
  });

  it('没有 sync 在跑 → 正常执行不抛', async () => {
    const fakeNotionPath = 'notion://token=secret_test_token';
    // 先 release block 让 listAllPages 顺利产出空集合
    ctx.resolveBlock!();
    await expect(
      triggerFullRescan(db, 'src-notion-2', fakeNotionPath),
    ).resolves.toBeUndefined();
  });
});
