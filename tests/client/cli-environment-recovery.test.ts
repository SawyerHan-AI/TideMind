import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_s: string, _p: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

import type Database from 'better-sqlite3';
import { createTestDb } from '../../src/db/connection.js';
import {
  getAuthBinding,
  reconcileAuthBinding,
  recordModelObservation,
} from '../../src/db/model-discovery.js';
import { CliLLMError, identityUnobservedError } from '../../src/llm/cli/errors.js';
import { assertConnectionHealthCallable, getConnectionHealth } from '../../src/llm/connection-health.js';
import type { CliEnvironmentCheck } from '../../src/llm/cli/readiness.js';
import type { CliIdentityProbe } from '../../src/llm/cli/types.js';
import {
  recoverCliEnvironmentsOnce,
  recoveryRetryDelayMs,
} from '../../client/electron/ipc/cli-environment-recovery.js';

const ID = 'mc_c0decafe';
const OBSERVED: CliIdentityProbe = { status: 'observed' };

function environment(options: { scope?: string | null; generation?: string; probe?: CliIdentityProbe } = {}): CliEnvironmentCheck {
  const scope = options.scope === undefined ? 'xinghai-workspace' : options.scope;
  const generation = options.generation ?? 'generation-1';
  return {
    providerType: 'codex-cli',
    status: 'untested',
    resolved: {
      kind: 'codex', path: '/opt/fixture/bin/codex', version: '0.167.1', controlledPath: '/usr/bin:/bin',
      source: 'known_path', identity: { device: 1, inode: 1, size: 1, ctimeMs: 1, sha256: 'fixture' },
    },
    auth: {
      providerType: 'codex-cli', method: 'chatgpt', accountIdentifier: null,
      accountScope: scope ? `codex-cli:${scope}` : 'codex-cli:local-login',
      scopeState: scope ? 'known' : 'unknown',
      scopeKey: scope ? `codex-cli:${scope}` : 'codex-cli:unknown',
      scopeLabel: scope ? 'pro' : null,
    },
    identityProbe: options.probe ?? OBSERVED,
    authStoreSignal: null,
    authFingerprint: `auth-${scope ?? 'unknown'}`,
    cliGeneration: generation,
    validationFingerprint: generation,
    capabilityFingerprint: 'capability-fixture',
    capabilityStatus: 'verified',
    checkedAt: '2026-11-27T12:00:00.000Z',
  } as CliEnvironmentCheck;
}

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

function seed(status = 'online'): Database.Database {
  const db = createTestDb();
  dbs.push(db);
  db.prepare(`
    INSERT INTO model_connections
      (id, name, provider_type, credentials, status, cli_path, cli_version, auth_method, auth_fingerprint,
       validation_fingerprint, created)
    VALUES (?, 'Codex - 星海', 'codex-cli', '{}', ?, '/opt/fixture/bin/codex', '0.167.1', 'chatgpt',
            'auth-xinghai-workspace', 'generation-1', '2026-11-10T00:00:00.000Z')
  `).run(ID, status);
  return db;
}

function bind(db: Database.Database, env = environment()) {
  return reconcileAuthBinding(db, {
    connectionId: ID, auth: env.auth, cliGeneration: env.cliGeneration,
    authStoreSignal: env.authStoreSignal, identityProbe: env.identityProbe,
  }).binding;
}

function succeed(db: Database.Database, binding = getAuthBinding(db, ID)!) {
  recordModelObservation(db, {
    connectionId: ID, scopeKey: binding.scopeKey, authEpoch: binding.authEpoch, modelId: 'default',
    selectionMode: 'follow_default', outcome: 'success', source: 'business',
  });
}

