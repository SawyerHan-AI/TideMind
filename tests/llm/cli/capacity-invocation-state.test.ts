import Database from 'better-sqlite3';
import { vi } from 'vitest';
import { ensureSchema } from '../../../src/db/schema.js';
import {
  acquireCliCapacityLease,
  renewCliCapacityLease,
  withCliCapacityLease,
} from '../../../src/llm/cli/capacity-lease.js';
import {
  finishCliInvocation,
  finishCliInvocationFenced,
  markCliPromptCommitted,
  reconcileCliRuntimeState,
  startCliInvocation,
} from '../../../src/llm/cli/invocation-state.js';

function database(): Database.Database {
  const db = new Database(':memory:');
  ensureSchema(db);
  db.prepare(`
    INSERT INTO model_connections (
      id, name, provider_type, credentials, status, archived, created
    ) VALUES ('mc_12345678', 'Codex', 'codex-cli', '{}', 'online', 0, ?)
  `).run(new Date().toISOString());
  return db;
}

function invocation(db: Database.Database, id: string) {
  return startCliInvocation(db, {
    id,
    connectionId: 'mc_12345678',
    providerType: 'codex-cli',
    accountScope: 'codex:test',
    taskId: 'digest_1',
    operationName: 'digest',
    modelAlias: 'default',
  });
}

describe('production CLI lease and invocation fencing', () => {
  it('rejects renewal and prompt commit after the lease has expired', () => {
    const db = database();
    invocation(db, 'inv_expired');
    const lease = acquireCliCapacityLease(db, {
      accountScope: 'codex:test',
      connectionId: 'mc_12345678',
      invocationId: 'inv_expired',
      ownerId: 'owner-a',
      ownerPid: process.pid,
      nowMs: 1_000,
      leaseMs: 100,
    });
    expect(() => renewCliCapacityLease(db, lease, 100, 1_101))
      .toThrowError(expect.objectContaining({ kind: 'capacity' }));
    expect(() => markCliPromptCommitted(db, 'inv_expired', lease)).toThrow();
    expect(db.prepare('SELECT prompt_committed FROM cli_invocations WHERE id = ?').get('inv_expired'))
      .toEqual({ prompt_committed: 0 });
  });

  it('prevents a stale owner from committing success after fencing loss', () => {
    const db = database();
    invocation(db, 'inv_old');
    const oldLease = acquireCliCapacityLease(db, {
      accountScope: 'codex:test',
      connectionId: 'mc_12345678',
      invocationId: 'inv_old',
      ownerId: 'owner-a',
      ownerPid: 2_147_483_647,
      nowMs: 1_000,
      leaseMs: 100,
    });
    db.prepare(`
      UPDATE cli_capacity_leases SET lease_expires_at = 0
      WHERE account_scope = 'codex:test'
    `).run();
    invocation(db, 'inv_new');
    acquireCliCapacityLease(db, {
      accountScope: 'codex:test',
      connectionId: 'mc_12345678',
      invocationId: 'inv_new',
      ownerId: 'owner-b',
      ownerPid: process.pid,
      nowMs: 2_000,
      leaseMs: 10_000,
    });
    expect(finishCliInvocationFenced(db, {
      invocationId: 'inv_old',
      outcome: 'success',
      actualModel: 'gpt-5.6-sol',
    }, oldLease, 2_001)).toBe(false);
    expect(db.prepare('SELECT outcome FROM cli_invocations WHERE id = ?').get('inv_old'))
      .toEqual({ outcome: 'running' });
  });

  it('never takes over an expired lease while the previous owner PID is alive', () => {
    const db = database();
    invocation(db, 'inv_live_owner');
    acquireCliCapacityLease(db, {
      accountScope: 'codex:live-owner',
      connectionId: 'mc_12345678',
      invocationId: 'inv_live_owner',
      ownerId: 'owner-live',
      ownerPid: process.pid,
      nowMs: 1_000,
      leaseMs: 100,
    });
    db.prepare(`
      UPDATE cli_capacity_leases SET lease_expires_at = 0
      WHERE account_scope = 'codex:live-owner'
    `).run();
    invocation(db, 'inv_takeover');
    expect(() => acquireCliCapacityLease(db, {
      accountScope: 'codex:live-owner',
      connectionId: 'mc_12345678',
      invocationId: 'inv_takeover',
      ownerId: 'owner-new',
      ownerPid: process.pid,
      nowMs: 2_000,
    })).toThrowError(expect.objectContaining({ kind: 'capacity' }));
  });

  it('does not reconcile an invocation during the expiry grace window', () => {
    const db = database();
    invocation(db, 'inv_grace');
    db.prepare('UPDATE cli_invocations SET prompt_committed = 1 WHERE id = ?').run('inv_grace');
    acquireCliCapacityLease(db, {
      accountScope: 'codex:test',
      connectionId: 'mc_12345678',
      invocationId: 'inv_grace',
      ownerId: 'owner-a',
      ownerPid: process.pid,
      nowMs: 1_000,
      leaseMs: 100,
    });
    const result = reconcileCliRuntimeState(db, 1_101);
    expect(result.ambiguousInvocations).toEqual([]);
    expect(db.prepare('SELECT outcome FROM cli_invocations WHERE id = ?').get('inv_grace'))
      .toEqual({ outcome: 'running' });
  });

  it('preserves an expired running lease beyond grace while its owner PID is alive', () => {
    const db = database();
    invocation(db, 'inv_live_stalled');
    acquireCliCapacityLease(db, {
      accountScope: 'codex:live-stalled',
      connectionId: 'mc_12345678',
      invocationId: 'inv_live_stalled',
      ownerId: 'owner-live-stalled',
      ownerPid: process.pid,
      nowMs: 1_000,
      leaseMs: 100,
    });
    const result = reconcileCliRuntimeState(db, 180_000);
    expect(result.definiteFailures).toEqual([]);
    expect(db.prepare(`
      SELECT owner_id FROM cli_capacity_leases
      WHERE account_scope = 'codex:live-stalled'
    `).get()).toEqual({ owner_id: 'owner-live-stalled' });
  });

  it('does not overwrite a completed provider result when lease cleanup fails', async () => {
    const db = database();
    invocation(db, 'inv_cleanup');
    let failDelete = false;
    const originalPrepare = db.prepare.bind(db);
    const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (failDelete && sql.includes('DELETE FROM cli_capacity_leases')) {
        throw new Error('simulated cleanup I/O failure');
      }
      return originalPrepare(sql);
    });
    const result = await withCliCapacityLease(db, {
      accountScope: 'codex:test',
      connectionId: 'mc_12345678',
      invocationId: 'inv_cleanup',
      leaseMs: 5_000,
    }, async () => {
      finishCliInvocation(db, {
        invocationId: 'inv_cleanup',
        outcome: 'success',
      });
      failDelete = true;
      return 'provider-result';
    });
    expect(result).toBe('provider-result');
    expect(db.prepare('SELECT COUNT(*) AS count FROM cli_capacity_leases').get())
      .toEqual({ count: 1 });
    expect(acquireCliCapacityLease(db, {
      accountScope: 'codex:test',
      connectionId: 'mc_12345678',
      invocationId: 'inv_after_cleanup_failure',
      ownerId: 'owner-after-cleanup',
      ownerPid: process.pid,
      nowMs: Date.now() + 10_000,
      leaseMs: 5_000,
    })).toMatchObject({
      invocationId: 'inv_after_cleanup_failure',
      ownerId: 'owner-after-cleanup',
    });
    prepareSpy.mockRestore();
  });
});
