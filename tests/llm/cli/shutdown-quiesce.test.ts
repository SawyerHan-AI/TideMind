import { chmodSync, copyFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { CliEnvironmentCheck } from '../../../src/llm/cli/readiness.js';

const fixture = resolve(
  fileURLToPath(new URL('../../fixtures/llm-cli/fake-cli.mjs', import.meta.url)),
);

/**
 * The CLI registry and the LLM shutdown latch are process-wide singletons that
 * never return to "accepting". Every scenario therefore loads a fresh module graph.
 */
async function setup() {
  vi.resetModules();
  const { createTestDb } = await import('../../../src/db/connection.js');
  const { createConnection } = await import('../../../src/db/connections.js');
  const { reconcileAuthBinding } = await import('../../../src/db/model-discovery.js');
  const { captureCliIdentity } = await import('../../../src/llm/cli/resolve-cli.js');
  const service = await import('../../../src/llm/cli/service.js');
  const client = await import('../../../src/llm/client.js');
  const { cliProcessRegistry } = await import('../../../src/llm/cli/runtime-process-registry.js');

  const dataDir = mkdtempSync(join(tmpdir(), 'tidemind-quiesce-'));
  const executable = join(dataDir, 'claude');
  copyFileSync(fixture, executable);
  chmodSync(executable, 0o700);
  const path = realpathSync(executable);
  const environment: CliEnvironmentCheck = {
    providerType: 'claude-cli',
    status: 'untested',
    resolved: {
      kind: 'claude', path, version: '2.1.215',
      controlledPath: `${dirname(process.execPath)}:${dataDir}:/usr/bin:/bin`,
      source: 'known_path', identity: await captureCliIdentity(path),
    },
    auth: {
      providerType: 'claude-cli', method: 'claude.ai', accountIdentifier: 'fixture@example.com',
      accountScope: 'claude-cli:fixture-scope', scopeState: 'known',
      scopeKey: 'claude-cli:fixture-scope', scopeLabel: 'max',
    },
    authStoreSignal: null, authFingerprint: 'auth-fixture', cliGeneration: 'generation-fixture',
    validationFingerprint: 'generation-fixture', capabilityFingerprint: 'capability-fixture',
    capabilityStatus: 'verified', checkedAt: new Date().toISOString(),
  };
  const db: Database.Database = createTestDb();
  const connection = createConnection(db, { name: 'Claude fixture', provider_type: 'claude-cli' });
  db.prepare("UPDATE model_connections SET status = 'online', validation_fingerprint = ? WHERE id = ?")
    .run(environment.cliGeneration, connection.id);
  reconcileAuthBinding(db, {
    connectionId: connection.id, auth: environment.auth,
    cliGeneration: environment.cliGeneration, authStoreSignal: environment.authStoreSignal,
  });

  const run = (prompt: string, extra: {
    purpose?: 'background' | 'connection_test';
    recheckEnvironment?: () => Promise<CliEnvironmentCheck>;
    beforeOutcomePersistence?: () => void;
  } = {}) => service.runCliLLM(db, dataDir, {
    connectionId: connection.id, providerType: 'claude-cli', modelAlias: 'default',
    system: 'system', prompt, timeoutMs: 60_000, purpose: extra.purpose ?? 'background',
  }, {
    purpose: extra.purpose ?? 'background', environment,
    _testHooks: {
      recheckEnvironment: extra.recheckEnvironment ?? (async () => environment),
      beforeOutcomePersistence: extra.beforeOutcomePersistence,
    },
  }).then(result => ({ ok: true as const, result }), error => ({ ok: false as const, error }));

  const committed = () => vi.waitFor(() => expect(
    db.prepare('SELECT prompt_committed FROM cli_invocations').get(),
  ).toEqual({ prompt_committed: 1 }), { timeout: 10_000 });
  const invocation = () => db.prepare('SELECT prompt_committed, outcome, error_kind FROM cli_invocations').get();
  const status = () => (db.prepare('SELECT status FROM model_connections WHERE id = ?')
    .get(connection.id) as { status: string }).status;
  const cleanup = async () => {
    try { await service.shutdownCliRuntime(); } catch { /* best effort */ }
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  return { db, environment, service, client, registry: cliProcessRegistry, run, committed, invocation, status, cleanup };
}

describe('two-phase LLM runtime shutdown', () => {
  it('lets an already committed CLI invocation finish instead of pausing the connection', async () => {
    const state = await setup();
    try {
      const pending = state.run('SLEEP_MS=1500');
      await state.committed();
      await state.client.shutdownLLMClient({ graceMs: 30_000 });
      const outcome = await pending;
      expect(outcome.ok).toBe(true);
      expect(state.invocation()).toMatchObject({ prompt_committed: 1, outcome: 'success' });
      expect(state.status()).toBe('online');
      expect(state.registry.unsettledCount).toBe(0);
    } finally { await state.cleanup(); }
  }, 60_000);

  it('without a grace period keeps the existing fail-closed result', async () => {
    const state = await setup();
    try {
      const pending = state.run('SLEEP');
      await state.committed();
      await state.client.shutdownLLMClient();
      const outcome = await pending;
      expect(outcome.ok).toBe(false);
      expect((outcome as { error: { kind: string } }).error.kind).toBe('ambiguous_outcome');
      expect(state.status()).toBe('ambiguous');
      expect(state.registry.unsettledCount).toBe(0);
    } finally { await state.cleanup(); }
  }, 60_000);

  it('aborts whatever is still unsettled when the grace period runs out', async () => {
    const state = await setup();
    try {
      const pending = state.run('SLEEP');
      await state.committed();
      const started = Date.now();
      await state.client.shutdownLLMClient({ graceMs: 400 });
      expect(Date.now() - started).toBeGreaterThanOrEqual(350);
      const outcome = await pending;
      expect((outcome as { error: { kind: string } }).error.kind).toBe('ambiguous_outcome');
      expect(state.invocation()).toMatchObject({ outcome: 'ambiguous' });
      expect(state.status()).toBe('ambiguous');
      expect(state.registry.unsettledCount).toBe(0);
    } finally { await state.cleanup(); }
  }, 60_000);

  it('a repeated shutdown request shortens the wait and never extends it', async () => {
    const state = await setup();
    try {
      const pending = state.run('SLEEP');
      await state.committed();
      const started = Date.now();
      const first = state.client.shutdownLLMClient({ graceMs: 60_000 });
      await new Promise(resolve => setTimeout(resolve, 200));
      void state.client.shutdownLLMClient({ graceMs: 120_000 });
      const second = state.client.shutdownLLMClient({ graceMs: 0 });
      await Promise.all([first, second]);
      expect(Date.now() - started).toBeLessThan(15_000);
      expect((await pending as { error: { kind: string } }).error.kind).toBe('ambiguous_outcome');
    } finally { await state.cleanup(); }
  }, 60_000);

  it('refuses to commit a new prompt once quiescing: definite non-submission, connection not paused', async () => {
    const state = await setup();
    try {
      let quiesce: Promise<void> | null = null;
      const outcome = await state.run('never submitted', {
        // Runs inside beforePromptCommit, i.e. after spawn and before the commit gate.
        recheckEnvironment: async () => {
          quiesce ??= state.service.quiesceCliRuntime(5_000);
          return state.environment;
        },
      });
      await quiesce;
      expect(outcome.ok).toBe(false);
      expect((outcome as { error: { kind: string } }).error.kind).toBe('aborted');
      expect(state.invocation()).toMatchObject({ prompt_committed: 0, outcome: 'aborted' });
      expect(state.status()).toBe('online');
      expect(state.registry.unsettledCount).toBe(0);
    } finally { await state.cleanup(); }
  }, 60_000);

  it('a connection test started while quiescing fails as aborted without pausing the connection', async () => {
    const state = await setup();
    try {
      await state.service.quiesceCliRuntime(0);
      const outcome = await state.run('test', { purpose: 'connection_test' });
      expect((outcome as { error: { kind: string } }).error.kind).toBe('aborted');
      expect(state.status()).toBe('online');
    } finally { await state.cleanup(); }
  }, 60_000);

  it('releases the settlement count on definite failure and when outcome persistence throws', async () => {
    const state = await setup();
    try {
      const failed = await state.run('EXIT1');
      expect(failed.ok).toBe(false);
      expect(state.registry.unsettledCount).toBe(0);
      const persistenceFailed = await state.run('EXIT1', {
        beforeOutcomePersistence: () => { throw new Error('disk full'); },
      });
      expect(persistenceFailed.ok).toBe(false);
      expect(state.registry.unsettledCount).toBe(0);
    } finally { await state.cleanup(); }
  }, 60_000);
});

describe('CLI registry quiesce phase', () => {
  it('admits registry children only from a settling invocation and keeps the stopping message', async () => {
    const { CliProcessRegistry } = await import('../../../src/llm/cli/child-process-runner.js');
    const { runAsSettlingInvocation } = await import('../../../src/llm/cli/settlement-context.js');
    const registry = new CliProcessRegistry();
    const release = registry.beginSettlement();
    const quiesce = registry.quiesce(10_000);
    expect(() => registry.beginAdmission()).toThrow(/quiescing/);
    expect(() => registry.assertCommitAllowed()).toThrow(/quiescing/);
    await runAsSettlingInvocation(async () => {
      await Promise.resolve();
      registry.assertAccepting();
      registry.beginAdmission()();
      // Settling an old prompt never authorizes committing a new one.
      expect(() => registry.assertCommitAllowed()).toThrow(/quiescing/);
    });
    release();
    await quiesce;
    await registry.shutdown();
    await runAsSettlingInvocation(async () => {
      expect(() => registry.beginAdmission()).toThrow(/stopping/);
    });
  }, 30_000);

  it('waits for settlement even when no child process is registered', async () => {
    const { CliProcessRegistry } = await import('../../../src/llm/cli/child-process-runner.js');
    const registry = new CliProcessRegistry();
    const release = registry.beginSettlement();
    let done = false;
    const quiesce = registry.quiesce(10_000).then(() => { done = true; });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(registry.activeCount).toBe(0);
    expect(done).toBe(false);
    release();
    release();
    await quiesce;
    expect(registry.unsettledCount).toBe(0);
  }, 30_000);

  it('returns immediately when nothing is committed', async () => {
    const { CliProcessRegistry } = await import('../../../src/llm/cli/child-process-runner.js');
    const registry = new CliProcessRegistry();
    const started = Date.now();
    await registry.quiesce(60_000);
    expect(Date.now() - started).toBeLessThan(1_000);
  }, 30_000);
});
