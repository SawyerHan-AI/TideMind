import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { setupTestDb, seedNode } from '../../helpers/test-db.js';

const appleDbMock = vi.hoisted(() => ({
  listNotes: vi.fn(),
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
  listNotes: appleDbMock.listNotes,
  listNotesModifiedSince: vi.fn(() => []),
  listAllNoteUuids: vi.fn(() => new Set()),
  parseAccountsFromPath: vi.fn((sourcePath: string) => ({ dbPath: sourcePath, accountZpks: undefined })),
  preloadNoteTags: vi.fn(() => new Map()),
  preloadNoteAttachmentTexts: vi.fn(() => new Map()),
}));

vi.mock('../../../src/integrations/apple-notes/protobuf.js', () => ({
  initProto: vi.fn(),
}));

vi.mock('../../../src/integrations/apple-notes/queue.js', () => ({
  processNoteQueue: vi.fn(),
  getImportProgress: vi.fn(() => ({
    processedNotes: 0,
    skippedNotes: 0,
    failedNotes: 0,
  })),
  resetProgress: vi.fn(),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

import { triggerFullRescan } from '../../../src/integrations/apple-notes/index.js';
import { getNode } from '../../../src/db/nodes.js';
import { ensureSyncSchema, getNoteState, setNoteState } from '../../../src/integrations/apple-notes/sync-state.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
  ensureSyncSchema(db);
  appleDbMock.listNotes.mockReset();
});

describe('Apple Notes transient read failures', () => {
  it('does not stale-archive existing notes when NoteStore is locked', async () => {
    const node = seedNode(db, { source_tool: 'apple-notes', content: 'kept after locked NoteStore' });
    setNoteState(db, {
      note_uuid: 'note-locked',
      modification_date: 1,
      content_hash: 'hash',
      last_synced: '2026-04-28T00:00:00.000Z',
      node_ids: [node.id],
      source_id: 'src-apple',
    });
    appleDbMock.listNotes.mockImplementation(() => {
      throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    });

    await triggerFullRescan(db, 'src-apple', '/tmp/NoteStore.sqlite');

    expect(getNoteState(db, 'note-locked', 'src-apple')).not.toBeNull();
    expect(getNode(db, node.id)?.archived).toBe(0);
  });
});
