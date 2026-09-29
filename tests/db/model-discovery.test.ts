import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_s: string, _p: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

import Database from 'better-sqlite3';
import { ensureSchema } from '../../src/db/schema.js';
import {
  authBindingMatches,
  getAuthBinding,
  getCatalogSnapshot,
  getModelObservation,
  listModelObservations,
  reconcileAuthBinding,
  recordCatalogRefreshFailure,
  recordModelObservation,
  saveCatalogSnapshot,
} from '../../src/db/model-discovery.js';
import type { CliAuthIdentity, CliCatalogModel } from '../../src/llm/cli/types.js';

const CONNECTION = 'mc_5eed0001';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  ensureSchema(db);
  return db;
}

function auth(
  scope: string | null,
  method = 'chatgpt',
): CliAuthIdentity {
  const scopeKey = scope ? `codex-cli:${scope}` : 'codex-cli:unknown';
  return {
    providerType: 'codex-cli',
    method,
    accountIdentifier: null,
    accountScope: scope ? scopeKey : 'codex-cli:local-login',
    scopeState: scope ? 'known' : 'unknown',
    scopeKey,
    scopeLabel: null,
  };
}

function reconcile(
  db: Database.Database,
  params: { scope?: string | null; method?: string; generation?: string; signal?: string | null; now?: string } = {},
) {
  return reconcileAuthBinding(db, {
    connectionId: CONNECTION,
    auth: auth(params.scope === undefined ? 'xinghai' : params.scope, params.method),
    cliGeneration: params.generation ?? 'gen-1',
    authStoreSignal: params.signal === undefined ? 'store-0:1:10:1000' : params.signal,
    now: params.now,
  });
}

function model(id: string, extra: Partial<CliCatalogModel> = {}): CliCatalogModel {
  return {
    id,
    invocationId: id,
    displayName: id,
    kind: 'model',
    isDefault: false,
    hidden: false,
    upgrade: null,
    retirementAt: null,
    reasoningEfforts: [],
    ...extra,
  };
}

