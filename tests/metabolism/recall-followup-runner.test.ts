import { describe, it, expect, vi, beforeEach } from 'vitest';

const route = vi.hoisted(() => ({ throws: false, connectionId: null as string | null }));
vi.mock('../../src/llm/route.js', () => ({
  resolveLLMRoute: () => {
    if (route.throws) throw new Error('route unavailable');
    return { connectionId: route.connectionId, scopeId: route.connectionId ?? 'legacy:anthropic' };
  },
  assertRouteCallable: () => {},
}));
vi.mock('../../src/strategy/loader.js', () => ({ getLLMOptions: () => ({ model: 'standard' }) }));
vi.mock('../../src/llm/client.js', () => {
  class LLMServiceError extends Error { constructor(m: string) { super(m); this.name = 'LLMServiceError'; } }
  return { LLMServiceError };
});
vi.mock('../../src/utils/logger.js', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

import type Database from 'better-sqlite3';
import { createTestDb } from '../../src/db/connection.js';
import { claimNextRecallFollowup, enqueueRecallFollowup } from '../../src/db/recall-followups.js';
import { runRecallFollowup, type RecallFollowupItem } from '../../src/metabolism/recall-followup-runner.js';
import { LLMServiceError } from '../../src/llm/client.js';

let db: Database.Database;
const state = () => db.prepare('SELECT status, attempts, handled_json, not_before FROM recall_followups').get() as any;
const plan = (keys: string[], run: (key: string) => Promise<void>, retryLater = false) => (row: { handled: string[] }): { items: RecallFollowupItem[]; retryLater: boolean } =>
  ({ items: keys.filter(k => !row.handled.includes(k)).map(key => ({ key, run: () => run(key) })), retryLater });

beforeEach(() => {
  db = createTestDb();
  route.throws = false; route.connectionId = null;
  enqueueRecallFollowup(db, { kind: 'link_revalidate', nodeIds: ['n1'], query: 'q' });
});

describe('recall follow-up runner', () => {
  it('leaves the queue untouched when the route is not callable or the connection circuit is open', async () => {
    const run = vi.fn();
    route.throws = true;
    await runRecallFollowup(db, 'link_revalidate', { strategy: 's', planItems: plan(['a'], run) });
    expect(state()).toMatchObject({ status: 'pending', attempts: 0, handled_json: '[]' });
    route.throws = false; route.connectionId = 'mc_x';
    db.prepare(`INSERT INTO llm_connection_health (scope_id, connection_id, provider_type, circuit_state, failure_count, opened_at, cooldown_ms, updated_at)
      VALUES ('mc_x','mc_x','codex-cli','open',3,?,3600000,'t')`).run(Date.now());
    await runRecallFollowup(db, 'link_revalidate', { strategy: 's', planItems: plan(['a'], run) });
    expect(run).not.toHaveBeenCalled();
    expect(state()).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('deletes the row once every item ran', async () => {
    const ran: string[] = [];
    await runRecallFollowup(db, 'link_revalidate', { strategy: 's', planItems: plan(['a', 'b'], async k => { ran.push(k); }) });
    expect(ran).toEqual(['a', 'b']);
    expect(state()).toBeUndefined();
  });

  it('definite failure: unmarks that item, backs the row off, keeps finished items', async () => {
    const capacity = Object.assign(new Error('busy'), { name: 'CliLLMError', kind: 'capacity' });
    await runRecallFollowup(db, 'link_revalidate', {
      strategy: 's', planItems: plan(['a', 'b', 'c'], async k => { if (k === 'b') throw capacity; }),
    });
    const s = state();
    expect(s).toMatchObject({ status: 'pending', attempts: 1, handled_json: '["a"]' });
    expect(s.not_before > new Date().toISOString()).toBe(true);
  });

  it('ambiguous outcome: item stays handled, row stays queued, error propagates, rest continues later', async () => {
    const ambiguous = Object.assign(new Error('unknown'), { name: 'CliLLMError', kind: 'ambiguous_outcome', options: { promptCommitted: true } });
    const ran: string[] = [];
    const run = async (k: string) => { ran.push(k); if (k === 'b' && ran.filter(x => x === 'b').length === 1) throw ambiguous; };
    await expect(runRecallFollowup(db, 'link_revalidate', { strategy: 's', planItems: plan(['a', 'b', 'c'], run) }))
      .rejects.toBe(ambiguous);
    expect(state()).toMatchObject({ status: 'pending', attempts: 0, not_before: null, handled_json: '["a","b"]' });
    expect(db.prepare('SELECT count(*) AS n FROM pending_digests').get()).toEqual({ n: 0 });
    await runRecallFollowup(db, 'link_revalidate', { strategy: 's', planItems: plan(['a', 'b', 'c'], run) });
    expect(ran).toEqual(['a', 'b', 'c']);
    expect(state()).toBeUndefined();
  });

  it('LLMServiceError propagates once for the scheduler circuit and the item is retryable', async () => {
    const err = new LLMServiceError('503');
    await expect(runRecallFollowup(db, 'link_revalidate', {
      strategy: 's', planItems: plan(['a'], async () => { throw err; }),
    })).rejects.toBe(err);
    expect(state()).toMatchObject({ status: 'pending', attempts: 1, handled_json: '[]' });
  });

  it('recovers a leftover processing row without redoing handled items', async () => {
    const row = claimNextRecallFollowup(db, 'link_revalidate')!;
    db.prepare(`UPDATE recall_followups SET handled_json='["a"]' WHERE id=?`).run(row.id);
    const ran: string[] = [];
    await runRecallFollowup(db, 'link_revalidate', { strategy: 's', planItems: plan(['a', 'b'], async k => { ran.push(k); }) });
    expect(ran).toEqual(['b']);
    expect(state()).toBeUndefined();
  });

  it('canRun=false and skipRoutePrecheck are honoured', async () => {
    const run = vi.fn(async () => {});
    await runRecallFollowup(db, 'link_revalidate', { strategy: 's', canRun: () => false, planItems: plan(['a'], run) });
    expect(run).not.toHaveBeenCalled();
    route.throws = true;
    await runRecallFollowup(db, 'link_revalidate', { strategy: 's', skipRoutePrecheck: () => true, planItems: plan(['a'], run) });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('an ambiguous refusal before submission keeps the item retryable and does not propagate', async () => {
    const refused = Object.assign(new Error('paused'), { name: 'LLMRouteError', kind: 'ambiguous_outcome' });
    await runRecallFollowup(db, 'link_revalidate', { strategy: 's', planItems: plan(['a'], async () => { throw refused; }) });
    expect(state()).toMatchObject({ status: 'pending', attempts: 0, handled_json: '[]' });
  });

  it('a runtime that is shutting down leaves the item retryable', async () => {
    await runRecallFollowup(db, 'link_revalidate', {
      strategy: 's', planItems: plan(['a'], async () => { throw new Error('LLM runtime is shutting down'); }),
    });
    expect(state()).toMatchObject({ status: 'pending', attempts: 1, handled_json: '[]' });
  });

  it('an open-circuit refusal (or any unknown error) keeps the item retryable', async () => {
    const open = Object.assign(new Error('401 invalid key'), { name: 'LLMConnectionCircuitOpenError', code: 'not_authenticated' });
    await runRecallFollowup(db, 'link_revalidate', { strategy: 's', planItems: plan(['a'], async () => { throw open; }) });
    expect(state()).toMatchObject({ status: 'pending', attempts: 1, handled_json: '[]' });
  });

  it('a deterministic non-model error skips only that item', async () => {
    const ran: string[] = [];
    await runRecallFollowup(db, 'link_revalidate', {
      strategy: 's', planItems: plan(['a', 'b'], async k => { ran.push(k); if (k === 'a') throw new TypeError('bad data'); }),
    });
    expect(ran).toEqual(['a', 'b']);
    expect(state()).toBeUndefined();
  });

  it('keeps a row whose remaining work is not doable yet', async () => {
    await runRecallFollowup(db, 'link_revalidate', { strategy: 's', planItems: plan([], async () => {}, true) });
    const s = state();
    expect(s).toMatchObject({ status: 'pending', attempts: 1, handled_json: '[]' });
    expect(s.not_before > new Date(Date.now() + 30 * 60_000).toISOString()).toBe(true);
  });
});
