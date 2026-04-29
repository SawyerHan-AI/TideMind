import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { setupTestDb } from '../../helpers/test-db.js';

const queueControl = vi.hoisted(() => ({
  abort: undefined as undefined | (() => void),
  shouldStopBeforeAbort: null as boolean | null,
  shouldStopAfterAbort: null as boolean | null,
}));

vi.mock('../../../src/config.js', () => ({
  reloadConfig: vi.fn(),
  isLlmConfigured: vi.fn(() => false),
  getConfig: vi.fn(() => ({
    llm: { light_model: 'test', standard_model: 'test', heavy_model: 'test' },
  })),
}));

vi.mock('../../../src/integrations/apple-notes/database.js', () => ({
  openNoteStoreDb: vi.fn(() => ({ close: vi.fn() })),
  detectSchemaVersion: vi.fn(() => ({
    version: '15',
    accountFK: 'ZACCOUNT7',
    creationDateCol: 'ZCREATIONDATE3',
    modificationDateCol: 'ZMODIFICATIONDATE1',
    hasHashtags: true,
    hasSmartFolders: true,
  })),
  listFolders: vi.fn(() => []),
  buildFolderPathMap: vi.fn(() => new Map()),
  listNotes: vi.fn(() => [{
    zpk: 1,
    uuid: 'note-1',
    title: 'Abort Note',
    snippet: null,
    folderZpk: null,
    accountZpk: null,
    creationDate: 0,
    modificationDate: 1,
    isPasswordProtected: false,
    markedForDeletion: false,
    zdata: Buffer.from('note'),
  }]),
  countNotes: vi.fn(() => 1),
  parseAccountsFromPath: vi.fn((sourcePath: string) => ({ dbPath: sourcePath, accountZpks: undefined })),
  preloadNoteTags: vi.fn(() => new Map()),
  preloadNoteAttachmentTexts: vi.fn(() => new Map()),
}));

vi.mock('../../../src/integrations/apple-notes/protobuf.js', () => ({
  initProto: vi.fn(),
}));

vi.mock('../../../src/integrations/apple-notes/queue.js', () => ({
  processNoteQueue: vi.fn(async (...args: unknown[]) => {
    const shouldStop = args[7] as (() => boolean) | undefined;
    queueControl.shouldStopBeforeAbort = shouldStop?.() ?? null;
    queueControl.abort?.();
    queueControl.shouldStopAfterAbort = shouldStop?.() ?? null;
    return {
      nodeIdsCreated: [],
      linksCreated: 0,
      notesProcessed: 0,
      notesSkipped: 0,
      notesFailed: 0,
    };
  }),
}));

vi.mock('../../../src/metabolism/annotate.js', () => ({ runAnnotation: vi.fn() }));
vi.mock('../../../src/metabolism/link-evaluate.js', () => ({ runLinkEvaluate: vi.fn() }));
vi.mock('../../../src/metabolism/divergent.js', () => ({
  runKeystoneIdentification: vi.fn(),
  runCrystalEmergence: vi.fn(),
}));
vi.mock('../../../src/metabolism/temporal-crystal.js', () => ({ runTemporalCrystal: vi.fn() }));
vi.mock('../../../src/db/log.js', () => ({ logTimelineEvent: vi.fn() }));
vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

import { abortInit, runInitialization } from '../../../src/integrations/apple-notes/initialization.js';

let db: Database.Database;
let tmpDir: string;
let noteStorePath: string;

beforeEach(() => {
  db = setupTestDb();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-apple-init-abort-'));
  noteStorePath = path.join(tmpDir, 'NoteStore.sqlite');
  fs.writeFileSync(noteStorePath, '');
  queueControl.abort = () => abortInit('src-apple');
  queueControl.shouldStopBeforeAbort = null;
  queueControl.shouldStopAfterAbort = null;
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Apple Notes initialization abort', () => {
  it('passes the abort predicate into the ingest queue', async () => {
    await expect(runInitialization(db, 'src-apple', noteStorePath)).rejects.toThrow(/初始化已中断/);

    expect(queueControl.shouldStopBeforeAbort).toBe(false);
    expect(queueControl.shouldStopAfterAbort).toBe(true);
  });
});
