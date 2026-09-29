import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { configState, runCliLLMMock } = vi.hoisted(() => ({
  configState: {
    current: {
      general: { data_dir: '/tmp/tidemind-runtime-integration', user_name: 'test' },
      anthropic: { api_key: 'legacy-key-that-must-not-be-used' },
      vertex: { project_id: '', region: 'us-central1' },
      ollama: { url: 'http://localhost:11434' },
      gemini: { api_key: '' },
      llm: {
        provider: 'anthropic',
        light_model: 'legacy-light',
        standard_model: 'claude-sonnet-4-6',
        heavy_model: 'legacy-heavy',
        prompt_cache_enabled: true,
        standard_connection: undefined as string | undefined,
        standard_provider: undefined as string | undefined,
      },
      embedding: { provider: 'vertex', model: 'gemini-embedding-001', dimensions: 3072 },
      search: {},
      gates: {},
      metabolism: {},
      digest: { interactive_mode: 'silent' },
      cloud: { enabled: false, sync_enabled: false, metabolism_enabled: false, server_url: '' },
      update: { channel: 'stable' },
    },
  },
  runCliLLMMock: vi.fn(),
}));

vi.mock('../../src/config.js', () => ({
  getConfig: () => configState.current,
  getDataDir: () => configState.current.general.data_dir,
}));

vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, _param: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

vi.mock('../../src/llm/cli/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/llm/cli/index.js')>();
  return {
    ...actual,
    runCliLLM: runCliLLMMock,
  };
});

import Database from 'better-sqlite3';
import { ensureSchema } from '../../src/db/schema.js';
import { createConnection } from '../../src/db/connections.js';
import {
  assertRouteCallable,
  LLMRouteError,
  resolveLLMRoute,
} from '../../src/llm/route.js';
import {
  assertConnectionHealthCallable,
  getConnectionHealth,
  recordConnectionFailure,
  recordConnectionSuccess,
} from '../../src/llm/connection-health.js';
import {
  acquireCliCapacityLease,
  assertCliCapacityFence,
  releaseCliCapacityLease,
  renewCliCapacityLease,
} from '../../src/llm/cli/capacity-lease.js';
import {
  reconcileCliRuntimeState,
  resolveAmbiguousConnection,
  startCliInvocation,
} from '../../src/llm/cli/invocation-state.js';
import { markPendingDigestAmbiguous } from '../../src/db/pending-digests.js';
import {
  getAuthBinding,
  reconcileAuthBinding,
  recordModelObservation,
} from '../../src/db/model-discovery.js';
import type { CliAuthIdentity } from '../../src/llm/cli/types.js';
import { CliLLMError } from '../../src/llm/cli/errors.js';
import {
  callLLM,
  recordConnectionSuccessBestEffort,
  setUsageDb,
} from '../../src/llm/client.js';
import {
  clearMetabolismWorkerRuntimeContext,
  installMetabolismWorkerRuntimeContext,
} from '../../src/metabolism/worker-runtime-context.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  ensureSchema(db);
  return db;
}

function cliAuth(
  providerType: 'claude-cli' | 'codex-cli',
  scopeState: 'known' | 'unknown',
  scope = 'xinghai-org',
): CliAuthIdentity {
  const scopeKey = scopeState === 'known' ? `${providerType}:${scope}` : `${providerType}:unknown`;
  return {
    providerType,
    method: providerType === 'claude-cli' ? 'claude.ai' : 'chatgpt',
    accountIdentifier: null,
    accountScope: scopeState === 'known' ? scopeKey : `${providerType}:local-login`,
    scopeState,
    scopeKey,
    scopeLabel: null,
  };
}

/**
 * A CLI connection after a successful environment check under the new semantics:
 * status online + an auth binding. No legacy candidate/available columns are written;
 * admission must not depend on them.
 */