function openCircuit(db: Database.Database, kind: string, at = 1_000, message = 'fixture failure') {
  db.prepare(`
    INSERT INTO llm_connection_health
      (scope_id, connection_id, provider_type, circuit_state, failure_count, opened_at, last_error_kind,
       last_error_message, last_error_at, needs_user_action, updated_at)
    VALUES (?, ?, 'codex-cli', 'open', 1, ?, ?, ?, ?, 1, '2026-11-26T03:03:01.000Z')
    ON CONFLICT(scope_id) DO UPDATE SET circuit_state = 'open', last_error_kind = excluded.last_error_kind,
      last_error_message = excluded.last_error_message, last_error_at = excluded.last_error_at,
      needs_user_action = 1, opened_at = excluded.opened_at
  `).run(ID, ID, at, kind, message, at);
}

function deps(check: () => Promise<CliEnvironmentCheck>, busy = false) {
  const checkEnvironment = vi.fn(check);
  const finish = vi.fn();
  return {
    checkEnvironment,
    finish,
    beginOperation: vi.fn(() => busy ? null : { signal: new AbortController().signal, finish }),
    now: () => 2_000,
  };
}

const circuit = (db: Database.Database) => getConnectionHealth(db, ID)?.circuitState;
const row = (db: Database.Database, table: string, key = 'connection_id') =>
  db.prepare(`SELECT * FROM ${table} WHERE ${key} = ?`).get(ID);

