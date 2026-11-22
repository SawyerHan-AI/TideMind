import { describe, expect, it } from 'vitest';
import { createTestDb } from '../../src/db/connection.js';
import {
  claimNextRecallFollowup, completeRecallFollowup, countPendingRecallFollowups, enqueueRecallFollowup,
  hasDueRecallFollowup, markRecallFollowupItemHandled, recallFollowupBackoffMs,
  recoverProcessingRecallFollowups, releaseRecallFollowup, unmarkRecallFollowupItemHandled,
} from '../../src/db/recall-followups.js';

const rows = (db: ReturnType<typeof createTestDb>) =>
  db.prepare('SELECT * FROM recall_followups ORDER BY created, id').all() as Array<Record<string, any>>;

describe('recall follow-up queue', () => {
  it('deduplicates by kind, node set and query/context; a refresh keeps progress and backoff', () => {
    const db = createTestDb();
    try {
      enqueueRecallFollowup(db, { kind: 'link_revalidate', nodeIds: ['b', 'a'], query: '星海科技', context: 'ignored' });
      enqueueRecallFollowup(db, { kind: 'link_revalidate', nodeIds: ['a', 'b', 'a'], query: '星海科技' });
      enqueueRecallFollowup(db, { kind: 'link_revalidate', nodeIds: ['a', 'b'], query: 'DataPilot' });
      enqueueRecallFollowup(db, { kind: 'reconsolidate', nodeIds: ['a', 'b'], query: 'ignored', context: 'ctx' });
      enqueueRecallFollowup(db, { kind: 'reconsolidate', nodeIds: [] });
      expect(rows(db)).toHaveLength(3);
      expect(countPendingRecallFollowups(db, 'link_revalidate')).toBe(2);
      const first = rows(db).find(r => r.query === '星海科技')!;
      expect(JSON.parse(first.node_ids_json)).toEqual(['b', 'a']);
      expect(first.context).toBeNull();
      expect(rows(db).find(r => r.kind === 'reconsolidate')).toMatchObject({ query: null, context: 'ctx' });

      markRecallFollowupItemHandled(db, first.id, 'l1');
      db.prepare("UPDATE recall_followups SET status='processing', attempts=2, not_before='2999-01-01T00:00:00.000Z', updated='2000-01-01T00:00:00.000Z' WHERE id=?").run(first.id);
      enqueueRecallFollowup(db, { kind: 'link_revalidate', nodeIds: ['a', 'b'], query: '星海科技' });
      const after = rows(db).find(r => r.id === first.id)!;
      expect(after).toMatchObject({ status: 'processing', attempts: 2, not_before: '2999-01-01T00:00:00.000Z', handled_json: '["l1"]' });
      expect(after.updated > '2000-01-01').toBe(true);
    } finally { db.close(); }
  });

  it('claims the most recently refreshed due row and honours not_before', () => {
    const db = createTestDb();
    try {
      enqueueRecallFollowup(db, { kind: 'reconsolidate', nodeIds: ['old'] });
      enqueueRecallFollowup(db, { kind: 'reconsolidate', nodeIds: ['new'] });
      db.prepare("UPDATE recall_followups SET updated='2000-01-01T00:00:00.000Z' WHERE node_ids_json='[\"old\"]'").run();
      expect(hasDueRecallFollowup(db, 'reconsolidate')).toBe(true);
      expect(hasDueRecallFollowup(db, 'link_revalidate')).toBe(false);
      const claimed = claimNextRecallFollowup(db, 'reconsolidate')!;
      expect(claimed.nodeIds).toEqual(['new']);
      releaseRecallFollowup(db, claimed.id, { backoff: true });
      expect(claimNextRecallFollowup(db, 'reconsolidate')!.nodeIds).toEqual(['old']);
      // remaining pending row is backed off; the other is processing
      db.prepare("UPDATE recall_followups SET status='pending', not_before='2999-01-01T00:00:00.000Z'").run();
      expect(hasDueRecallFollowup(db, 'reconsolidate')).toBe(false);
      expect(claimNextRecallFollowup(db, 'reconsolidate')).toBeNull();
    } finally { db.close(); }
  });

  it('marks and unmarks items, backs off definite failures and leaves ambiguous releases untouched', () => {
    const db = createTestDb();
    try {
      enqueueRecallFollowup(db, { kind: 'link_revalidate', nodeIds: ['a'], query: 'q' });
      const row = claimNextRecallFollowup(db, 'link_revalidate')!;
      markRecallFollowupItemHandled(db, row.id, 'l1');
      markRecallFollowupItemHandled(db, row.id, 'l1');
      markRecallFollowupItemHandled(db, row.id, 'l2');
      unmarkRecallFollowupItemHandled(db, row.id, 'l2');
      releaseRecallFollowup(db, row.id, { backoff: false });
      expect(rows(db)[0]).toMatchObject({ status: 'pending', attempts: 0, not_before: null, handled_json: '["l1"]', claimed_at: null });
      const again = claimNextRecallFollowup(db, 'link_revalidate')!;
      expect(again.handled).toEqual(['l1']);
      const t0 = Date.parse('2026-01-01T00:00:00.000Z');
      releaseRecallFollowup(db, again.id, { backoff: true, nowMs: t0 });
      expect(rows(db)[0]).toMatchObject({ status: 'pending', attempts: 1, not_before: '2026-01-01T00:05:00.000Z' });
      expect([1, 2, 3, 30].map(recallFollowupBackoffMs)).toEqual([300_000, 600_000, 1_200_000, 86_400_000]);
      completeRecallFollowup(db, row.id);
      expect(rows(db)).toHaveLength(0);
    } finally { db.close(); }
  });

  it('recovers leftover processing rows without touching handled items', () => {
    const db = createTestDb();
    try {
      enqueueRecallFollowup(db, { kind: 'link_revalidate', nodeIds: ['a'], query: 'q' });
      const row = claimNextRecallFollowup(db, 'link_revalidate')!;
      markRecallFollowupItemHandled(db, row.id, 'l1');
      expect(hasDueRecallFollowup(db, 'link_revalidate')).toBe(true);
      expect(recoverProcessingRecallFollowups(db, 'reconsolidate')).toBe(0);
      expect(recoverProcessingRecallFollowups(db, 'link_revalidate')).toBe(1);
      expect(claimNextRecallFollowup(db, 'link_revalidate')!.handled).toEqual(['l1']);
    } finally { db.close(); }
  });
});