function configureCliConnection(
  db: Database.Database,
  providerType: 'claude-cli' | 'codex-cli' = 'claude-cli',
  options: { scopeState?: 'known' | 'unknown' | null } = {},
): string {
  const connection = createConnection(db, {
    name: `Local ${providerType}`,
    provider_type: providerType,
  });
  db.prepare(`
    UPDATE model_connections
    SET status = 'online',
        candidate_models = NULL,
        available_models = NULL,
        validation_fingerprint = 'generation-fixture'
    WHERE id = ?
  `).run(connection.id);
  const scopeState = options.scopeState === undefined ? 'known' : options.scopeState;
  if (scopeState) {
    reconcileAuthBinding(db, {
      connectionId: connection.id,
      auth: cliAuth(providerType, scopeState),
      cliGeneration: 'generation-fixture',
      authStoreSignal: null,
    });
  }
  return connection.id;
}

beforeEach(() => {
  runCliLLMMock.mockReset();
  configState.current.llm.standard_connection = undefined;
  configState.current.llm.standard_provider = undefined;
  configState.current.llm.standard_model = 'claude-sonnet-4-6';
});
afterEach(() => clearMetabolismWorkerRuntimeContext());

describe('显式 connection + model 路由', () => {
  it('连接缺失时失败，不回退到已配置的 legacy Anthropic', () => {
    const db = freshDb();
    configState.current.llm.standard_connection = 'mc_missing';
    configState.current.llm.standard_provider = 'claude-cli';

    expect(() => resolveLLMRoute('standard', db)).toThrowError(
      expect.objectContaining<Partial<LLMRouteError>>({
        kind: 'connection_missing',
        connectionId: 'mc_missing',
      }),
    );
    db.close();
  });

  it('严格使用连接 provider 和已选模型（不再要求 available_models），归档或 provider 不一致均不可回退', () => {
    const db = freshDb();
    const connectionId = configureCliConnection(db, 'claude-cli');
    configState.current.llm.standard_connection = connectionId;
    configState.current.llm.standard_provider = 'claude-cli';

    const route = resolveLLMRoute('standard', db);
    expect(route).toMatchObject({
      connectionId,
      providerType: 'claude-cli',
      modelAlias: 'claude-sonnet-4-6',
      sourceType: 'local_subscription',
      admission: { allowed: true, selectionMode: 'pinned_id', firstCall: true },
    });
    expect(() => assertRouteCallable(route)).not.toThrow();

    configState.current.llm.standard_provider = 'anthropic';
    expect(() => resolveLLMRoute('standard', db)).toThrowError(
      expect.objectContaining({ kind: 'provider_mismatch', connectionId }),
    );

    configState.current.llm.standard_provider = 'claude-cli';
    db.prepare('UPDATE model_connections SET archived = 1 WHERE id = ?').run(connectionId);
    expect(() => resolveLLMRoute('standard', db)).toThrowError(
      expect.objectContaining({ kind: 'connection_archived', connectionId }),
    );
    db.close();
  });

  it('Worker generation在连接物理删除后仍使用完整冻结route投影完成drain', () => {
    const db = freshDb();
    const connectionId = configureCliConnection(db, 'claude-cli');
    configState.current.llm.standard_connection = connectionId;
    configState.current.llm.standard_provider = 'claude-cli';
    installMetabolismWorkerRuntimeContext({
      runtimeRevision: 1,
      config: configState.current,
      connectionSnapshot: { connections: [{
        id: connectionId, name: 'Local claude-cli', providerType: 'claude-cli', archived: false,
        status: 'online', statusReason: null, candidateModels: JSON.stringify(['claude-sonnet-4-6']),
        availableModels: JSON.stringify(['claude-sonnet-4-6']), validationFingerprint: 'validated-fixture',
        authFingerprint: null, modelValidationJson: null, credentials: {},
      }] },
      strategySnapshot: {}, credentials: {}, dataDir: configState.current.general.data_dir,
    });
    db.prepare('DELETE FROM model_connections WHERE id = ?').run(connectionId);
    expect(resolveLLMRoute('standard', db)).toMatchObject({ connectionId, providerType: 'claude-cli', status: 'online' });
    db.close();
  });
});

