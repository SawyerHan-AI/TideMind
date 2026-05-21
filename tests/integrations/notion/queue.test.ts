import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { setupTestDb, seedLink, seedNode } from '../../helpers/test-db.js';

const notionState = vi.hoisted(() => ({ content: '', hash: '', digestCreatesNode: true }));

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
  getPageProperties: vi.fn(async (_token: string, pageId: string) => ({ id: pageId })),
  getParentTitle: vi.fn(async () => null),
}));

vi.mock('../../../src/integrations/notion/preprocessor.js', () => ({
  preprocessNotionPage: vi.fn(async () => ({
    page: {
      title: 'Segmented Notion Page',
      cleanContent: notionState.content,
      metadata: { tags: [], properties: {}, pageRefs: [] },
    },
    contentHash: notionState.hash,
  })),
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

import { getImportProgress, processNotionPages, resetProgress } from '../../../src/integrations/notion/queue.js';
import { getPageState } from '../../../src/integrations/notion/sync-state.js';
import { getNode } from '../../../src/db/nodes.js';
import { getLinksFrom } from '../../../src/db/links.js';
import type { NotionPageSummary } from '../../../src/integrations/notion/types.js';

let db: Database.Database;

const body = 'This paragraph is intentionally long enough to remain its own Notion segment. It covers architecture stabilization, regression tests, and operational runbooks for repeated imports across source adapters.';

function makeContent(sectionCount: number): string {
  return Array.from({ length: sectionCount }, (_, index) => `## Section ${index + 1}\n\n${body}`).join('\n\n');
}

function page(lastEditedTime: string): NotionPageSummary {
  return {
    id: 'page-1',
    title: 'Segmented Notion Page',
    lastEditedTime,
    parentType: 'workspace',
    parentId: null,
    inTrash: false,
    icon: null,
    url: 'https://notion.so/page-1',
  };
}

beforeEach(() => {
  db = setupTestDb();
  db.exec(`
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
  `);
  resetProgress('src-notion');
  notionState.content = '';
  notionState.hash = '';
  notionState.digestCreatesNode = true;
});

describe('Notion queue segment reduction', () => {
  it('supersedes removed segments and migrates links to the remaining tail segment', async () => {
    notionState.content = makeContent(3);
    notionState.hash = 'hash-v1';
    await processNotionPages(db, 'token', [page('2026-04-28T01:00:00.000Z')], 'src-notion');

    const firstState = getPageState(db, 'page-1', 'src-notion');
    expect(firstState).not.toBeNull();
    expect(firstState!.node_ids.length).toBe(3);

    const removedNodeId = firstState!.node_ids[2];
    const target = seedNode(db, { content: 'external target linked from removed notion segment' });
    seedLink(db, removedNodeId, target.id, { strength: 0.86 });

    notionState.content = makeContent(2);
    notionState.hash = 'hash-v2';
    await processNotionPages(db, 'token', [page('2026-04-28T02:00:00.000Z')], 'src-notion');

    const secondState = getPageState(db, 'page-1', 'src-notion');
    expect(secondState).not.toBeNull();
    expect(secondState!.node_ids.length).toBe(2);

    const removedNode = getNode(db, removedNodeId);
    expect(removedNode?.is_superseded).toBe(1);

    const targetNewNodeId = secondState!.node_ids[secondState!.node_ids.length - 1];
    const migratedLinks = getLinksFrom(db, targetNewNodeId);
    const migratedLink = migratedLinks.find(link => link.to_id === target.id);
    expect(migratedLink).toBeDefined();
    expect(migratedLink!.strength).toBeCloseTo(0.86);
  });

  it('keeps old nodes and sync state when every digest segment fails', async () => {
    notionState.content = makeContent(2);
    notionState.hash = 'hash-v1';
    await processNotionPages(db, 'token', [page('2026-04-28T01:00:00.000Z')], 'src-notion');

    const firstState = getPageState(db, 'page-1', 'src-notion');
    expect(firstState).not.toBeNull();
    const oldNodeIds = firstState!.node_ids;
    const oldNodeId = oldNodeIds[0];
    const target = seedNode(db, { content: 'external target linked before notion digest failure' });
    seedLink(db, oldNodeId, target.id, { strength: 0.81 });

    notionState.content = makeContent(1);
    notionState.hash = 'hash-v2';
    notionState.digestCreatesNode = false;
    await processNotionPages(db, 'token', [page('2026-04-28T02:00:00.000Z')], 'src-notion');

    const secondState = getPageState(db, 'page-1', 'src-notion');
    expect(secondState?.node_ids).toEqual(oldNodeIds);
    expect(getNode(db, oldNodeId)?.is_superseded).toBe(0);
    expect(getLinksFrom(db, oldNodeId).some(link => link.to_id === target.id)).toBe(true);
  });

  it('stops before processing pages when initialization is aborted', async () => {
    notionState.content = makeContent(1);
    notionState.hash = 'hash-abort';

    await processNotionPages(
      db,
      'token',
      [page('2026-04-28T03:00:00.000Z')],
      'src-notion',
      undefined,
      () => true,
    );

    expect(getPageState(db, 'page-1', 'src-notion')).toBeNull();
    expect(getImportProgress('src-notion').phase).toBe('idle');
  });

  // 回归 F15(2026-05-21): stopNotionSource 必须显式 resetProgress,否则
  // progressMap 永久挂着旧 source 的 progress 行,UI 重新 add 同 sourceId 时看到
  // phase='done' 的过期状态。
  it('F15 回归: stopNotionSource 调用后 progressMap 不残留', async () => {
    const { __testing } = await import('../../../src/integrations/notion/queue.js');
    const { stopNotionSource } = await import('../../../src/integrations/notion/index.js');

    // 模拟"add source → start sync"中间态:progressMap 已有一行
    __testing.seedProgress('src-test-f15');
    expect(__testing.hasProgress('src-test-f15')).toBe(true);

    // stopNotionSource 应该把 progress 也清理掉
    stopNotionSource('src-test-f15');

    expect(__testing.hasProgress('src-test-f15')).toBe(false);
  });
});
