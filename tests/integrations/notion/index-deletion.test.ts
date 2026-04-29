import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { setupTestDb, seedNode } from '../../helpers/test-db.js';

const notionApi = vi.hoisted(() => ({
  pages: [] as Array<{ id: string }>,
  getPageProperties: vi.fn(),
}));

vi.mock('../../../src/integrations/notion/api-client.js', () => ({
  listAllPages: vi.fn(async function* () {
    for (const page of notionApi.pages) {
      yield page;
    }
  }),
  getPageProperties: notionApi.getPageProperties,
  validateToken: vi.fn(async () => ({ valid: true, pageCount: 1 })),
  isConfirmedNotionPageGoneError: (err: unknown) => {
    const status = (err as { status?: number })?.status;
    return status === 403 || status === 404;
  },
}));

vi.mock('../../../src/integrations/notion/initialization.js', () => ({
  isNotionInitializing: vi.fn(() => false),
}));

vi.mock('../../../src/integrations/notion/queue.js', () => ({
  processNotionPages: vi.fn(),
  resetProgress: vi.fn(),
  getImportProgress: vi.fn(() => ({
    phase: 'idle',
    totalFiles: 0,
    processedFiles: 0,
    skippedFiles: 0,
    failedFiles: 0,
    currentFile: null,
    startedAt: null,
  })),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

import { detectDeletedPages } from '../../../src/integrations/notion/index.js';
import { getPageState, updatePageState } from '../../../src/integrations/notion/sync-state.js';
import { getNode } from '../../../src/db/nodes.js';

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
    CREATE TABLE IF NOT EXISTS notion_pending_relations (
      source_page_id TEXT NOT NULL,
      target_page_id TEXT NOT NULL,
      source_node_id TEXT NOT NULL,
      property_name TEXT NOT NULL,
      source_id TEXT NOT NULL DEFAULT '',
      created TEXT NOT NULL,
      PRIMARY KEY (source_page_id, target_page_id, property_name, source_id)
    );
  `);
  notionApi.pages = [];
  notionApi.getPageProperties.mockReset();
});

describe('Notion deleted-page detection', () => {
  it('keeps sync state and nodes active when confirmation hits a transient API error', async () => {
    const node = seedNode(db, { source_tool: 'notion', content: 'kept after transient error' });
    updatePageState(db, 'page-stale', 'hash', '2026-04-28T00:00:00.000Z', 'page', [node.id], 'src-notion');
    notionApi.getPageProperties.mockRejectedValue(Object.assign(new Error('Notion 503'), { status: 503 }));

    await detectDeletedPages(db, 'token', 'src-notion');

    expect(getPageState(db, 'page-stale', 'src-notion')).not.toBeNull();
    expect(getNode(db, node.id)?.archived).toBe(0);
  });

  it('archives nodes and removes sync state when the page is confirmed gone', async () => {
    const node = seedNode(db, { source_tool: 'notion', content: 'removed page' });
    updatePageState(db, 'page-stale', 'hash', '2026-04-28T00:00:00.000Z', 'page', [node.id], 'src-notion');
    notionApi.getPageProperties.mockRejectedValue(Object.assign(new Error('Notion 404'), { status: 404 }));

    await detectDeletedPages(db, 'token', 'src-notion');

    expect(getPageState(db, 'page-stale', 'src-notion')).toBeNull();
    expect(getNode(db, node.id)?.archived).toBe(1);
  });
});