describe('connection-scoped circuit', () => {
  it('A 连接打开 circuit 不影响 B 连接', () => {
    const db = freshDb();
    const baseEvent = {
      connectionId: 'mc_a',
      providerType: 'claude-cli' as const,
      modelAlias: 'claude-sonnet-4-6',
      outcome: 'definite_failure' as const,
      error: { kind: 'transient' as const, message: 'temporary failure' },
    };
    for (let i = 0; i < 3; i++) {
      recordConnectionFailure(db, { ...baseEvent, scopeId: 'mc_a' });
    }

    expect(getConnectionHealth(db, 'mc_a')).toMatchObject({
      circuitState: 'open',
      failureCount: 3,
    });
    expect(() => assertConnectionHealthCallable(db, 'mc_a')).toThrowError(
      expect.objectContaining({ name: 'LLMConnectionCircuitOpenError' }),
    );
    expect(getConnectionHealth(db, 'mc_b')).toBeNull();
    expect(() => assertConnectionHealthCallable(db, 'mc_b')).not.toThrow();

    recordConnectionSuccess(db, {
      scopeId: 'mc_b',
      connectionId: 'mc_b',
      providerType: 'codex-cli',
      modelAlias: 'gpt-5',
      outcome: 'success',
    });
    expect(getConnectionHealth(db, 'mc_a')?.circuitState).toBe('open');
    expect(getConnectionHealth(db, 'mc_b')).toMatchObject({
      circuitState: 'closed',
      failureCount: 0,
    });
    db.close();
  });

  it('half-open 状态只允许一个原子探测 owner，完成后释放', () => {
    const db = freshDb();
    const baseEvent = {
      scopeId: 'mc_probe',
      connectionId: 'mc_probe',
      providerType: 'codex-cli' as const,
      modelAlias: 'default',
      outcome: 'definite_failure' as const,
      error: { kind: 'transient' as const, message: 'temporary failure' },
    };
    for (let i = 0; i < 3; i++) recordConnectionFailure(db, baseEvent);
    db.prepare(`
      UPDATE llm_connection_health
      SET retry_at = ?, opened_at = ?
      WHERE scope_id = 'mc_probe'
    `).run(Date.now() - 1, Date.now() - 10 * 60_000);

    const probeStartedAt = Date.now();
    const firstProbe = assertConnectionHealthCallable(
      db,
      'mc_probe',
      probeStartedAt,
      20 * 60_000,
    );
    expect(firstProbe).toMatch(/^[a-f0-9-]{36}$/);
    expect(() => assertConnectionHealthCallable(db, 'mc_probe')).toThrowError(
      expect.objectContaining({ name: 'LLMConnectionCircuitOpenError' }),
    );
    expect(() => assertConnectionHealthCallable(
      db,
      'mc_probe',
      probeStartedAt + 61_000,
      20 * 60_000,
    )).toThrowError(
      expect.objectContaining({ name: 'LLMConnectionCircuitOpenError' }),
    );
    recordConnectionFailure(db, { ...baseEvent, probeToken: firstProbe });
    expect(db.prepare('SELECT COUNT(*) AS count FROM llm_connection_probe_leases').get())
      .toEqual({ count: 0 });
    db.prepare(`
      UPDATE llm_connection_health SET retry_at = ?
      WHERE scope_id = 'mc_probe'
    `).run(Date.now() - 1);
    const secondProbe = assertConnectionHealthCallable(db, 'mc_probe');
    expect(secondProbe).not.toBe(firstProbe);
    recordConnectionSuccess(db, {
      scopeId: 'mc_probe',
      connectionId: 'mc_probe',
      providerType: 'codex-cli',
      modelAlias: 'default',
      outcome: 'success',
      probeToken: firstProbe,
    });
    expect(getConnectionHealth(db, 'mc_probe')?.circuitState).toBe('half-open');
    recordConnectionSuccess(db, {
      scopeId: 'mc_probe',
      connectionId: 'mc_probe',
      providerType: 'codex-cli',
      modelAlias: 'default',
      outcome: 'success',
      probeToken: secondProbe,
    });
    expect(getConnectionHealth(db, 'mc_probe')?.circuitState).toBe('closed');
    db.close();
  });
});

