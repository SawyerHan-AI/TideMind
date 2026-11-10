import { chmodSync, copyFileSync, mkdtempSync, realpathSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import { createTestDb } from '../../../src/db/connection.js';
import { createConnection } from '../../../src/db/connections.js';
import { listModelObservations, reconcileAuthBinding } from '../../../src/db/model-discovery.js';
import { captureCliIdentity } from '../../../src/llm/cli/resolve-cli.js';
import { runCliLLM, shutdownCliRuntime } from '../../../src/llm/cli/service.js';
import { CliProcessExitUnconfirmedError } from '../../../src/llm/cli/errors.js';
import { cliProcessRegistry } from '../../../src/llm/cli/runtime-process-registry.js';
import * as readiness from '../../../src/llm/cli/readiness.js';
import type { CliEnvironmentCheck } from '../../../src/llm/cli/readiness.js';

const fixture = resolve(
  fileURLToPath(new URL('../../fixtures/llm-cli/fake-cli.mjs', import.meta.url)),
);

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'tidemind-service-outcome-'));
  const executable = join(dataDir, 'claude');
  copyFileSync(fixture, executable);
  chmodSync(executable, 0o700);
  const path = realpathSync(executable);
  const environment: CliEnvironmentCheck = {
    providerType: 'claude-cli',
    status: 'untested',
    resolved: {
      kind: 'claude',
      path,
      version: '2.1.215',
      controlledPath: `${dirname(process.execPath)}:${dataDir}:/usr/bin:/bin`,
      source: 'known_path',
      identity: await captureCliIdentity(path),
    },
    auth: {
      providerType: 'claude-cli',
      method: 'claude.ai',
      accountIdentifier: 'fixture@example.com',
      accountScope: 'claude-cli:fixture-scope',
      scopeState: 'known',
      scopeKey: 'claude-cli:fixture-scope',
      scopeLabel: 'max',
    },
    authStoreSignal: null,
    authFingerprint: 'auth-fixture',
    cliGeneration: 'generation-fixture',
    validationFingerprint: 'generation-fixture',
    capabilityFingerprint: 'capability-fixture',
    capabilityStatus: 'verified',
    checkedAt: new Date().toISOString(),
  };
  const db = createTestDb();
  const connection = createConnection(db, {
    name: 'Claude fixture',
    provider_type: 'claude-cli',
  });
  db.prepare(`
    UPDATE model_connections
    SET status = 'online',
        validation_fingerprint = ?
    WHERE id = ?
  `).run(environment.cliGeneration, connection.id);
  // Same binding the environment check would establish (known scope, epoch 1).
  reconcileAuthBinding(db, {
    connectionId: connection.id,
    auth: environment.auth,
    cliGeneration: environment.cliGeneration,
    authStoreSignal: environment.authStoreSignal,
  });
  return { db, dataDir, environment, connectionId: connection.id };
}

