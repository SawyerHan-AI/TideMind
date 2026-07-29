import { chmodSync, copyFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb } from '../../../src/db/connection.js';
import { createConnection } from '../../../src/db/connections.js';
import { captureCliIdentity } from '../../../src/llm/cli/resolve-cli.js';
import { runCliLLM, shutdownCliRuntime } from '../../../src/llm/cli/service.js';
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
      method: 'oauth:firstParty',
      accountIdentifier: 'fixture@example.com',
      accountScope: 'claude:fixture',
    },
    authFingerprint: 'auth-fixture',
    validationFingerprint: 'validation-fixture',
    capabilityFingerprint: 'capability-fixture',
    capabilityStatus: 'verified',
    candidateModels: ['default'],
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
        candidate_models = '["default"]',
        available_models = '["default"]',
        validation_fingerprint = ?
    WHERE id = ?
  `).run(environment.validationFingerprint, connection.id);
  return { db, dataDir, environment, connectionId: connection.id };
}

describe('CLI service post-provider durability boundary', () => {
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
        afterProviderCompleted: () => {
          throw new Error('simulated finalize failure');
        },
      },
    })).rejects.toMatchObject({ kind: 'ambiguous_outcome' });
    expect(state.db.prepare(`
      SELECT outcome, error_kind FROM cli_invocations ORDER BY started_at DESC LIMIT 1
    `).get()).toEqual({
      outcome: 'ambiguous',
      error_kind: 'ambiguous_outcome',
    });
    expect(state.db.prepare('SELECT status FROM model_connections WHERE id = ?')
      .get(state.connectionId)).toEqual({ status: 'ambiguous' });
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
});