describe('CLI capacity lease 与 fencing', () => {
  it('活跃租约拒绝并发，过期后恢复且旧 owner 不能续租、删除或通过 fence', () => {
    const db = freshDb();
    const first = acquireCliCapacityLease(db, {
      accountScope: 'codex:account-a',
      connectionId: 'mc_a',
      invocationId: 'inv_a',
      ownerId: 'daemon-a',
      ownerPid: 101,
      nowMs: 1_000,
      leaseMs: 5_000,
    });
    expect(first.fencingToken).toBe(1);
    expect(() => acquireCliCapacityLease(db, {
      accountScope: 'codex:account-a',
      connectionId: 'mc_b',
      invocationId: 'inv_b',
      ownerId: 'daemon-b',
      ownerPid: 202,
      nowMs: 2_000,
      leaseMs: 5_000,
    })).toThrowError(expect.objectContaining({ kind: 'capacity' }));

    const second = acquireCliCapacityLease(db, {
      accountScope: 'codex:account-a',
      connectionId: 'mc_b',
      invocationId: 'inv_b',
      ownerId: 'daemon-b',
      ownerPid: 202,
      nowMs: 6_001,
      leaseMs: 5_000,
    });
    expect(second.fencingToken).toBe(2);
    expect(() => assertCliCapacityFence(db, first, 6_002)).toThrowError(
      expect.objectContaining({ kind: 'capacity' }),
    );
    expect(() => renewCliCapacityLease(db, first, 5_000, 6_002)).toThrowError(
      expect.objectContaining({ kind: 'capacity' }),
    );
    expect(releaseCliCapacityLease(db, first)).toBe(false);
    expect(() => assertCliCapacityFence(db, second, 6_002)).not.toThrow();
    expect(releaseCliCapacityLease(db, second)).toBe(true);
    db.close();
  });
});

describe('invocation 冷启动恢复与 ambiguous digest', () => {
  it('未提交 prompt 的 running 变 definite，已提交的变 ambiguous 并暂停连接', () => {
    const db = freshDb();
    const connectionId = configureCliConnection(db);
    startCliInvocation(db, {
      id: 'inv_definite',
      connectionId,
      providerType: 'claude-cli',
      accountScope: 'claude:account-a',
      modelAlias: 'claude-sonnet-4-6',
    });
    startCliInvocation(db, {
      id: 'inv_ambiguous',
      connectionId,
      providerType: 'claude-cli',
      accountScope: 'claude:account-b',
      modelAlias: 'claude-sonnet-4-6',
    });
    db.prepare(
      "UPDATE cli_invocations SET prompt_committed = 1, started_at = '1970-01-01T00:00:00.000Z' WHERE id = ?",
    ).run('inv_ambiguous');
    db.prepare(
      "UPDATE cli_invocations SET started_at = '1970-01-01T00:00:00.000Z' WHERE id = ?",
    ).run('inv_definite');

    const result = reconcileCliRuntimeState(db, 120_000);
    expect(result).toMatchObject({
      definiteFailures: ['inv_definite'],
      ambiguousInvocations: ['inv_ambiguous'],
    });
    expect(db.prepare(
      'SELECT outcome, error_kind FROM cli_invocations WHERE id = ?',
    ).get('inv_definite')).toEqual({
      outcome: 'definite_failure',
      error_kind: 'process_crash',
    });
    expect(db.prepare(
      'SELECT outcome, error_kind FROM cli_invocations WHERE id = ?',
    ).get('inv_ambiguous')).toEqual({
      outcome: 'ambiguous',
      error_kind: 'ambiguous_outcome',
    });
    expect(db.prepare(
      'SELECT status FROM model_connections WHERE id = ?',
    ).get(connectionId)).toEqual({ status: 'ambiguous' });
    db.close();
  });

  it('ambiguous pending digest 不进入普通重试，用户重新验证后才延迟回队', () => {
    const db = freshDb();
    const connectionId = configureCliConnection(db);
    startCliInvocation(db, {
      id: 'inv_digest_ambiguous',
      connectionId,
      providerType: 'claude-cli',
      accountScope: 'claude:account-c',
      modelAlias: 'claude-sonnet-4-6',
    });
    db.prepare(`
      UPDATE cli_invocations
      SET prompt_committed = 1, outcome = 'ambiguous', error_kind = 'ambiguous_outcome'
      WHERE id = 'inv_digest_ambiguous'
    `).run();
    db.prepare(`
      INSERT INTO pending_digests (
        id, trace_id, input_json, status, error_message, retry_count,
        created, next_retry_at, processing_started_at
      ) VALUES (
        'pd_ambiguous', 'trace_ambiguous', '{}', 'processing', 'in-flight', 0,
        '2026-07-29T00:00:00.000Z', '2026-07-29T00:01:00.000Z',
        '2026-07-29T00:00:00.000Z'
      )
    `).run();

    markPendingDigestAmbiguous(
      db,
      'pd_ambiguous',
      'inv_digest_ambiguous',
      '结果未知',
    );
    expect(db.prepare(`
      SELECT status, ambiguous_invocation_id, processing_started_at
      FROM pending_digests WHERE id = 'pd_ambiguous'
    `).get()).toEqual({
      status: 'ambiguous',
      ambiguous_invocation_id: 'inv_digest_ambiguous',
      processing_started_at: null,
    });

    expect(resolveAmbiguousConnection(db, connectionId, {
      nowMs: 20_000,
      digestDelayMs: 60_000,
    })).toBe(1);
    expect(db.prepare(`
      SELECT status, ambiguous_invocation_id, processing_started_at, next_retry_at
      FROM pending_digests WHERE id = 'pd_ambiguous'
    `).get()).toEqual({
      status: 'pending',
      ambiguous_invocation_id: null,
      processing_started_at: null,
      next_retry_at: new Date(80_000).toISOString(),
    });
    expect(db.prepare(
      "SELECT resolution FROM cli_invocations WHERE id = 'inv_digest_ambiguous'",
    ).get()).toEqual({ resolution: 'user_revalidated' });
    db.close();
  });
});

