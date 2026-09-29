import { chmodSync, copyFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../../../src/db/connection.js';
import { createConnection } from '../../../src/db/connections.js';
import {
  getAuthBinding,
  getModelObservation,
  listModelObservations,
  reconcileAuthBinding,
  saveCatalogSnapshot,
} from '../../../src/db/model-discovery.js';
import { captureCliIdentity } from '../../../src/llm/cli/resolve-cli.js';
import { runCliLLM, shutdownCliRuntime } from '../../../src/llm/cli/service.js';
import { installMetabolismWorkerRuntimeContext, clearMetabolismWorkerRuntimeContext } from '../../../src/metabolism/worker-runtime-context.js';
import { BACKOFF_MS } from '../../../src/llm/model-admission.js';
import type { CliEnvironmentCheck } from '../../../src/llm/cli/readiness.js';
import type { CliAuthIdentity, CliInvocationPurpose } from '../../../src/llm/cli/types.js';

const fixture = resolve(
  fileURLToPath(new URL('../../fixtures/llm-cli/fake-cli.mjs', import.meta.url)),
);

function knownAuth(scope = 'xinghai-org'): CliAuthIdentity {
  return {
    providerType: 'claude-cli',
    method: 'claude.ai',
    accountIdentifier: null,
    accountScope: `claude-cli:${scope}`,
    scopeState: 'known',
    scopeKey: `claude-cli:${scope}`,
    scopeLabel: 'max',
  };
}

function unknownAuth(): CliAuthIdentity {
  return {
    providerType: 'claude-cli',
    method: 'oauth',
    accountIdentifier: null,
    accountScope: 'claude-cli:local-login',
    scopeState: 'unknown',
    scopeKey: 'claude-cli:unknown',
    scopeLabel: null,
  };
}

type State = {
  db: Database.Database;
  dataDir: string;
  environment: CliEnvironmentCheck;
  connectionId: string;
};

const states: State[] = [];

async function setup(auth: CliAuthIdentity = knownAuth()): Promise<State> {
  const dataDir = mkdtempSync(join(tmpdir(), 'tidemind-service-observation-'));
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
      version: '2.1.280',
      controlledPath: `${dirname(process.execPath)}:${dataDir}:/usr/bin:/bin`,
      source: 'known_path',
      identity: await captureCliIdentity(path),
    },
    auth,
    authStoreSignal: null,
    authFingerprint: 'auth-fixture',
    cliGeneration: 'generation-fixture',
    validationFingerprint: 'generation-fixture',
    capabilityFingerprint: 'capability-fixture',
    capabilityStatus: 'verified',
    checkedAt: new Date().toISOString(),
  };
  const db = createTestDb();
  const connection = createConnection(db, { name: '星海 Claude', provider_type: 'claude-cli' });
  db.prepare("UPDATE model_connections SET status = 'online' WHERE id = ?").run(connection.id);
  const state = { db, dataDir, environment, connectionId: connection.id };
  states.push(state);
  return state;
}

afterEach(() => {
  clearMetabolismWorkerRuntimeContext();
  for (const state of states.splice(0)) {
    state.db.close();
    rmSync(state.dataDir, { recursive: true, force: true });
  }
});

afterAll(async () => {
  await shutdownCliRuntime();
});

function run(
  state: State,
  modelAlias: string,
  prompt: string,
  purpose: CliInvocationPurpose,
  hooks?: { beforePromptCommit?: () => void; recheckEnvironment?: () => Promise<CliEnvironmentCheck> },
) {
  return runCliLLM(state.db, state.dataDir, {
    connectionId: state.connectionId,
    providerType: 'claude-cli',
    modelAlias,
    system: 'system',
    prompt,
    timeoutMs: 15_000,
    purpose,
  }, {
    purpose,
    environment: state.environment,
    _testHooks: { recheckEnvironment: async () => state.environment, ...hooks },
  });
}

function observation(state: State, modelId: string) {
  const binding = getAuthBinding(state.db, state.connectionId)!;
  return getModelObservation(state.db, state.connectionId, binding.scopeKey, binding.authEpoch, modelId);
}

function connectionStatus(state: State): string {
  return (state.db.prepare('SELECT status FROM model_connections WHERE id = ?')
    .get(state.connectionId) as { status: string }).status;
}