describe('CLI service post-provider durability boundary', () => {
  it.each([false, true])('keeps the saved candidate through fresh checks (UI environment: %s)', async (supplied) => {
    const state = await setup();
    state.db.prepare('UPDATE model_connections SET cli_path = ? WHERE id = ?')
      .run(state.environment.resolved.path, state.connectionId);
    const check = vi.spyOn(readiness, 'checkCliEnvironment').mockResolvedValue(state.environment);
    try {
      await runCliLLM(state.db, state.dataDir, {
        connectionId: state.connectionId, providerType: 'claude-cli', modelAlias: 'default',
        system: 'system', prompt: 'success', timeoutMs: 10_000, purpose: 'connection_test',
      }, { ...(supplied ? { environment: state.environment } : {}) });
      expect(check.mock.calls.length).toBeGreaterThanOrEqual(2);
      for (const [options] of check.mock.calls) {
        expect(options.candidatePath).toBe(state.environment.resolved.path);
        expect(options.allowLoginShell).toBe(false);
      }
    } finally { check.mockRestore(); state.db.close(); rmSync(state.dataDir, { recursive: true, force: true }); }
  }, 30_000);

  it('does not overwrite a newly selected path when an older environment check returns', async () => {
    const state = await setup();
    state.db.prepare('UPDATE model_connections SET cli_path = ? WHERE id = ?')
      .run(state.environment.resolved.path, state.connectionId);
    const check = vi.spyOn(readiness, 'checkCliEnvironment').mockImplementation(async () => {
      state.db.prepare('UPDATE model_connections SET cli_path = ?, validation_fingerprint = ? WHERE id = ?')
        .run('/new/selected/cli', 'new-generation', state.connectionId);
      return state.environment;
    });
    try {
      await expect(runCliLLM(state.db, state.dataDir, {
        connectionId: state.connectionId, providerType: 'claude-cli', modelAlias: 'default',
        system: 'system', prompt: 'success', timeoutMs: 10_000, purpose: 'connection_test',
      })).rejects.toMatchObject({ kind: 'aborted' });
      expect(state.db.prepare('SELECT cli_path, validation_fingerprint FROM model_connections WHERE id = ?').get(state.connectionId))
        .toEqual({ cli_path: '/new/selected/cli', validation_fingerprint: 'new-generation' });
      expect(state.db.prepare('SELECT COUNT(*) AS n FROM cli_invocations').get()).toEqual({ n: 0 });
    } finally { check.mockRestore(); state.db.close(); rmSync(state.dataDir, { recursive: true, force: true }); }
  }, 30_000);

  it('does not submit after another operation selects a different CLI path', async () => {
    const state = await setup();
    try {
      await expect(runCliLLM(state.db, state.dataDir, {
        connectionId: state.connectionId, providerType: 'claude-cli', modelAlias: 'default',
        system: 'system', prompt: 'success', timeoutMs: 10_000, purpose: 'connection_test',
      }, { environment: state.environment, _testHooks: {
        recheckEnvironment: async () => state.environment,
        beforePromptCommit: () => {
          state.db.prepare('UPDATE model_connections SET cli_path = ? WHERE id = ?')
            .run('/different/selected/cli', state.connectionId);
        },
      } })).rejects.toMatchObject({ kind: 'aborted' });
      expect(state.db.prepare('SELECT prompt_committed FROM cli_invocations').all())
        .toEqual([expect.objectContaining({ prompt_committed: 0 })]);
    } finally { state.db.close(); rmSync(state.dataDir, { recursive: true, force: true }); }
  }, 30_000);

  afterAll(async () => {
    await shutdownCliRuntime();
  });

  it('turns a finalize failure after provider success into durable ambiguous', async () => {
    const state = await setup();
    await expect(runCliLLM(state.db, state.dataDir, {
      connectionId: state.connectionId,
      providerType: 'claude-cli',
      modelAlias: 'default',
      system: 'system',
      prompt: 'success',
      timeoutMs: 10_000,
      purpose: 'background',
    }, {
      purpose: 'background',
      environment: state.environment,
      _testHooks: {
        recheckEnvironment: async () => state.environment,
        afterProviderCompleted: () => {
          throw new Error('simulated finalize failure');
        },
      },
    })).rejects.toMatchObject({ kind: 'ambiguous_outcome' });
    await new Promise(resolve => setTimeout(resolve, 30));
    const logged = readFileSync(join(state.dataDir, 'logs', new Date().toISOString().slice(0, 10) + '.log'), 'utf8');
    expect(logged).toContain('post_response_environment');
    expect(logged).toContain('simulated finalize failure');
    expect(logged).toContain('\"providerCompleted\":true');
    expect(logged).toContain('invocationId');
    expect(state.db.prepare(`
      SELECT outcome, error_kind FROM cli_invocations ORDER BY started_at DESC LIMIT 1
    `).get()).toEqual({
      outcome: 'ambiguous',
      error_kind: 'ambiguous_outcome',
    });
    expect(state.db.prepare('SELECT status FROM model_connections WHERE id = ?')
      .get(state.connectionId)).toEqual({ status: 'ambiguous' });
    // An ambiguous outcome is not a success observation for the model.
    expect(listModelObservations(state.db, state.connectionId).map(o => o.lastOutcome))
      .not.toContain('success');
    state.db.close();
    rmSync(state.dataDir, { recursive: true, force: true });
  }, 20_000);

  it('preserves the ambiguous error when its persistence transaction also fails', async () => {
    const state = await setup();
    await expect(runCliLLM(state.db, state.dataDir, {
      connectionId: state.connectionId,
      providerType: 'claude-cli',
      modelAlias: 'default',
      system: 'system',
      prompt: 'CORRUPT',
      timeoutMs: 10_000,
      purpose: 'background',
    }, {
      purpose: 'background',
      environment: state.environment,
      _testHooks: {
        recheckEnvironment: async () => state.environment,
        beforeOutcomePersistence: () => {
          throw new Error('simulated ambiguous persistence failure');
        },
      },
    })).rejects.toMatchObject({ kind: 'ambiguous_outcome' });
    expect(state.db.prepare(`
      SELECT outcome, prompt_committed FROM cli_invocations ORDER BY started_at DESC LIMIT 1
    `).get()).toEqual({ outcome: 'running', prompt_committed: 1 });
    state.db.close();
    rmSync(state.dataDir, { recursive: true, force: true });
  }, 20_000);

  it('keeps unconfirmed child exit durable across the worker capacity lease release', async () => {
    const state = await setup();
    const unregister = cliProcessRegistry.unregister.bind(cliProcessRegistry);
    const cleanup = vi.spyOn(cliProcessRegistry, 'unregister').mockImplementationOnce(async (...args) => {
      await unregister(...args);
      throw new CliProcessExitUnconfirmedError();
    });
    try {
      await expect(runCliLLM(state.db, state.dataDir, {
        connectionId: state.connectionId,
        providerType: 'claude-cli',
        modelAlias: 'default',
        system: 'system',
        prompt: 'success',
        timeoutMs: 10_000,
        purpose: 'background',
      }, {
        purpose: 'background',
        environment: state.environment,
        _testHooks: { recheckEnvironment: async () => state.environment },
      })).rejects.toMatchObject({ kind: 'ambiguous_outcome' });
      expect(state.db.prepare('SELECT outcome, error_kind FROM cli_invocations').get())
        .toEqual({ outcome: 'ambiguous', error_kind: 'process_exit_unconfirmed' });
      expect(state.db.prepare('SELECT * FROM cli_capacity_leases').all()).toEqual([]);
    } finally {
      cleanup.mockRestore();
      state.db.close();
      rmSync(state.dataDir, { recursive: true, force: true });
    }
  }, 20_000);

  it('does not admit new work when an older available status disagrees with the unresolved ledger', async () => {
    const state = await setup();
    try {
      state.db.prepare(`INSERT INTO cli_invocations
        (id, connection_id, provider_type, account_scope, model_alias, prompt_committed, outcome, started_at)
        VALUES ('unresolved', ?, 'claude-cli', 'claude-cli:fixture-scope', 'default', 1, 'ambiguous', '2026-09-25')`)
        .run(state.connectionId);
      await expect(runCliLLM(state.db, state.dataDir, {
        connectionId: state.connectionId,
        providerType: 'claude-cli',
        modelAlias: 'default',
        system: 'system',
        prompt: 'success',
        timeoutMs: 10_000,
        purpose: 'background',
      }, {
        environment: state.environment,
      })).rejects.toMatchObject({ kind: 'ambiguous_outcome', options: { admissionReason: 'ambiguous_outcome' } });
      expect(state.db.prepare('SELECT id, outcome, resolution FROM cli_invocations').all())
        .toEqual([{ id: 'unresolved', outcome: 'ambiguous', resolution: null }]);
    } finally {
      state.db.close();
      rmSync(state.dataDir, { recursive: true, force: true });
    }
  });
});