describe('auth binding scope / epoch rules (design §6.1)', () => {
  it('first binding starts at epoch 1 with reason initial and is not reported as a change', () => {
    const db = freshDb();
    const result = reconcile(db, { now: '2026-09-25T00:00:00.000Z' });
    expect(result).toMatchObject({ epochChanged: false, reason: 'initial' });
    expect(result.binding).toMatchObject({
      connectionId: CONNECTION,
      scopeState: 'known',
      scopeKey: 'codex-cli:xinghai',
      authEpoch: 1,
      authMethod: 'chatgpt',
      bindingMode: 'snapshot_checked',
      cliGeneration: 'gen-1',
      observedAt: '2026-09-25T00:00:00.000Z',
      epochStartedAt: '2026-09-25T00:00:00.000Z',
      epochReason: 'initial',
    });
  });

  it('re-checking the same known scope keeps the epoch (even if the auth-store signal moved)', () => {
    const db = freshDb();
    reconcile(db, { now: '2026-09-25T00:00:00.000Z' });
    const again = reconcile(db, { signal: 'store-0:1:10:2000', now: '2026-09-25T01:00:00.000Z' });
    expect(again).toMatchObject({ epochChanged: false, reason: null });
    expect(again.binding).toMatchObject({
      authEpoch: 1,
      observedAt: '2026-09-25T01:00:00.000Z',
      // Epoch start and reason describe the epoch, not the latest observation.
      epochStartedAt: '2026-09-25T00:00:00.000Z',
      epochReason: 'initial',
      authStoreSignal: 'store-0:1:10:2000',
    });
  });

  it.each([
    ['scope_changed', { scope: 'datapilot' }],
    ['scope_changed', { scope: null }],
    ['method_changed', { method: 'chatgpt-enterprise' }],
    ['cli_generation_changed', { generation: 'gen-2' }],
  ] as const)('%s increments the epoch', (reason, change) => {
    const db = freshDb();
    reconcile(db, { now: '2026-09-25T00:00:00.000Z' });
    const changed = reconcile(db, { ...change, now: '2026-09-25T02:00:00.000Z' });
    expect(changed).toMatchObject({ epochChanged: true, reason });
    expect(changed.binding).toMatchObject({
      authEpoch: 2,
      epochStartedAt: '2026-09-25T02:00:00.000Z',
      epochReason: reason,
    });
  });

  it('unknown scope: an auth-store signal change increments the epoch; an unchanged signal does not', () => {
    const db = freshDb();
    expect(reconcile(db, { scope: null, signal: 'store-0:1:10:1000' }).binding.authEpoch).toBe(1);
    expect(reconcile(db, { scope: null, signal: 'store-0:1:10:1000' })).toMatchObject({
      epochChanged: false,
      binding: { authEpoch: 1, scopeState: 'unknown' },
    });
    expect(reconcile(db, { scope: null, signal: 'store-0:1:11:5000' })).toMatchObject({
      epochChanged: true,
      reason: 'unknown_scope_signal_changed',
      binding: { authEpoch: 2 },
    });
    // Keychain-only store appearing/disappearing is also a signal change.
    expect(reconcile(db, { scope: null, signal: null })).toMatchObject({
      reason: 'unknown_scope_signal_changed',
      binding: { authEpoch: 3 },
    });
  });

  it('authBindingMatches is an exact scope + epoch CAS', () => {
    const db = freshDb();
    reconcile(db);
    expect(authBindingMatches(db, CONNECTION, 'codex-cli:xinghai', 1)).toBe(true);
    expect(authBindingMatches(db, CONNECTION, 'codex-cli:xinghai', 2)).toBe(false);
    expect(authBindingMatches(db, CONNECTION, 'codex-cli:datapilot', 1)).toBe(false);
    expect(authBindingMatches(db, 'mc_other', 'codex-cli:xinghai', 1)).toBe(false);
    reconcile(db, { generation: 'gen-2' });
    expect(authBindingMatches(db, CONNECTION, 'codex-cli:xinghai', 1)).toBe(false);
    expect(getAuthBinding(db, CONNECTION)?.authEpoch).toBe(2);
  });
});