describe('统一模型准入（route，design §5.4）', () => {
  function route(db: Database.Database) {
    return resolveLLMRoute('standard', db);
  }
  function observe(
    db: Database.Database,
    connectionId: string,
    modelId: string,
    outcome: Parameters<typeof recordModelObservation>[1]['outcome'],
    extra: { backoffUntil?: string | null } = {},
  ) {
    const binding = getAuthBinding(db, connectionId)!;
    recordModelObservation(db, {
      connectionId,
      scopeKey: binding.scopeKey,
      authEpoch: binding.authEpoch,
      modelId,
      selectionMode: 'pinned_id',
      outcome,
      source: 'business',
      backoffUntil: extra.backoffUntil ?? null,
    });
  }

  it('新发现或手动输入、已被选入路由的模型允许首次后台调用（firstCall）', async () => {
    const db = freshDb();
    const connectionId = configureCliConnection(db, 'codex-cli');
    configState.current.llm.standard_connection = connectionId;
    configState.current.llm.standard_provider = 'codex-cli';
    configState.current.llm.standard_model = 'gpt-9.9-datapilot-preview';
    expect(route(db).admission).toEqual({ allowed: true, selectionMode: 'pinned_id', firstCall: true });

    setUsageDb(db);
    runCliLLMMock.mockResolvedValue({
      text: 'first-call-ok',
      selectedModelAlias: 'gpt-9.9-datapilot-preview',
      actualModel: 'gpt-9.9-datapilot-preview',
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      reasoningTokens: 0,
      providerUsage: null,
    });
    await expect(callLLM({ prompt: 'x', model: 'standard', operationName: 'first-call' }))
      .resolves.toBe('first-call-ok');
    expect(runCliLLMMock).toHaveBeenCalledTimes(1);
    expect(runCliLLMMock.mock.calls[0][2]).toMatchObject({ modelAlias: 'gpt-9.9-datapilot-preview' });

    // A historical success in the same scope/epoch: allowed, no longer a first call.
    observe(db, connectionId, 'gpt-9.9-datapilot-preview', 'success');
    expect(route(db).admission).toEqual({ allowed: true, selectionMode: 'pinned_id', firstCall: false });
    db.close();
  });

  it('scope unknown 阻断后台调用且不调用模型', async () => {
    const db = freshDb();
    const connectionId = configureCliConnection(db, 'claude-cli', { scopeState: 'unknown' });
    configState.current.llm.standard_connection = connectionId;
    configState.current.llm.standard_provider = 'claude-cli';
    const resolved = route(db);
    expect(resolved.admission).toMatchObject({ allowed: false, reason: 'scope_unknown' });
    expect(() => assertRouteCallable(resolved)).toThrowError(
      expect.objectContaining({ kind: 'scope_unknown', connectionId }),
    );
    setUsageDb(db);
    await expect(callLLM({ prompt: 'x', model: 'standard' }))
      .rejects.toMatchObject({ kind: 'scope_unknown' });
    expect(runCliLLMMock).not.toHaveBeenCalled();
    db.close();
  });

  it('模型级故障只阻断该模型：mismatch / model_rejected / backoff；同连接其他模型不受影响', () => {
    const db = freshDb();
    const connectionId = configureCliConnection(db, 'claude-cli');
    configState.current.llm.standard_connection = connectionId;
    configState.current.llm.standard_provider = 'claude-cli';
    configState.current.llm.standard_model = 'claude-sonnet-4-6';

    observe(db, connectionId, 'claude-sonnet-4-6', 'mismatch');
    expect(() => assertRouteCallable(route(db))).toThrowError(
      expect.objectContaining({ kind: 'model_mismatch' }),
    );
    observe(db, connectionId, 'claude-sonnet-4-6', 'model_rejected');
    expect(() => assertRouteCallable(route(db))).toThrowError(
      expect.objectContaining({ kind: 'model_unavailable' }),
    );
    const retryAt = new Date(Date.now() + 60_000).toISOString();
    observe(db, connectionId, 'claude-sonnet-4-6', 'temporary_failure', { backoffUntil: retryAt });
    const backedOff = route(db);
    expect(backedOff.admission).toMatchObject({ allowed: false, reason: 'backoff', retryAt });
    expect(() => assertRouteCallable(backedOff)).toThrowError(
      expect.objectContaining({ kind: 'model_backoff' }),
    );
    observe(db, connectionId, 'claude-sonnet-4-6', 'temporary_failure', {
      backoffUntil: new Date(Date.now() - 1_000).toISOString(),
    });
    expect(() => assertRouteCallable(route(db))).not.toThrow();

    observe(db, connectionId, 'claude-sonnet-4-6', 'model_rejected');
    configState.current.llm.standard_model = 'claude-opus-4-1';
    expect(() => assertRouteCallable(route(db))).not.toThrow();
    expect(db.prepare('SELECT status FROM model_connections WHERE id = ?').get(connectionId))
      .toEqual({ status: 'online' });
    db.close();
  });

  it('epoch 变化后旧 epoch 的模型故障只作历史，不再阻断', () => {
    const db = freshDb();
    const connectionId = configureCliConnection(db, 'claude-cli');
    configState.current.llm.standard_connection = connectionId;
    configState.current.llm.standard_provider = 'claude-cli';
    observe(db, connectionId, 'claude-sonnet-4-6', 'model_rejected');
    expect(route(db).admission).toMatchObject({ allowed: false, reason: 'model_rejected' });
    reconcileAuthBinding(db, {
      connectionId,
      auth: cliAuth('claude-cli', 'known', 'datapilot-org'),
      cliGeneration: 'generation-fixture',
      authStoreSignal: null,
    });
    expect(route(db).admission).toEqual({ allowed: true, selectionMode: 'pinned_id', firstCall: true });
    db.close();
  });

  it('环境状态阻断：checking/testing → busy，ambiguous，环境失败 → unavailable', () => {
    const db = freshDb();
    const connectionId = configureCliConnection(db, 'claude-cli');
    configState.current.llm.standard_connection = connectionId;
    configState.current.llm.standard_provider = 'claude-cli';
    const expectations: Array<[string, string]> = [
      ['checking', 'connection_busy'],
      ['testing', 'connection_busy'],
      ['ambiguous', 'ambiguous_outcome'],
      ['not_authenticated', 'connection_unavailable'],
      ['unsupported_version', 'connection_unavailable'],
      ['offline', 'connection_unavailable'],
      ['unconfigured', 'connection_unavailable'],
    ];
    for (const [status, kind] of expectations) {
      db.prepare('UPDATE model_connections SET status = ? WHERE id = ?').run(status, connectionId);
      expect(() => assertRouteCallable(route(db)), status).toThrowError(expect.objectContaining({ kind }));
    }
    for (const status of ['untested', 'online', 'degraded']) {
      db.prepare('UPDATE model_connections SET status = ? WHERE id = ?').run(status, connectionId);
      expect(() => assertRouteCallable(route(db)), status).not.toThrow();
    }
    db.close();
  });

  it('尚无认证绑定（升级后未复检）的 CLI 连接：route 不预判 scope，交给 service 建立绑定后在租约内再准入', async () => {
    const db = freshDb();
    const connectionId = configureCliConnection(db, 'claude-cli', { scopeState: null });
    configState.current.llm.standard_connection = connectionId;
    configState.current.llm.standard_provider = 'claude-cli';
    expect(getAuthBinding(db, connectionId)).toBeNull();
    setUsageDb(db);
    runCliLLMMock.mockResolvedValue({
      text: 'ok',
      selectedModelAlias: 'default',
      actualModel: null,
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      providerUsage: null,
    });
    await expect(callLLM({ prompt: 'x', model: 'standard', operationName: 'post-upgrade' }))
      .resolves.toBe('ok');
    expect(runCliLLMMock).toHaveBeenCalledTimes(1);
    db.close();
  });
});

