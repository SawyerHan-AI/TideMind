import { describe, expect, it } from 'vitest';
import { createTestDb } from '../../src/db/connection.js';
import {
  assertConnectionHealthCallable, getConnectionHealth, recordConnectionFailure,
  recoverCliConnectionHealth,
} from '../../src/llm/connection-health.js';

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
