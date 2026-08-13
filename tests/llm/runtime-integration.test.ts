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

function configureCliConnection(
  db: Database.Database,
  providerType: 'claude-cli' | 'codex-cli' = 'claude-cli',
): string {
  const connection = createConnection(db, {
    name: `Local ${providerType}`,
    provider_type: providerType,
  });
  db.prepare(`
    UPDATE model_connections
    SET status = 'online',
        candidate_models = ?,
        available_models = ?,
        validation_fingerprint = 'validated-fixture'
    WHERE id = ?
  `).run(
    JSON.stringify(['claude-sonnet-4-6']),
    JSON.stringify(['claude-sonnet-4-6']),
    connection.id,
  );
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

  it('严格使用连接 provider 和已验证模型，归档或 provider 不一致均不可回退', () => {
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