describe('后台 CLI 调用重试边界', () => {
  it('retryable CLI transient failure 也只调用一次模型', async () => {
    const db = freshDb();
    const connectionId = configureCliConnection(db);
    configState.current.llm.standard_connection = connectionId;
    configState.current.llm.standard_provider = 'claude-cli';
    setUsageDb(db);
    runCliLLMMock.mockRejectedValue(new CliLLMError(
      'transient',
      'temporary process failure',
      { retryable: true },
    ));

    await expect(callLLM({
      prompt: 'single attempt',
      model: 'standard',
      operationName: 'runtime-integration',
    })).rejects.toMatchObject({ kind: 'transient' });
    expect(runCliLLMMock).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('CLI 已成功后健康状态落库失败仍返回模型文本且不重放', async () => {
    const db = freshDb();
    const connectionId = configureCliConnection(db);
    configState.current.llm.standard_connection = connectionId;
    configState.current.llm.standard_provider = 'claude-cli';
    setUsageDb(db);
    runCliLLMMock.mockResolvedValue({
      text: 'provider-success',
      selectedModelAlias: 'claude-sonnet-4-6',
      actualModel: 'claude-sonnet-4-6',
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 2,
      reasoningTokens: 0,
      providerUsage: null,
    });
    const originalPrepare = db.prepare.bind(db);
    const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('UPDATE llm_connection_health')) {
        throw new Error('simulated health bookkeeping failure');
      }
      return originalPrepare(sql);
    });

    await expect(callLLM({
      prompt: 'completed once',
      model: 'standard',
      operationName: 'runtime-health-failure',
    })).resolves.toBe('provider-success');
    expect(runCliLLMMock).toHaveBeenCalledTimes(1);
    prepareSpy.mockRestore();
    db.close();
  });
});

describe('provider 成功后的本地记账边界', () => {
  it('非 CLI provider 已成功后，健康状态数据库故障不会改写主调用结果语义', () => {
    const db = freshDb();
    db.close();
    expect(() => recordConnectionSuccessBestEffort(db, {
      scopeId: 'mc_http',
      connectionId: 'mc_http',
      providerType: 'ollama',
      modelAlias: 'qwen-local',
      actualModel: 'qwen-local',
      outcome: 'success',
      probeToken: null,
    }, 'OpenAI-compatible')).not.toThrow();
  });
});