describe('catalog snapshots (design §5.2 / §6)', () => {
  it('saves a complete snapshot, bumps the revision on replacement and derives the default', () => {
    const db = freshDb();
    const { binding } = reconcile(db);
    expect(saveCatalogSnapshot(db, {
      connectionId: CONNECTION,
      scopeKey: binding.scopeKey,
      authEpoch: binding.authEpoch,
      cliGeneration: 'gen-1',
      source: 'codex_app_server',
      items: [model('gpt-5.3-codex', { isDefault: true }), model('gpt-5.2')],
      now: '2026-09-25T00:00:00.000Z',
    })).toBe(true);
    expect(getCatalogSnapshot(db, CONNECTION)).toMatchObject({
      revision: 1,
      defaultModelId: 'gpt-5.3-codex',
      fetchedAt: '2026-09-25T00:00:00.000Z',
      items: [expect.objectContaining({ id: 'gpt-5.3-codex' }), expect.objectContaining({ id: 'gpt-5.2' })],
    });
    expect(saveCatalogSnapshot(db, {
      connectionId: CONNECTION,
      scopeKey: binding.scopeKey,
      authEpoch: binding.authEpoch,
      cliGeneration: 'gen-1',
      source: 'codex_app_server',
      items: [model('gpt-6')],
      now: '2026-09-25T01:00:00.000Z',
    })).toBe(true);
    expect(getCatalogSnapshot(db, CONNECTION)).toMatchObject({
      revision: 2,
      defaultModelId: null,
      items: [expect.objectContaining({ id: 'gpt-6' })],
    });
  });

  it('discards a late response after the epoch changed (CAS) and keeps the previous snapshot', () => {
    const db = freshDb();
    const { binding: started } = reconcile(db);
    saveCatalogSnapshot(db, {
      connectionId: CONNECTION,
      scopeKey: started.scopeKey,
      authEpoch: started.authEpoch,
      cliGeneration: 'gen-1',
      source: 'codex_app_server',
      items: [model('gpt-5.3-codex')],
      now: '2026-09-25T00:00:00.000Z',
    });
    // Account switched while a refresh for the old account was in flight.
    reconcile(db, { scope: 'datapilot' });
    expect(saveCatalogSnapshot(db, {
      connectionId: CONNECTION,
      scopeKey: started.scopeKey,
      authEpoch: started.authEpoch,
      cliGeneration: 'gen-1',
      source: 'codex_app_server',
      items: [model('stale-account-model')],
    })).toBe(false);
    expect(getCatalogSnapshot(db, CONNECTION)).toMatchObject({
      revision: 1,
      items: [expect.objectContaining({ id: 'gpt-5.3-codex' })],
    });
    // Without any binding nothing is written.
    expect(saveCatalogSnapshot(db, {
      connectionId: 'mc_unbound',
      scopeKey: 'codex-cli:xinghai',
      authEpoch: 1,
      cliGeneration: 'gen-1',
      source: 'codex_app_server',
      items: [model('gpt-5.3-codex')],
    })).toBe(false);
    expect(getCatalogSnapshot(db, 'mc_unbound')).toBeNull();
  });

  it('a refresh failure only records the attempt and never replaces a complete snapshot', () => {
    const db = freshDb();
    const { binding } = reconcile(db);
    saveCatalogSnapshot(db, {
      connectionId: CONNECTION,
      scopeKey: binding.scopeKey,
      authEpoch: binding.authEpoch,
      cliGeneration: 'gen-1',
      source: 'codex_app_server',
      items: [model('gpt-5.3-codex'), model('gpt-5.2')],
      now: '2026-09-25T00:00:00.000Z',
    });
    recordCatalogRefreshFailure(db, CONNECTION, 'timeout', 'Codex metadata refresh timed out', '2026-09-25T03:00:00.000Z');
    expect(getCatalogSnapshot(db, CONNECTION)).toMatchObject({
      revision: 1,
      fetchedAt: '2026-09-25T00:00:00.000Z',
      items: [expect.objectContaining({ id: 'gpt-5.3-codex' }), expect.objectContaining({ id: 'gpt-5.2' })],
      lastAttemptAt: '2026-09-25T03:00:00.000Z',
      lastAttemptErrorKind: 'timeout',
      lastAttemptError: 'Codex metadata refresh timed out',
    });
    // Bounded diagnostics.
    recordCatalogRefreshFailure(db, CONNECTION, 'k'.repeat(200), 'm'.repeat(2_000));
    const snapshot = getCatalogSnapshot(db, CONNECTION)!;
    expect(snapshot.lastAttemptErrorKind).toHaveLength(64);
    expect(snapshot.lastAttemptError).toHaveLength(500);
    // A subsequent successful refresh clears the attempt error.
    saveCatalogSnapshot(db, {
      connectionId: CONNECTION,
      scopeKey: binding.scopeKey,
      authEpoch: binding.authEpoch,
      cliGeneration: 'gen-1',
      source: 'codex_app_server',
      items: [model('gpt-5.3-codex')],
    });
    expect(getCatalogSnapshot(db, CONNECTION)).toMatchObject({
      revision: 2,
      lastAttemptErrorKind: null,
      lastAttemptError: null,
    });
  });

  it('a first-time refresh failure does not create a successful empty catalog', () => {
    const db = freshDb();
    reconcile(db);
    recordCatalogRefreshFailure(db, CONNECTION, 'protocol', 'bad page');
    expect(getCatalogSnapshot(db, CONNECTION)).toBeNull();
  });

  it('corrupt items_json reads back as an empty list instead of throwing', () => {
    const db = freshDb();
    const { binding } = reconcile(db);
    saveCatalogSnapshot(db, {
      connectionId: CONNECTION,
      scopeKey: binding.scopeKey,
      authEpoch: binding.authEpoch,
      cliGeneration: 'gen-1',
      source: 'codex_app_server',
      items: [model('gpt-5.3-codex')],
    });
    db.prepare("UPDATE llm_model_catalog_snapshots SET items_json = '{broken' WHERE connection_id = ?").run(CONNECTION);
    expect(getCatalogSnapshot(db, CONNECTION)?.items).toEqual([]);
  });
});

