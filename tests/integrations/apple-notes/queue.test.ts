import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { setupTestDb, seedLink, seedNode } from '../../helpers/test-db.js';

const appleState = vi.hoisted(() => ({ text: '' }));

vi.mock('../../../src/tools/digest.js', () => ({
  digest: vi.fn(async (repo, input) => {
    const node = repo.nodes.createNode({
      content: input.content,
      title: input.title,
      source_tool: input.source?.tool,
      created: input.created,
    });
    return { status: 'processed', created_nodes: [node] };
  }),
}));

vi.mock('../../../src/integrations/apple-notes/protobuf.js', () => ({
  decodeNoteData: vi.fn(() => ({ noteText: appleState.text, attributeRuns: [] })),
  buildCleanText: vi.fn(() => appleState.text),
  extractHeadingPositions: vi.fn(() => []),
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

import { processNoteQueue, resetProgress } from '../../../src/integrations/apple-notes/queue.js';
import { ensureSyncSchema, getNoteState } from '../../../src/integrations/apple-notes/sync-state.js';
import { getNode } from '../../../src/db/nodes.js';
import { getLinksFrom } from '../../../src/db/links.js';
import type { AppleNote } from '../../../src/integrations/apple-notes/types.js';

let db: Database.Database;

function paragraph(label: string): string {
  return `${label}: ${Array(130).fill('architecture stabilization paragraph content').join(' ')}.`;
}

function makeText(count: number): string {
  return Array.from({ length: count }, (_, index) => paragraph(`Section ${index + 1}`)).join('\n\n');
}

function makeNote(modificationDate: number): AppleNote {
  return {
    zpk: 1,
    uuid: 'note-1',
    title: 'Segmented Apple Note',
    snippet: null,
    folderZpk: null,
    accountZpk: null,
    creationDate: 0,
    modificationDate,
    isPasswordProtected: false,
    markedForDeletion: false,
    zdata: Buffer.from('mock-note-data'),
  };
}

beforeEach(() => {
  db = setupTestDb();
  ensureSyncSchema(db);
  resetProgress('src-apple');
  appleState.text = '';
});

describe('Apple Notes queue segment reduction', () => {
  it('supersedes removed segments and migrates links to the remaining tail segment', async () => {
    appleState.text = makeText(7);
    await processNoteQueue(db, [makeNote(1)], new Map(), new Map(), new Map(), 'src-apple', {
      batchSize: 1,
      concurrency: 1,
      delayBetweenBatches: 0,
    });

    const firstState = getNoteState(db, 'note-1', 'src-apple');
    expect(firstState).not.toBeNull();
    expect(firstState!.node_ids.length).toBeGreaterThan(2);

    const removedNodeId = firstState!.node_ids[firstState!.node_ids.length - 1];
    const target = seedNode(db, { content: 'external target linked from removed apple note segment' });
    seedLink(db, removedNodeId, target.id, { strength: 0.84 });

    appleState.text = makeText(5);
    await processNoteQueue(db, [makeNote(2)], new Map(), new Map(), new Map(), 'src-apple', {
      batchSize: 1,
      concurrency: 1,
      delayBetweenBatches: 0,
    });

    const secondState = getNoteState(db, 'note-1', 'src-apple');
    expect(secondState).not.toBeNull();
    expect(secondState!.node_ids.length).toBeGreaterThan(0);
    expect(secondState!.node_ids.length).toBeLessThan(firstState!.node_ids.length);

    const removedNode = getNode(db, removedNodeId);
    expect(removedNode?.is_superseded).toBe(1);

    const targetNewNodeId = secondState!.node_ids[secondState!.node_ids.length - 1];
    const migratedLinks = getLinksFrom(db, targetNewNodeId);
    const migratedLink = migratedLinks.find(link => link.to_id === target.id);
    expect(migratedLink).toBeDefined();
    expect(migratedLink!.strength).toBeCloseTo(0.84);
  });
});
