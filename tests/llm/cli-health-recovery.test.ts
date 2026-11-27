import { describe, expect, it } from 'vitest';
import { createTestDb } from '../../src/db/connection.js';
import {
  assertConnectionHealthCallable, getConnectionHealth, recordConnectionFailure,
  recordConnectionSuccess, recoverCliConnectionHealth,
} from '../../src/llm/connection-health.js';
import { identityUnobservedError } from '../../src/llm/cli/errors.js';

describe('CLI permission failure recovery', () => {
  it('requires a successful model test before recovering an earlier permission failure', () => {
    const db = createTestDb();
    try {
      recordConnectionFailure(db, {
        scopeId: 'mc_fixture', connectionId: 'mc_fixture', providerType: 'codex-cli',
        modelAlias: 'default', outcome: 'definite_failure',
        error: { kind: 'permission_policy', message: 'fixture permissions invalid' },
      });
      const startedAt = Date.now() + 1;
      expect(() => assertConnectionHealthCallable(db, 'mc_fixture')).toThrow();
      recoverCliConnectionHealth(db, 'mc_fixture', startedAt);
      expect(() => assertConnectionHealthCallable(db, 'mc_fixture')).toThrow();
      recoverCliConnectionHealth(db, 'mc_fixture', startedAt, true);
      expect(() => assertConnectionHealthCallable(db, 'mc_fixture')).not.toThrow();
      expect(getConnectionHealth(db, 'mc_fixture')).toMatchObject({
        circuitState: 'closed', needsUserAction: false, lastSuccessAt: null,
      });
    } finally { db.close(); }
  });

  it('keeps an older ambiguous outcome blocked after an otherwise successful test', () => {
    const db = createTestDb();
    try {
      recordConnectionFailure(db, {
        scopeId: 'mc_fixture', connectionId: 'mc_fixture', providerType: 'codex-cli',
        modelAlias: 'default', outcome: 'ambiguous',
        error: { kind: 'ambiguous_outcome', message: 'unresolved invocation', needsUserAction: true },
      });
      recoverCliConnectionHealth(db, 'mc_fixture', Date.now() + 1, true);
      expect(getConnectionHealth(db, 'mc_fixture')?.lastErrorKind).toBe('ambiguous_outcome');
      expect(() => assertConnectionHealthCallable(db, 'mc_fixture')).toThrow();
    } finally { db.close(); }
  });

  it.each(['permission_policy', 'ambiguous_outcome'] as const)('does not erase a newer %s failure', kind => {
    const db = createTestDb();
    try {
      const startedAt = Date.now() - 1;
      recordConnectionFailure(db, {
        scopeId: 'mc_fixture', connectionId: 'mc_fixture', providerType: 'codex-cli',
        modelAlias: 'default', outcome: 'definite_failure',
        error: { kind, message: 'new failure', needsUserAction: true },
      });
      recoverCliConnectionHealth(db, 'mc_fixture', startedAt, true);
      expect(getConnectionHealth(db, 'mc_fixture')?.lastErrorKind).toBe(kind);
      expect(() => assertConnectionHealthCallable(db, 'mc_fixture')).toThrow();
    } finally { db.close(); }
  });
});

describe('an unobserved account identity only pauses the connection temporarily', () => {
  const event = {
    scopeId: 'mc_fixture', connectionId: 'mc_fixture', providerType: 'codex-cli' as const,
    modelAlias: 'default',
  };
  const unobserved = () => {
    const error = identityUnobservedError();
    return { kind: 'transient' as const, message: error.message, needsUserAction: error.options.needsUserAction };
  };

  it('opens only on the third consecutive failure, retries on its own and closes on success', () => {
    const db = createTestDb();
    try {
      for (let i = 0; i < 2; i += 1) {
        recordConnectionFailure(db, { ...event, outcome: 'definite_failure', error: unobserved() });
        expect(() => assertConnectionHealthCallable(db, 'mc_fixture')).not.toThrow();
      }
      recordConnectionFailure(db, { ...event, outcome: 'definite_failure', error: unobserved() });
      const open = getConnectionHealth(db, 'mc_fixture')!;
      expect(open).toMatchObject({ circuitState: 'open', needsUserAction: false, failureCount: 3 });
      expect(open.retryAt).toBeGreaterThan(Date.now());
      expect(() => assertConnectionHealthCallable(db, 'mc_fixture')).toThrow();
      // Cooldown over: exactly one half-open probe is admitted, with the requested lease.
      const later = open.retryAt! + 1;
      db.prepare('UPDATE llm_connection_health SET retry_at = ?, opened_at = ? WHERE scope_id = ?')
        .run(Date.now() - 1, Date.now() - 10 * 60_000, 'mc_fixture');
      const leaseMs = 360_000 + 60_000 + 45_000;
      const token = assertConnectionHealthCallable(db, 'mc_fixture', later, leaseMs);
      expect(token).toEqual(expect.any(String));
      expect(db.prepare('SELECT expires_at FROM llm_connection_probe_leases WHERE scope_id = ?').get('mc_fixture'))
        .toEqual({ expires_at: later + leaseMs });
      expect(() => assertConnectionHealthCallable(db, 'mc_fixture', later, leaseMs)).toThrow();
      db.prepare('UPDATE llm_connection_probe_leases SET expires_at = ? WHERE scope_id = ?')
        .run(Date.now() + leaseMs, 'mc_fixture');
      recordConnectionSuccess(db, { ...event, outcome: 'success', probeToken: token });
      expect(getConnectionHealth(db, 'mc_fixture')).toMatchObject({ circuitState: 'closed', failureCount: 0 });
    } finally { db.close(); }
  });
});