describe('model observations upsert semantics', () => {
  const base = {
    connectionId: CONNECTION,
    scopeKey: 'codex-cli:xinghai',
    authEpoch: 1,
    modelId: 'gpt-5.3-codex',
    selectionMode: 'pinned_id' as const,
  };

  it('success writes last_success_at; a later failure keeps it and sets last_failure_at', () => {
    const db = freshDb();
    recordModelObservation(db, {
      ...base,
      outcome: 'success',
      source: 'business',
      actualModel: 'gpt-5.3-codex',
      now: '2026-09-25T00:00:00.000Z',
    });
    expect(getModelObservation(db, CONNECTION, base.scopeKey, 1, base.modelId)).toMatchObject({
      lastOutcome: 'success',
      lastSource: 'business',
      lastSuccessAt: '2026-09-25T00:00:00.000Z',
      lastFailureAt: null,
      actualModel: 'gpt-5.3-codex',
    });
    recordModelObservation(db, {
      ...base,
      outcome: 'temporary_failure',
      source: 'business',
      errorKind: 'rate_limit',
      errorMessage: 'x'.repeat(900),
      backoffUntil: '2026-09-25T01:05:00.000Z',
      now: '2026-09-25T01:00:00.000Z',
    });
    const failed = getModelObservation(db, CONNECTION, base.scopeKey, 1, base.modelId)!;
    expect(failed).toMatchObject({
      lastOutcome: 'temporary_failure',
      errorKind: 'rate_limit',
      lastSuccessAt: '2026-09-25T00:00:00.000Z',
      lastFailureAt: '2026-09-25T01:00:00.000Z',
      backoffUntil: '2026-09-25T01:05:00.000Z',
      // actual model of the last success is kept when the failure reports none.
      actualModel: 'gpt-5.3-codex',
      updatedAt: '2026-09-25T01:00:00.000Z',
    });
    expect(failed.errorMessage).toHaveLength(500);

    recordModelObservation(db, {
      ...base,
      outcome: 'success',
      source: 'test',
      now: '2026-09-25T02:00:00.000Z',
    });
    expect(getModelObservation(db, CONNECTION, base.scopeKey, 1, base.modelId)).toMatchObject({
      lastOutcome: 'success',
      lastSource: 'test',
      errorKind: null,
      errorMessage: null,
      backoffUntil: null,
      lastSuccessAt: '2026-09-25T02:00:00.000Z',
      lastFailureAt: '2026-09-25T01:00:00.000Z',
    });
  });

  it('observations are keyed by scope + epoch; listing returns current and historical epochs newest first', () => {
    const db = freshDb();
    recordModelObservation(db, { ...base, outcome: 'model_rejected', source: 'test', now: '2026-09-25T00:00:00.000Z' });
    recordModelObservation(db, { ...base, authEpoch: 2, outcome: 'success', source: 'business', now: '2026-09-25T01:00:00.000Z' });
    recordModelObservation(db, { ...base, authEpoch: 2, modelId: 'gpt-5.2', outcome: 'success', source: 'business', now: '2026-09-25T02:00:00.000Z' });
    expect(getModelObservation(db, CONNECTION, base.scopeKey, 1, base.modelId)?.lastOutcome).toBe('model_rejected');
    expect(getModelObservation(db, CONNECTION, base.scopeKey, 2, base.modelId)?.lastOutcome).toBe('success');
    expect(getModelObservation(db, CONNECTION, 'codex-cli:datapilot', 2, base.modelId)).toBeNull();
    expect(listModelObservations(db, CONNECTION).map(o => [o.authEpoch, o.modelId])).toEqual([
      [2, 'gpt-5.2'],
      [2, 'gpt-5.3-codex'],
      [1, 'gpt-5.3-codex'],
    ]);
    expect(listModelObservations(db, 'mc_other')).toEqual([]);
  });
});