function invocationCount(state: State): number {
  return (state.db.prepare('SELECT COUNT(*) AS n FROM cli_invocations').get() as { n: number }).n;
}

const PINNED = 'claude-sonnet-4-6';

describe('runCliLLM model observations (design §5.3 / §5.4 / §7.1)', () => {
  it('pinned model with a different actual: records mismatch, background throws model_mismatch (not ambiguous), later background refused', async () => {
    const state = await setup();
    await expect(run(state, PINNED, 'ACTUAL=claude-opus-4-1 hello', 'background'))
      .rejects.toMatchObject({ kind: 'model_mismatch' });
    expect(observation(state, PINNED)).toMatchObject({
      lastOutcome: 'mismatch',
      errorKind: 'model_mismatch',
      actualModel: 'claude-opus-4-1',
      selectionMode: 'pinned_id',
      lastSource: 'business',
    });
    // The call happened and is accounted for; the connection is not paused as ambiguous.
    expect(state.db.prepare('SELECT outcome, actual_model FROM cli_invocations').all())
      .toEqual([{ outcome: 'success', actual_model: 'claude-opus-4-1' }]);
    expect(connectionStatus(state)).toBe('online');

    const before = invocationCount(state);
    await expect(run(state, PINNED, 'ACTUAL=ECHO again', 'background'))
      .rejects.toMatchObject({ kind: 'model_mismatch', options: { admissionReason: 'model_mismatch' } });
    // Refused by admission before any process/invocation.
    expect(invocationCount(state)).toBe(before);
  }, 30_000);

  it('a dated snapshot of the pinned id is equivalent (success)', async () => {
    const state = await setup();
    await expect(run(state, PINNED, `ACTUAL=${PINNED}-20260101 hi`, 'background')).resolves.toMatchObject({
      actualModel: `${PINNED}-20260101`,
    });
    expect(observation(state, PINNED)).toMatchObject({ lastOutcome: 'success', lastSource: 'business' });
  }, 30_000);

  it('an explicit test whose actual matches clears the mismatch; background is then admitted', async () => {
    const state = await setup();
    await expect(run(state, PINNED, 'ACTUAL=claude-opus-4-1 x', 'background')).rejects.toMatchObject({ kind: 'model_mismatch' });
    // The test is allowed despite the mismatch (it is the documented recovery path).
    await expect(run(state, PINNED, 'ACTUAL=ECHO test', 'connection_test')).resolves.toMatchObject({ actualModel: PINNED });
    expect(observation(state, PINNED)).toMatchObject({ lastOutcome: 'success', lastSource: 'test', actualModel: PINNED });
    await expect(run(state, PINNED, 'ACTUAL=ECHO work', 'background')).resolves.toMatchObject({ actualModel: PINNED });
  }, 30_000);

  it('an explicit test with an unknown actual (null) does not clear the mismatch', async () => {
    const state = await setup();
    await expect(run(state, PINNED, 'ACTUAL=claude-opus-4-1 x', 'background')).rejects.toMatchObject({ kind: 'model_mismatch' });
    await expect(run(state, PINNED, 'NOMODEL test', 'connection_test')).resolves.toMatchObject({ actualModel: null });
    expect(observation(state, PINNED)).toMatchObject({ lastOutcome: 'mismatch', actualModel: 'claude-opus-4-1' });
    await expect(run(state, PINNED, 'ACTUAL=ECHO work', 'background')).rejects.toMatchObject({ kind: 'model_mismatch' });
    // An explicit test that still returns a different actual stays a mismatch too, without throwing.
    await expect(run(state, PINNED, 'ACTUAL=claude-haiku-4-5 test', 'connection_test'))
      .resolves.toMatchObject({ actualModel: 'claude-haiku-4-5' });
    expect(observation(state, PINNED)).toMatchObject({ lastOutcome: 'mismatch', actualModel: 'claude-haiku-4-5' });
  }, 30_000);

  it('a pinned background call with an unknown actual is a protocol success but no mismatch', async () => {
    const state = await setup();
    await expect(run(state, PINNED, 'NOMODEL hi', 'background')).resolves.toMatchObject({ actualModel: null });
    expect(observation(state, PINNED)).toMatchObject({ lastOutcome: 'success', actualModel: null });
  }, 30_000);

  it('follow_default and alias selections resolving to another concrete model are successes', async () => {
    const state = await setup();
    await expect(run(state, 'default', 'ACTUAL=claude-sonnet-4-6 hi', 'background')).resolves.toBeTruthy();
    expect(observation(state, 'default')).toMatchObject({
      lastOutcome: 'success',
      selectionMode: 'follow_default',
      actualModel: 'claude-sonnet-4-6',
    });
    await expect(run(state, 'opus', 'ACTUAL=claude-opus-4-1-20260101 hi', 'background')).resolves.toBeTruthy();
    expect(observation(state, 'opus')).toMatchObject({
      lastOutcome: 'success',
      selectionMode: 'alias',
      actualModel: 'claude-opus-4-1-20260101',
    });
    // background success on an untested connection marks it online
    state.db.prepare("UPDATE model_connections SET status = 'untested' WHERE id = ?").run(state.connectionId);
    await expect(run(state, 'default', 'hi', 'background')).resolves.toBeTruthy();
    expect(connectionStatus(state)).toBe('online');
  }, 30_000);

  it('model_unavailable on one model (explicit test) is recorded per model: other models stay admitted, connection status unchanged', async () => {
    const state = await setup();
    await expect(run(state, 'claude-retired-1', 'MODEL_UNAVAILABLE', 'connection_test'))
      .rejects.toMatchObject({ kind: 'model_unavailable' });
    expect(observation(state, 'claude-retired-1')).toMatchObject({
      lastOutcome: 'model_rejected',
      errorKind: 'model_unavailable',
      lastSource: 'test',
      backoffUntil: null,
    });
    expect(connectionStatus(state)).toBe('online');

    // The rejected model is refused for background work before any process starts…
    const before = invocationCount(state);
    await expect(run(state, 'claude-retired-1', 'ACTUAL=ECHO', 'background'))
      .rejects.toMatchObject({ kind: 'model_unavailable', options: { admissionReason: 'model_rejected' } });
    expect(invocationCount(state)).toBe(before);
    // …while another model on the same connection keeps working.
    await expect(run(state, PINNED, 'ACTUAL=ECHO', 'background')).resolves.toMatchObject({ actualModel: PINNED });
    expect(connectionStatus(state)).toBe('online');
  }, 30_000);

  it('an unclassified exit 1 is recorded as unclassified_failure with a cooldown, never as model_rejected', async () => {
    const state = await setup();
    const started = Date.now();
    await expect(run(state, PINNED, 'EXIT1', 'connection_test')).rejects.toMatchObject({ kind: 'process_crash' });
    const recorded = observation(state, PINNED)!;
    expect(recorded).toMatchObject({ lastOutcome: 'unclassified_failure', errorKind: 'process_crash' });
    const until = Date.parse(recorded.backoffUntil!);
    expect(until).toBeGreaterThanOrEqual(started + BACKOFF_MS.unclassified - 1_000);
    expect(until).toBeLessThanOrEqual(Date.now() + BACKOFF_MS.unclassified + 1_000);
    expect(connectionStatus(state)).toBe('online');
    // Background waits for the cooldown instead of treating the model as retired.
    await expect(run(state, PINNED, 'ACTUAL=ECHO', 'background'))
      .rejects.toMatchObject({ kind: 'transient', options: { admissionReason: 'backoff', retryable: true } });
  }, 30_000);

  it('binding epoch change before prompt commit: prompt not submitted, definite failure (not ambiguous), no observation', async () => {
    const state = await setup();
    await expect(run(state, PINNED, 'ACTUAL=ECHO', 'background', {
      beforePromptCommit: () => {
        reconcileAuthBinding(state.db, {
          connectionId: state.connectionId,
          auth: knownAuth('datapilot-org'),
          cliGeneration: 'generation-fixture',
          authStoreSignal: null,
        });
      },
    })).rejects.toMatchObject({ kind: 'not_authenticated' });
    expect(state.db.prepare('SELECT outcome, prompt_committed FROM cli_invocations').all())
      .toEqual([{ outcome: 'definite_failure', prompt_committed: 0 }]);
    expect(connectionStatus(state)).toBe('online');
    expect(listModelObservations(state.db, state.connectionId)).toEqual([]);
    expect(getAuthBinding(state.db, state.connectionId)?.authEpoch).toBe(2);
  }, 30_000);

  it('admission is re-checked under the lease: a mismatch landing before commit blocks submission', async () => {
    const state = await setup();
    await expect(run(state, PINNED, 'ACTUAL=ECHO', 'background', {
      beforePromptCommit: () => {
        const binding = getAuthBinding(state.db, state.connectionId)!;
        state.db.prepare(`
          INSERT INTO llm_model_observations (
            connection_id, scope_key, auth_epoch, model_id, selection_mode, last_outcome,
            last_source, updated_at
          ) VALUES (?, ?, ?, ?, 'pinned_id', 'mismatch', 'test', ?)
        `).run(state.connectionId, binding.scopeKey, binding.authEpoch, PINNED, new Date().toISOString());
      },
    })).rejects.toMatchObject({ kind: 'model_mismatch' });
    expect(state.db.prepare('SELECT prompt_committed FROM cli_invocations').all())
      .toEqual([{ prompt_committed: 0 }]);
    expect(connectionStatus(state)).toBe('online');
  }, 30_000);

  it('scope unknown: background refused before any invocation; an explicit test is allowed', async () => {
    const state = await setup(unknownAuth());
    await expect(run(state, PINNED, 'ACTUAL=ECHO', 'background'))
      .rejects.toMatchObject({ kind: 'scope_unknown', options: { admissionReason: 'scope_unknown' } });
    expect(invocationCount(state)).toBe(0);
    await expect(run(state, PINNED, 'ACTUAL=ECHO', 'connection_test')).resolves.toMatchObject({ actualModel: PINNED });
    expect(observation(state, PINNED)).toMatchObject({ lastOutcome: 'success', lastSource: 'test' });
    // The successful test does not unlock unattended background work.
    await expect(run(state, PINNED, 'ACTUAL=ECHO', 'background')).rejects.toMatchObject({ kind: 'scope_unknown' });
  }, 30_000);

  it('re-reads official auth before submission even when the DB binding is unchanged', async () => {
    const state = await setup();
    await expect(run(state, PINNED, 'ACTUAL=ECHO', 'background', {
      recheckEnvironment: async () => ({ ...state.environment, auth: knownAuth('switched-account') }),
    })).rejects.toMatchObject({ kind: 'not_authenticated' });
    expect(state.db.prepare('SELECT prompt_committed FROM cli_invocations').all())
      .toEqual([{ prompt_committed: 0 }]);
    expect(listModelObservations(state.db, state.connectionId)).toEqual([]);
  }, 30_000);

  it('does not adopt or authorize a response after an external account switch', async () => {
    const state = await setup();
    let reads = 0;
    await expect(run(state, PINNED, 'ACTUAL=ECHO', 'background', {
      recheckEnvironment: async () => ++reads === 1 ? state.environment
        : { ...state.environment, auth: knownAuth('switched-account') },
    })).rejects.toMatchObject({ kind: 'ambiguous_outcome' });
    expect(connectionStatus(state)).toBe('ambiguous');
    expect(listModelObservations(state.db, state.connectionId)).toEqual([]);
  }, 30_000);

  it('never rewrites a model using another account catalog', async () => {
    const state = await setup();
    const { binding } = reconcileAuthBinding(state.db, {
      connectionId: state.connectionId, auth: knownAuth('old-account'),
      cliGeneration: state.environment.cliGeneration, authStoreSignal: null,
    });
    saveCatalogSnapshot(state.db, {
      connectionId: state.connectionId, scopeKey: binding.scopeKey, authEpoch: binding.authEpoch,
      cliGeneration: state.environment.cliGeneration, source: 'codex_app_server',
      items: [{ id: PINNED, invocationId: 'unexpected-model', displayName: PINNED, kind: 'model',
        isDefault: false, hidden: false, upgrade: null, retirementAt: null, reasoningEfforts: [] }],
    });
    await expect(run(state, PINNED, 'ACTUAL=ECHO', 'background'))
      .resolves.toMatchObject({ actualModel: PINNED });
  }, 30_000);

  it('stops a connection archived while waiting for the final auth check', async () => {
    const state = await setup();
    await expect(run(state, PINNED, 'ACTUAL=ECHO', 'background', {
      recheckEnvironment: async () => {
        state.db.prepare('UPDATE model_connections SET archived = 1 WHERE id = ?').run(state.connectionId);
        return state.environment;
      },
    })).rejects.toMatchObject({ kind: 'aborted' });
    expect(state.db.prepare('SELECT prompt_committed FROM cli_invocations').all())
      .toEqual([{ prompt_committed: 0 }]);
  }, 30_000);

  it('fences an old Worker revision before prompt submission, even before drain arrives', async () => {
    const state = await setup();
    installMetabolismWorkerRuntimeContext({
      runtimeRevision: 7, dataDir: state.dataDir,
      config: { general: { data_dir: state.dataDir }, metabolism: {}, llm: {}, embedding: {} },
      connectionSnapshot: { connections: [{ id: state.connectionId, name: 'fixture', providerType: 'claude-cli',
        archived: false, status: 'online', statusReason: null, candidateModels: null, availableModels: null,
        validationFingerprint: null, authFingerprint: null, modelValidationJson: null, credentials: {} }] },
      strategySnapshot: {}, credentials: {},
    });
    state.db.prepare("INSERT INTO metadata (key, value) VALUES ('metabolism_worker_runtime_revision', '7')").run();
    await expect(run(state, PINNED, 'ACTUAL=ECHO', 'background', {
      recheckEnvironment: async () => {
        // Main invalidates synchronously; Worker has not received its drain message.
        state.db.prepare("UPDATE metadata SET value = 'invalid' WHERE key = 'metabolism_worker_runtime_revision'").run();
        return state.environment;
      },
    })).rejects.toMatchObject({ kind: 'aborted' });
    expect(state.db.prepare('SELECT prompt_committed FROM cli_invocations').all())
      .toEqual([{ prompt_committed: 0 }]);
  }, 30_000);

  it('invalid model ids are refused for both purposes before spawning', async () => {
    const state = await setup();
    for (const purpose of ['background', 'connection_test'] as const) {
      await expect(run(state, '--dangerous', 'hi', purpose))
        .rejects.toMatchObject({ kind: 'model_unavailable', options: { admissionReason: 'invalid_model_id' } });
    }
    expect(invocationCount(state)).toBe(0);
  }, 30_000);

  it('a transient known→unknown→known scope flap (same account) must not clear a pinned mismatch', async () => {
    // 复现：readiness.probeCodexAuth 在 app-server account/read 传输失败（超时/崩溃）时回退到
    // `login status`，scope 变 unknown → reconcileAuthBinding 判 scope_changed，epoch+1；下次
    // 读取成功又回到同一 known scope → 再 +1。观察按 (scopeKey, epoch) 存，于是同一账号下的
    // mismatch / model_rejected / backoff 全部“退为历史”，后台准入重新放行——等于一次偶发
    // 元数据失败就清除了设计 §5.4 规定只能由显式单模型测试清除的 mismatch。
    const state = await setup();
    await expect(run(state, PINNED, 'ACTUAL=claude-opus-4-1 x', 'background')).rejects.toMatchObject({ kind: 'model_mismatch' });
    const known = state.environment;
    state.environment = { ...known, auth: unknownAuth() };
    await expect(run(state, PINNED, 'ACTUAL=ECHO', 'background')).rejects.toMatchObject({ kind: 'scope_unknown' });
    state.environment = known;
    await expect(run(state, PINNED, 'ACTUAL=ECHO', 'background')).rejects.toMatchObject({ kind: 'model_mismatch' });
  }, 30_000);

  it('background model-not-found after prompt commit should pause only that model, not the whole connection', async () => {
    // 复现：后台调用固定模型，CLI 以明确的 “model not found” exit 1 结束。ClaudeCliAdapter /
    // CodexCliAdapter 对 promptCommitted && background 的任何 CliLLMError 都改写为
    // ambiguous_outcome，service 随即把整个连接置为 status='ambiguous'（阻断全部路由、需手动
    // 测试恢复），而 observationForError 的 model_rejected / temporary_failure / unclassified
    // 分支在后台路径上不可达。与设计 §5.4“暂停该模型路由”、§7.1“不影响其他成功模型”冲突。
    const state = await setup();
    await expect(run(state, 'claude-retired-1', 'MODEL_UNAVAILABLE', 'background')).rejects.toBeTruthy();
    expect(observation(state, 'claude-retired-1')).toMatchObject({ lastOutcome: 'model_rejected' });
    expect(connectionStatus(state)).toBe('online');
  }, 30_000);
});
