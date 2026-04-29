import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { setupTestDb } from '../../helpers/test-db.js';

const queueControl = vi.hoisted(() => ({
  abort: undefined as undefined | (() => void),
  shouldStopBeforeAbort: null as boolean | null,
  shouldStopAfterAbort: null as boolean | null,
}));

vi.mock('../../../src/integrations/notion/api-client.js', () => ({
  listAllPages: vi.fn(async function* () {
    yield {
      id: 'page-1',
      title: 'Abort Page',
      lastEditedTime: '2026-04-28T00:00:00.000Z',
      parentType: 'workspace',
      parentId: null,
      inTrash: false,
      icon: null,
      url: 'https://notion.so/page-1',
    };
  }),
}));

vi.mock('../../../src/integrations/notion/index.js', () => ({
  isNotionSyncing: vi.fn(() => false),
}));

vi.mock('../../../src/integrations/notion/queue.js', () => ({
  processNotionPages: vi.fn(async (...args: unknown[]) => {
    const shouldStop = args[5] as (() => boolean) | undefined;
    queueControl.shouldStopBeforeAbort = shouldStop?.() ?? null;
    queueControl.abort?.();
    queueControl.shouldStopAfterAbort = shouldStop?.() ?? null;
  }),
}));

vi.mock('../../../src/integrations/notion/sync-state.js', () => ({
  markFullScanCompleted: vi.fn(),
}));

vi.mock('../../../src/metabolism/annotate.js', () => ({ runAnnotation: vi.fn() }));
vi.mock('../../../src/metabolism/link-evaluate.js', () => ({ runLinkEvaluate: vi.fn() }));
vi.mock('../../../src/metabolism/divergent.js', () => ({
  runKeystoneIdentification: vi.fn(),
  runCrystalEmergence: vi.fn(),
}));
vi.mock('../../../src/metabolism/temporal-crystal.js', () => ({ runTemporalCrystal: vi.fn() }));
vi.mock('../../../src/metabolism/tag-promote.js', () => ({ promoteFrequentTags: vi.fn() }));
vi.mock('../../../src/integrations/shared/property-promote.js', () => ({ clearTagNodeCache: vi.fn() }));
vi.mock('../../../src/config.js', () => ({ isLlmConfigured: vi.fn(() => false) }));
vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

import { abortInit, runInitialization } from '../../../src/integrations/notion/initialization.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
  queueControl.abort = () => abortInit('src-notion');
  queueControl.shouldStopBeforeAbort = null;
  queueControl.shouldStopAfterAbort = null;
});

describe('Notion initialization abort', () => {
  it('passes the abort predicate into page processing', async () => {
    await expect(runInitialization(db, 'token', 'src-notion')).rejects.toThrow(/初始化已中断/);

    expect(queueControl.shouldStopBeforeAbort).toBe(false);
    expect(queueControl.shouldStopAfterAbort).toBe(true);
  });
});
