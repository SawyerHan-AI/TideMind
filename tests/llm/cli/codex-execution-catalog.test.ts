import { chmodSync, copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../../../src/db/connection.js';
import { createConnection } from '../../../src/db/connections.js';
import { getAuthBinding, getModelObservation } from '../../../src/db/model-discovery.js';
import { planCodexContract, verifyCodexContract } from '../../../src/llm/cli/gate-codex.js';
import { captureCliIdentity } from '../../../src/llm/cli/resolve-cli.js';
import { runCliLLM, shutdownCliRuntime } from '../../../src/llm/cli/service.js';
import { getConnectionHealth, recordConnectionFailure } from '../../../src/llm/connection-health.js';
import type { CliEnvironmentCheck } from '../../../src/llm/cli/readiness.js';
import type { CliInvocationPurpose } from '../../../src/llm/cli/types.js';
import { CliLLMError } from '../../../src/llm/cli/errors.js';

/**
 * 2026-11-27: the standard tier was pinned to a model that the account catalog
 * listed but the installed Codex CLI could not execute. It was reported as
 * `unsupported_version`, which opened the whole connection's circuit and also
 * blocked the other tiers sharing that connection.
 */

const fixture = resolve(fileURLToPath(new URL('../../fixtures/llm-cli/fake-cli.mjs', import.meta.url)));
const features = readFileSync(fileURLToPath(new URL(
  '../../fixtures/llm-cli/codex-0.153.4-features.txt', import.meta.url,
)), 'utf8');

const EXECUTABLE = 'gpt-fixture';
const LISTED_ONLY = 'gpt-newer-than-cli';

type State = { db: Database.Database; dataDir: string; environment: CliEnvironmentCheck; connectionId: string };
const states: State[] = [];

async function setup(cliGeneration = 'generation-fixture'): Promise<State> {
  const dataDir = mkdtempSync(join(tmpdir(), 'tidemind-codex-catalog-'));
  const executable = join(dataDir, 'codex');
  copyFileSync(fixture, executable);
  chmodSync(executable, 0o700);
  const path = realpathSync(executable);
  const evidence = {
    version: '0.153.4',
    execHelp: '--ignore-user-config --ignore-rules --ephemeral --json --skip-git-repo-check --strict-config',
    promptInputHelp: 'codex debug prompt-input',
    featuresList: features,
  };
  const { disableFeatures } = planCodexContract(evidence);
  const effective = features.split('\n').filter(Boolean).map((line) => line.replace(/true\s*$/, 'false')).join('\n');
  const environment = {
    providerType: 'codex-cli',
    status: 'untested',
    resolved: {
      kind: 'codex', path, version: '0.153.4',
      controlledPath: `${dirname(process.execPath)}:${dataDir}:/usr/bin:/bin`,
      source: 'known_path', identity: await captureCliIdentity(path),
    },
    auth: {
      providerType: 'codex-cli', method: 'chatgpt', accountIdentifier: null,
      accountScope: 'codex-cli:xinghai', scopeState: 'known', scopeKey: 'codex-cli:xinghai', scopeLabel: 'pro',
    },
    identityProbe: { status: 'observed' },
    authStoreSignal: null,
    authFingerprint: 'auth-fixture',
    cliGeneration,
    validationFingerprint: cliGeneration,
    capabilityFingerprint: 'capability-fixture',
    capabilityStatus: 'verified',
    codexContract: verifyCodexContract(evidence, disableFeatures, effective),
    codexToolCatalogJson: JSON.stringify({
      models: [{ slug: EXECUTABLE, priority: 0, apply_patch_tool_type: null, experimental_supported_tools: [] }],
    }),
    checkedAt: new Date().toISOString(),
  } as CliEnvironmentCheck;
  const db = createTestDb();
  const connection = createConnection(db, { name: '星海 Codex', provider_type: 'codex-cli' });
  db.prepare("UPDATE model_connections SET status = 'online' WHERE id = ?").run(connection.id);
  const state = { db, dataDir, environment, connectionId: connection.id };
  states.push(state);
  return state;
}

afterEach(() => {
  for (const state of states.splice(0)) {
    state.db.close();
    rmSync(state.dataDir, { recursive: true, force: true });
  }
});
afterAll(async () => { await shutdownCliRuntime(); });

function run(state: State, modelAlias: string, purpose: CliInvocationPurpose, prompt = 'hello') {
  return runCliLLM(state.db, state.dataDir, {
    connectionId: state.connectionId, providerType: 'codex-cli', modelAlias,
    system: 'system', prompt, timeoutMs: 15_000, purpose,
  }, { purpose, environment: state.environment, _testHooks: { recheckEnvironment: async () => state.environment } });
}

const invocations = (state: State): number =>
  (state.db.prepare('SELECT COUNT(*) AS n FROM cli_invocations').get() as { n: number }).n;
const status = (state: State): string =>
  (state.db.prepare('SELECT status FROM model_connections WHERE id = ?').get(state.connectionId) as { status: string }).status;
function observation(state: State, modelId: string) {
  const binding = getAuthBinding(state.db, state.connectionId)!;
  return getModelObservation(state.db, state.connectionId, binding.scopeKey, binding.authEpoch, modelId);
}

describe('a model the installed Codex CLI cannot execute', () => {
  it('is rejected per model; the connection and its other models keep working', async () => {
    const state = await setup();
    const error = await run(state, LISTED_ONLY, 'background').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CliLLMError);
    expect(error).toMatchObject({ kind: 'model_unavailable', message: expect.stringContaining(LISTED_ONLY) });
    expect(state.db.prepare('SELECT prompt_committed, outcome, error_kind FROM cli_invocations').all())
      .toEqual([{ prompt_committed: 0, outcome: 'definite_failure', error_kind: 'model_unavailable' }]);
    expect(observation(state, LISTED_ONLY)).toMatchObject({ lastOutcome: 'model_rejected' });
    expect(status(state)).toBe('online');

    // The health layer ignores a model-level failure: the circuit stays closed.
    const cliError = error as CliLLMError;
    recordConnectionFailure(state.db, {
      scopeId: state.connectionId, connectionId: state.connectionId, providerType: 'codex-cli',
      modelAlias: LISTED_ONLY, outcome: 'definite_failure',
      error: { kind: 'model_unavailable', message: cliError.message, needsUserAction: cliError.options.needsUserAction },
    });
    expect(getConnectionHealth(state.db, state.connectionId)?.circuitState ?? 'closed').toBe('closed');

    // From the second call on, admission refuses the model without creating an invocation.
    await expect(run(state, LISTED_ONLY, 'background'))
      .rejects.toMatchObject({ kind: 'model_unavailable', options: { admissionReason: 'model_rejected' } });
    expect(invocations(state)).toBe(1);

    // Another tier on the same connection is unaffected.
    await expect(run(state, EXECUTABLE, 'background')).resolves.toMatchObject({ actualModel: EXECUTABLE });
    expect(observation(state, EXECUTABLE)).toMatchObject({ lastOutcome: 'success' });
  }, 30_000);

  it('an explicit test reports the same model-level failure and leaves the connection status alone', async () => {
    const state = await setup();
    await expect(run(state, LISTED_ONLY, 'connection_test')).rejects.toMatchObject({ kind: 'model_unavailable' });
    expect(status(state)).toBe('online');
    expect(observation(state, LISTED_ONLY)).toMatchObject({ lastOutcome: 'model_rejected', lastSource: 'test' });
  }, 30_000);

  it('is tried again after the CLI is upgraded (new generation, new epoch)', async () => {
    const state = await setup();
    await expect(run(state, LISTED_ONLY, 'background')).rejects.toMatchObject({ kind: 'model_unavailable' });
    state.environment = {
      ...state.environment,
      cliGeneration: 'generation-upgraded',
      validationFingerprint: 'generation-upgraded',
      codexToolCatalogJson: JSON.stringify({ models: [EXECUTABLE, LISTED_ONLY].map((slug) => ({
        slug, priority: 0, apply_patch_tool_type: null, experimental_supported_tools: [],
      })) }),
    };
    state.db.prepare('UPDATE model_connections SET validation_fingerprint = NULL WHERE id = ?').run(state.connectionId);
    await expect(run(state, LISTED_ONLY, 'background', 'ACTUAL=ECHO')).resolves.toMatchObject({ actualModel: LISTED_ONLY });
    expect(getAuthBinding(state.db, state.connectionId)).toMatchObject({ epochReason: 'cli_generation_changed' });
    expect(observation(state, LISTED_ONLY)).toMatchObject({ lastOutcome: 'success' });
  }, 30_000);
});