describe('unattended recovery of a paused local-subscription connection', () => {
  it('2026-11-20 state: binding already restored, circuit still open → closed without the user', async () => {
    const db = seed();
    succeed(db, bind(db));
    // The old build rewrote the binding to unknown and a later refresh restored it.
    bind(db, environment({ scope: null }));
    expect(bind(db)).toMatchObject({ epochReason: 'known_scope_restored', authEpoch: 1 });
    openCircuit(db, 'not_authenticated', 1_000, 'CLI 或账号范围发生变化，调用归属无法确认');
    const d = deps(async () => environment());

    await expect(recoverCliEnvironmentsOnce(db, '/tmp/data', d)).resolves.toEqual({ recovered: [ID], pending: 0 });
    expect(d.checkEnvironment).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      freshAuth: true, allowLoginShell: false, candidatePath: '/opt/fixture/bin/codex',
    }));
    expect(d.finish).toHaveBeenCalledOnce();
    expect(circuit(db)).toBe('closed');
    expect(() => assertConnectionHealthCallable(db, ID)).not.toThrow();
    // A check is not a business success.
    expect(getConnectionHealth(db, ID)?.lastSuccessAt).toBeNull();
  });

  it('binding still unknown with a matching last-known scope → binding restored and circuit closed', async () => {
    const db = seed();
    succeed(db, bind(db));
    bind(db, environment({ scope: null }));
    openCircuit(db, 'scope_unknown');
    await expect(recoverCliEnvironmentsOnce(db, '/tmp/data', deps(async () => environment())))
      .resolves.toEqual({ recovered: [ID], pending: 0 });
    expect(getAuthBinding(db, ID)).toMatchObject({ scopeState: 'known', authEpoch: 1, epochReason: 'known_scope_restored' });
    expect(circuit(db)).toBe('closed');
  });

  it('an unknown binding without an open circuit is restored too', async () => {
    const db = seed();
    succeed(db, bind(db));
    bind(db, environment({ scope: null }));
    await expect(recoverCliEnvironmentsOnce(db, '/tmp/data', deps(async () => environment())))
      .resolves.toEqual({ recovered: [ID], pending: 0 });
    expect(getAuthBinding(db, ID)).toMatchObject({ scopeState: 'known', authEpoch: 1 });
  });

  it('logged out and back into the same account → closed', async () => {
    const db = seed('not_authenticated');
    succeed(db, bind(db));
    openCircuit(db, 'not_authenticated', 1_000, 'Codex CLI is not logged in');
    await recoverCliEnvironmentsOnce(db, '/tmp/data', deps(async () => environment()));
    expect(circuit(db)).toBe('closed');
    // Selected although the connection status is not `online`, and healed like a passing check.
    expect((row(db, 'model_connections', 'id') as { status: string }).status).toBe('untested');
  });

  it('an account switch found mid-call is never adopted: same new account observed, circuit stays open', async () => {
    const db = seed();
    succeed(db, bind(db));
    // What the service does on a real switch: rewrite the binding first, then fail.
    const switched = bind(db, environment({ scope: 'datapilot-workspace' }));
    expect(switched).toMatchObject({ authEpoch: 2, epochReason: 'scope_changed' });
    openCircuit(db, 'not_authenticated', 1_000, 'CLI 或账号范围发生变化，调用归属无法确认');
    const before = row(db, 'llm_connection_auth_bindings');
    const result = await recoverCliEnvironmentsOnce(db, '/tmp/data', deps(async () => environment({ scope: 'datapilot-workspace' })));
    expect(result).toEqual({ recovered: [], pending: 1 });
    expect(circuit(db)).toBe('open');
    expect((row(db, 'llm_connection_auth_bindings') as { auth_epoch: number }).auth_epoch)
      .toBe((before as { auth_epoch: number }).auth_epoch);
    // Once the user has run that account successfully (an explicit test), it is proven.
    succeed(db);
    await recoverCliEnvironmentsOnce(db, '/tmp/data', deps(async () => environment({ scope: 'datapilot-workspace' })));
    expect(circuit(db)).toBe('closed');
  });

  it('a CLI generation change found mid-call is not adopted either', async () => {
    const db = seed();
    succeed(db, bind(db));
    bind(db, environment({ generation: 'generation-2' }));
    openCircuit(db, 'not_authenticated');
    await recoverCliEnvironmentsOnce(db, '/tmp/data', deps(async () => environment({ generation: 'generation-2' })));
    expect(circuit(db)).toBe('open');
  });

  it('observing an account different from the binding changes nothing about identity', async () => {
    const db = seed();
    succeed(db, bind(db));
    openCircuit(db, 'not_authenticated', 1_000, 'Codex CLI is not logged in');
    const before = { binding: row(db, 'llm_connection_auth_bindings'), connection: row(db, 'model_connections', 'id') };
    await recoverCliEnvironmentsOnce(db, '/tmp/data', deps(async () => environment({ scope: 'datapilot-workspace' })));
    expect(circuit(db)).toBe('open');
    expect({ binding: row(db, 'llm_connection_auth_bindings'), connection: row(db, 'model_connections', 'id') }).toEqual(before);
  });

  it.each([
    ['a cached identity', async () => environment({ probe: { status: 'cached' } })],
    ['a probe field that is missing', async () => ({ ...environment(), identityProbe: undefined }) as unknown as CliEnvironmentCheck],
    ['an account without a workspace id', async () => environment({ scope: null })],
  ])('%s does not confirm the account', async (_name, check) => {
    const db = seed();
    succeed(db, bind(db));
    openCircuit(db, 'not_authenticated');
    await recoverCliEnvironmentsOnce(db, '/tmp/data', deps(check));
    expect(circuit(db)).toBe('open');
  });

  it.each([
    ['the read failed', async () => environment({ scope: null, probe: { status: 'failed', kind: 'timeout', elapsedMs: 10_000 } })],
    ['the status command did not finish', async () => { throw identityUnobservedError(); }],
    ['the user is really logged out', async () => { throw new CliLLMError('not_authenticated', 'Codex CLI is not logged in'); }],
  ])('writes nothing when %s', async (_name, check) => {
    const db = seed();
    succeed(db, bind(db));
    openCircuit(db, 'unsupported_version');
    const before = {
      binding: row(db, 'llm_connection_auth_bindings'), connection: row(db, 'model_connections', 'id'),
      health: row(db, 'llm_connection_health'),
    };
    const d = deps(check as () => Promise<CliEnvironmentCheck>);
    await expect(recoverCliEnvironmentsOnce(db, '/tmp/data', d)).resolves.toEqual({ recovered: [], pending: 1 });
    expect({
      binding: row(db, 'llm_connection_auth_bindings'), connection: row(db, 'model_connections', 'id'),
      health: row(db, 'llm_connection_health'),
    }).toEqual(before);
    expect(d.finish).toHaveBeenCalledOnce();
  });

  it('the 2026-11-27 production row: a model-level failure recorded as unsupported_version is cleared', async () => {
    const db = seed();
    succeed(db, bind(db));
    openCircuit(db, 'unsupported_version', 1_000,
      'Selected model is absent from the verified Codex execution catalog; update Codex CLI');
    await expect(recoverCliEnvironmentsOnce(db, '/tmp/data', deps(async () => environment())))
      .resolves.toEqual({ recovered: [ID], pending: 0 });
    expect(circuit(db)).toBe('closed');
  });

  it('environment-only failures are cleared even when the account cannot be confirmed', async () => {
    const db = seed();
    succeed(db, bind(db));
    openCircuit(db, 'not_installed');
    await recoverCliEnvironmentsOnce(db, '/tmp/data', deps(async () => environment({ scope: 'datapilot-workspace' })));
    expect(circuit(db)).toBe('closed');
    // …and the binding still belongs to the original account.
    expect(getAuthBinding(db, ID)).toMatchObject({ scopeKey: 'codex-cli:xinghai-workspace', authEpoch: 1 });
  });

  it.each(['ambiguous_outcome', 'permission_policy', 'quota', 'protocol', 'transient'])(
    'never selects or clears a %s failure', async (kind) => {
      const db = seed();
      succeed(db, bind(db));
      openCircuit(db, kind);
      const d = deps(async () => environment());
      await expect(recoverCliEnvironmentsOnce(db, '/tmp/data', d)).resolves.toEqual({ recovered: [], pending: 0 });
      expect(d.checkEnvironment).not.toHaveBeenCalled();
      expect(circuit(db)).toBe('open');
    });

  it('a failure recorded after the check started is kept', async () => {
    const db = seed();
    succeed(db, bind(db));
    openCircuit(db, 'not_authenticated', 5_000);
    await recoverCliEnvironmentsOnce(db, '/tmp/data', deps(async () => environment()));
    expect(circuit(db)).toBe('open');
  });

  it.each(['ambiguous', 'checking', 'testing'])('skips a connection whose status is %s', async (status) => {
    const db = seed(status);
    succeed(db, bind(db));
    openCircuit(db, 'not_authenticated');
    const d = deps(async () => environment());
    await recoverCliEnvironmentsOnce(db, '/tmp/data', d);
    expect(d.checkEnvironment).not.toHaveBeenCalled();
    expect(circuit(db)).toBe('open');
  });

  it('skips a connection the user is checking or testing right now', async () => {
    const db = seed();
    succeed(db, bind(db));
    openCircuit(db, 'not_authenticated');
    const d = deps(async () => environment(), true);
    await expect(recoverCliEnvironmentsOnce(db, '/tmp/data', d)).resolves.toEqual({ recovered: [], pending: 1 });
    expect(d.checkEnvironment).not.toHaveBeenCalled();
  });

  it('a connection without any binding keeps its identity failure', async () => {
    const db = seed();
    openCircuit(db, 'not_authenticated');
    await recoverCliEnvironmentsOnce(db, '/tmp/data', deps(async () => environment()));
    expect(circuit(db)).toBe('open');
    expect(getAuthBinding(db, ID)).toBeNull();
  });

  it('gives up on a connection whose row moved during the check', async () => {
    const db = seed();
    succeed(db, bind(db));
    openCircuit(db, 'not_authenticated');
    const d = deps(async () => {
      db.prepare("UPDATE model_connections SET cli_path = '/opt/other/codex' WHERE id = ?").run(ID);
      return environment();
    });
    await expect(recoverCliEnvironmentsOnce(db, '/tmp/data', d)).resolves.toEqual({ recovered: [], pending: 1 });
    expect(circuit(db)).toBe('open');
  });

  it('retries sooner while something is pending: 5, 10, 20, 40, then 60 minutes', () => {
    expect([0, 1, 2, 3, 4, 5, 50].map((attempt) => recoveryRetryDelayMs(attempt) / 60_000))
      .toEqual([5, 10, 20, 40, 60, 60, 60]);
  });
});
