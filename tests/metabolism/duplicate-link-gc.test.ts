import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { setupTestDb, seedNode } from '../helpers/test-db.js';
import { runDuplicateLinkGc } from '../../src/metabolism/duplicate-link-gc.js';

let db: Database.Database;
let a: string; let b: string;
function link(id: string, o: { from?: string; to?: string; type?: string; note?: string | null; status?: string; created?: string } = {}) {
  db.prepare(`INSERT INTO links (id, from_id, to_id, relation, note, status, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, o.from ?? a, o.to ?? b, JSON.stringify([{ type: o.type ?? 'analogous', confidence: 0.7 }]),
      o.note === undefined ? null : o.note, o.status ?? 'confirmed', o.created ?? '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
}
const alive = () => (db.prepare('SELECT id FROM links WHERE deleted = 0 ORDER BY id').all() as Array<{ id: string }>).map(r => r.id);

beforeEach(() => {
  db = setupTestDb();
  a = seedNode(db, { content: '星海科技' }).id;
  b = seedNode(db, { content: 'DataPilot' }).id;
});

describe('duplicate link gc', () => {
  it('does nothing without exact duplicates', () => {
    link('l1'); link('l2', { type: 'tagged' }); link('l3', { note: '另一回事' }); link('l4', { from: b, to: a });
    expect(runDuplicateLinkGc(db)).toEqual({ groups: 0, deleted: 0 });
    expect(alive()).toEqual(['l1', 'l2', 'l3', 'l4']);
  });

  it('merges links whose endpoints, direction, relation type and note are all equal', () => {
    link('l2', { created: '2026-02-01T00:00:00.000Z' });
    link('l1', { created: '2026-01-01T00:00:00.000Z' });
    link('n1', { note: '同一句备注' }); link('n2', { note: '同一句备注' });
    expect(runDuplicateLinkGc(db)).toEqual({ groups: 2, deleted: 2 });
    expect(alive()).toEqual(['l1', 'n1']);
    // soft delete: row kept, edit_seq bumped so the deletion propagates
    expect(db.prepare("SELECT deleted, edit_seq FROM links WHERE id = 'l2'").get()).toEqual({ deleted: 1, edit_seq: 1 });
  });

  it('keeps a user-rejected link over confirmed over pending', () => {
    link('p', { status: 'pending', created: '2025-01-01T00:00:00.000Z' });
    link('c', { status: 'confirmed', created: '2025-06-01T00:00:00.000Z' });
    link('r', { status: 'rejected_by_user', created: '2026-01-01T00:00:00.000Z' });
    runDuplicateLinkGc(db);
    expect(alive()).toEqual(['r']);
  });

  it('ignores already deleted links', () => {
    link('l1'); link('l2');
    db.prepare("UPDATE links SET deleted = 1 WHERE id = 'l2'").run();
    expect(runDuplicateLinkGc(db)).toEqual({ groups: 0, deleted: 0 });
  });

  it('tolerates rows whose relation is not valid JSON', () => {
    link('l1'); link('l2');
    db.prepare("UPDATE links SET relation = 'not json'").run();
    expect(runDuplicateLinkGc(db)).toEqual({ groups: 1, deleted: 1 });
  });
});
