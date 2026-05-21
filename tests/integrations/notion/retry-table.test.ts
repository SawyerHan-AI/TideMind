/**
 * B-2 (audit-10, 2026-05-21): Notion 失败页持久化重试表。
 *
 * 老代码失败页只 progress.failedFiles++,没持久化 → 下轮 sync 不再尝试,
 * 用户必须手动改动该 page (lastEditedTime 推进) 才会被重试,或者重启 daemon
 * 跑全量 → 大量浪费。
 *
 * 新行为:
 *   processOnePage 抛错 → recordPageFailure(attempts+1)
 *   下轮 incremental sync → getPagesPendingRetry 把 attempts<MAX 的 page 合入 changedPages
 *   processOnePage 成功 → clearPageFailure (DELETE)
 *   attempts >= NOTION_RETRY_MAX_ATTEMPTS → status='dead_letter',不再被合入
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { setupTestDb } from '../../helpers/test-db.js';

const notionState = vi.hoisted(() => ({ content: '', hash: '', digestCreatesNode: true, throwOnPreprocess: false }));

vi.mock('../../../src/tools/digest.js', () => ({
  digest: vi.fn(async (repo, input) => {
    if (!notionState.digestCreatesNode) {
      return { status: 'rejected', reject_reason: 'mock digest failure' };
    }
    const node = repo.nodes.createNode({
      content: input.content,
      title: input.title,
      source_tool: input.source?.tool,
    });
    return { status: 'processed', created_nodes: [node] };
  }),
}));

vi.mock('../../../src/integrations/notion/api-client.js', () => ({
  getPageProperties: vi.fn(async (_token: string, pageId: string) => {
    if (notionState.throwOnPreprocess) {
      throw new Error('mock API failure');
    }
    return { id: pageId };
  }),
  getParentTitle: vi.fn(async () => null),
}));

vi.mock('../../../src/integrations/notion/preprocessor.js', () => ({
  preprocessNotionPage: vi.fn(async () => {
    if (notionState.throwOnPreprocess) {
      throw new Error('mock preprocess failure');
    }
    return {
      page: {
        title: 'Test Page',
        cleanContent: notionState.content,
        metadata: { tags: [], properties: {}, pageRefs: [] },
      },
      contentHash: notionState.hash,
    };
  }),
}));

vi.mock('../../../src/strategy/loader.js', () => ({
  getParam: (_s: string, _p: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

vi.mock('../../../src/config.js', () => ({
  getConfig: () => ({
    general: { data_dir: '/tmp/test-eb', user_name: 'tester' },
    search: { alpha: 0.4, beta: 0.3, gamma: 0.2, delta: 0.1 },
  }),
}));

import { processNotionPages, resetProgress } from '../../../src/integrations/notion/queue.js';
import {
  recordPageFailure,
  clearPageFailure,
  getPagesPendingRetry,
  listAllPendingRetry,
  NOTION_RETRY_MAX_ATTEMPTS,
} from '../../../src/integrations/notion/sync-state.js';
import type { NotionPageSummary } from '../../../src/integrations/notion/types.js';

const body = 'This paragraph is intentionally long enough to be its own Notion segment for downstream segmentation to leave at least one node in the chain.';

function makeContent(n: number): string {
  return Array.from({ length: n }, (_, i) => `## Section ${i + 1}\n\n${body}`).join('\n\n');
}

function page(pageId: string, lastEditedTime: string): NotionPageSummary {
  return {
    id: pageId,
    title: 'Test Page',
    lastEditedTime,
    parentType: 'workspace',
    parentId: null,
    inTrash: false,
    icon: null,
    url: `https://notion.so/${pageId}`,
  };
}

const SOURCE_ID = 'src-retry';

let db: Database.Database;

function createSchema(d: Database.Database) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS notion_sync (
      page_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      last_edited_time TEXT NOT NULL,
      page_type TEXT NOT NULL,
      last_synced TEXT NOT NULL,
      node_ids TEXT,
      source_id TEXT NOT NULL DEFAULT '__default__',
      PRIMARY KEY (page_id, source_id)
    );
    CREATE TABLE IF NOT EXISTS notion_pending_relations (
      source_page_id TEXT NOT NULL,
      target_page_id TEXT NOT NULL,
      source_node_id TEXT NOT NULL,
      property_name TEXT NOT NULL,
      source_id TEXT NOT NULL DEFAULT '__default__',
      created TEXT NOT NULL,
      PRIMARY KEY (source_page_id, target_page_id, property_name, source_id)
    );
    CREATE TABLE IF NOT EXISTS notion_pending_retry (
      page_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt TEXT NOT NULL,
      last_error TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','dead_letter')),
      PRIMARY KEY (page_id, source_id)
    );
    CREATE INDEX IF NOT EXISTS idx_notion_pending_retry_source
      ON notion_pending_retry(source_id, status);
  `);
}

beforeEach(() => {
  db = setupTestDb();
  createSchema(db);
  resetProgress(SOURCE_ID);
  notionState.content = '';
  notionState.hash = '';
  notionState.digestCreatesNode = true;
  notionState.throwOnPreprocess = false;
});

describe('B-2: notion_pending_retry 表 — 单元函数', () => {
  it('recordPageFailure 新建 attempts=1, pending', () => {
    recordPageFailure(db, 'page-x', SOURCE_ID, 'boom');
    const all = listAllPendingRetry(db, SOURCE_ID);
    expect(all).toHaveLength(1);
    expect(all[0].page_id).toBe('page-x');
    expect(all[0].attempts).toBe(1);
    expect(all[0].status).toBe('pending');
    expect(all[0].last_error).toBe('boom');
  });

  it('recordPageFailure 多次累积 attempts', () => {
    recordPageFailure(db, 'page-x', SOURCE_ID, 'err1');
    recordPageFailure(db, 'page-x', SOURCE_ID, 'err2');
    recordPageFailure(db, 'page-x', SOURCE_ID, 'err3');

    const all = listAllPendingRetry(db, SOURCE_ID);
    expect(all).toHaveLength(1);
    expect(all[0].attempts).toBe(3);
    expect(all[0].last_error).toBe('err3');
    expect(all[0].status).toBe('pending');
  });

  it(`达到 NOTION_RETRY_MAX_ATTEMPTS=${NOTION_RETRY_MAX_ATTEMPTS} 时切到 dead_letter`, () => {
    for (let i = 0; i < NOTION_RETRY_MAX_ATTEMPTS; i++) {
      recordPageFailure(db, 'page-x', SOURCE_ID, `err${i}`);
    }
    const all = listAllPendingRetry(db, SOURCE_ID);
    expect(all[0].attempts).toBe(NOTION_RETRY_MAX_ATTEMPTS);
    expect(all[0].status).toBe('dead_letter');
  });

  it('clearPageFailure 删除记录', () => {
    recordPageFailure(db, 'page-x', SOURCE_ID, 'err');
    expect(listAllPendingRetry(db, SOURCE_ID)).toHaveLength(1);
    clearPageFailure(db, 'page-x', SOURCE_ID);
    expect(listAllPendingRetry(db, SOURCE_ID)).toHaveLength(0);
  });

  it('clearPageFailure 对不存在的记录是 no-op', () => {
    expect(() => clearPageFailure(db, 'page-nope', SOURCE_ID)).not.toThrow();
  });

  it('getPagesPendingRetry 只返回 pending 状态', () => {
    // 一个未到 max,一个已到 max
    recordPageFailure(db, 'page-a', SOURCE_ID, 'err');

    for (let i = 0; i < NOTION_RETRY_MAX_ATTEMPTS; i++) {
      recordPageFailure(db, 'page-dead', SOURCE_ID, 'err');
    }

    const pending = getPagesPendingRetry(db, SOURCE_ID);
    expect(pending).toContain('page-a');
    expect(pending).not.toContain('page-dead');
  });

  it('sourceId 隔离: 两个 source 互不干扰', () => {
    recordPageFailure(db, 'page-a', 'src-1', 'err');
    recordPageFailure(db, 'page-b', 'src-2', 'err');
    expect(getPagesPendingRetry(db, 'src-1')).toEqual(['page-a']);
    expect(getPagesPendingRetry(db, 'src-2')).toEqual(['page-b']);
  });

  it('last_error 超长截断到 1000 字符', () => {
    const huge = 'x'.repeat(5000);
    recordPageFailure(db, 'page-x', SOURCE_ID, huge);
    const all = listAllPendingRetry(db, SOURCE_ID);
    expect(all[0].last_error!.length).toBeLessThanOrEqual(1003); // '...'
  });
});

describe('B-2: processNotionPages 集成 — 失败 / 成功路径', () => {
  it('processOnePage 失败 → notion_pending_retry 有行 attempts=1', async () => {
    notionState.content = makeContent(1);
    notionState.hash = 'hash-1';
    notionState.throwOnPreprocess = true;

    await processNotionPages(db, 'token', [page('page-fail', '2026-04-28T01:00:00.000Z')], SOURCE_ID);

    const all = listAllPendingRetry(db, SOURCE_ID);
    expect(all).toHaveLength(1);
    expect(all[0].page_id).toBe('page-fail');
    expect(all[0].attempts).toBe(1);
    expect(all[0].status).toBe('pending');
  });

  it('连续 MAX 次失败 → dead_letter,下次不被合入', async () => {
    notionState.content = makeContent(1);
    notionState.hash = 'hash-1';
    notionState.throwOnPreprocess = true;

    for (let i = 0; i < NOTION_RETRY_MAX_ATTEMPTS; i++) {
      // 同一 pageId,每次失败 attempts++
      await processNotionPages(db, 'token', [page('page-x', '2026-04-28T01:00:00.000Z')], SOURCE_ID);
    }

    const all = listAllPendingRetry(db, SOURCE_ID);
    expect(all).toHaveLength(1);
    expect(all[0].attempts).toBe(NOTION_RETRY_MAX_ATTEMPTS);
    expect(all[0].status).toBe('dead_letter');

    // 下次不会再被合入
    const pending = getPagesPendingRetry(db, SOURCE_ID);
    expect(pending).toEqual([]);
  });

  it('processOnePage 成功 → pending_retry 行被 DELETE', async () => {
    notionState.content = makeContent(1);
    notionState.hash = 'hash-fail';
    notionState.throwOnPreprocess = true;

    await processNotionPages(db, 'token', [page('page-recoverable', '2026-04-28T01:00:00.000Z')], SOURCE_ID);
    expect(listAllPendingRetry(db, SOURCE_ID)).toHaveLength(1);

    // 第二次:模拟问题修好了
    notionState.throwOnPreprocess = false;
    notionState.content = makeContent(1);
    notionState.hash = 'hash-ok';

    await processNotionPages(db, 'token', [page('page-recoverable', '2026-04-28T02:00:00.000Z')], SOURCE_ID);

    expect(listAllPendingRetry(db, SOURCE_ID)).toHaveLength(0);
  });

  it('processOnePage 抛错时 getPagesPendingRetry 命中该 pageId', async () => {
    notionState.content = makeContent(1);
    notionState.hash = 'hash-1';
    notionState.throwOnPreprocess = true;

    await processNotionPages(db, 'token', [page('page-y', '2026-04-28T01:00:00.000Z')], SOURCE_ID);

    expect(getPagesPendingRetry(db, SOURCE_ID)).toContain('page-y');
  });
});
