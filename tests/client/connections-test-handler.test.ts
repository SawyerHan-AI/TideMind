/**
 * Audit-3 F11 回归覆盖:
 * connections:test 失败时不应清空 available_models —— 用户上次成功拿到的型号列表
 * 应保留,UI 模型下拉仍可用。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupTestDb } from '../helpers/test-db.js';
import type Database from 'better-sqlite3';

// 捕获 ipcMain.handle 的 handler
type Handler = (e: unknown, ...args: unknown[]) => unknown | Promise<unknown>;
const {
  handlers,
  probeAnthropicMock,
  checkCliEnvironmentMock,
  runCliLLMMock,
  refreshCatalogMock,
  healthSendMock,
  dbHolder,
  routeConfig,
  electronMock,
} = vi.hoisted(() => {
  const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown | Promise<unknown>>();
  return {
    handlers,
    probeAnthropicMock: vi.fn(),
    checkCliEnvironmentMock: vi.fn(),
    runCliLLMMock: vi.fn(),
    refreshCatalogMock: vi.fn(),
    healthSendMock: vi.fn(),
    dbHolder: { db: null as Database.Database | null },
    // Route config seen by the IPC handlers (in-use models per connection).
    routeConfig: { llm: {} as Record<string, string | undefined> },
    electronMock: {
      ipcMain: {
        handle: (channel: string, handler: (e: unknown, ...args: unknown[]) => unknown | Promise<unknown>) => {
          handlers.set(channel, handler);
        },
      },
      dialog: { showOpenDialog: vi.fn() },
      BrowserWindow: {
        getAllWindows: vi.fn(() => [{
          isDestroyed: () => false,
          webContents: { send: healthSendMock },
        }]),
      },
    },
  };
});

vi.mock('electron', () => electronMock);
vi.mock('../../client/node_modules/electron/index.js', () => electronMock);

vi.mock('../../client/electron/db.js', () => ({
  getClientDb: () => dbHolder.db,
}));

vi.mock('../../client/electron/ipc/health.js', () => ({
  probeAnthropic: probeAnthropicMock,
  probeVertex: vi.fn(),
  probeGemini: vi.fn(),
  probeOllama: vi.fn(),
  probeOpenAICompatible: vi.fn(),
}));

vi.mock('../../src/llm/cli/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/llm/cli/index.js')>();
  return {
    ...actual,
    checkCliEnvironment: checkCliEnvironmentMock,
    runCliLLM: runCliLLMMock,
  };
});

vi.mock('../../src/llm/cli/model-catalog.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/llm/cli/model-catalog.js')>();
  return { ...actual, refreshCliModelCatalog: refreshCatalogMock };
});

// Deterministic config: defaults (never the developer's real config.toml) plus the
// routes a test declares.
vi.mock('../../src/config.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/config.js')>();
  return {
    ...actual,
    getConfig: () => {
      const base = actual.loadConfig('/nonexistent/tidemind-connections-test/config.toml');
      return { ...base, llm: { ...base.llm, ...routeConfig.llm } };
    },
  };
});

import { registerConnectionHandlers } from '../../client/electron/ipc/connections.js';
import { CliLLMError } from '../../src/llm/cli/errors.js';
import {
  getAuthBinding,
  reconcileAuthBinding,
  recordModelObservation,
} from '../../src/db/model-discovery.js';

function seedConnection(db: Database.Database, opts: { available_models?: string | null } = {}): string {
  const id = 'mc_abcdef01';
  db.prepare(
    'INSERT INTO model_connections (id, name, provider_type, credentials, status, available_models, last_checked, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    id,
    'TestAnthropic',
    'anthropic',
    JSON.stringify({ api_key: 'sk-test' }),
    'online',
    opts.available_models ?? null,
    null,
    new Date().toISOString(),
  );
  return id;
}

function cliEnvironment(
  providerType: 'claude-cli' | 'codex-cli' = 'codex-cli',
  options: { scope?: string | null; generation?: string } = {},
) {
  const scope = options.scope === undefined ? 'xinghai-workspace' : options.scope;
  const scopeKey = scope ? `${providerType}:${scope}` : `${providerType}:unknown`;
  return {
    providerType,
    status: 'untested' as const,
    resolved: {
      kind: providerType === 'codex-cli' ? 'codex' : 'claude',
      path: providerType === 'codex-cli' ? '/opt/fixture/bin/codex' : '/opt/fixture/bin/claude',
      version: '0.156.1',
      controlledPath: '/usr/bin:/bin',
      source: 'known_path' as const,
      identity: { device: 1, inode: 1, size: 1, ctimeMs: 1, sha256: 'fixture' },
    },
    auth: {
      providerType,
      method: providerType === 'codex-cli' ? 'chatgpt' : 'claude.ai',
      accountIdentifier: null,
      accountScope: scope ? scopeKey : `${providerType}:local-login`,
      scopeState: scope ? 'known' as const : 'unknown' as const,
      scopeKey,
      scopeLabel: scope ? 'pro' : null,
    },
    authStoreSignal: null,
    authFingerprint: 'auth-fingerprint',
    cliGeneration: options.generation ?? 'generation-1',
    validationFingerprint: options.generation ?? 'generation-1',
    capabilityFingerprint: 'capability-fingerprint',
    capabilityStatus: 'verified' as const,
    checkedAt: new Date().toISOString(),
  };
}

function seedCliConnection(
  db: Database.Database,
  status = 'unconfigured',
  availableModels: string[] | null = null,
): string {
  const id = 'mc_c0decafe';
  db.prepare(`
    INSERT INTO model_connections (
      id, name, provider_type, credentials, status, status_reason,
      cli_path, cli_version, auth_method, auth_fingerprint, candidate_models,
      available_models, validation_fingerprint, model_validation_json,
      last_tested_at, last_test_summary, created
    ) VALUES (?, ?, 'codex-cli', '{}', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    'Local Codex',
    status,
    status === 'online' || status === 'ambiguous' ? 'previous reason' : null,
    '/opt/fixture/bin/codex',
    '0.156.1',
    'chatgpt',
    'auth-fingerprint',
    JSON.stringify(['default', 'fast']),
    availableModels ? JSON.stringify(availableModels) : null,
    availableModels ? 'validation-fingerprint' : null,
    availableModels ? JSON.stringify({ default: { success: true } }) : null,
    availableModels ? '2026-07-29T00:00:00.000Z' : null,
    availableModels ? JSON.stringify({ success: 1, total: 2 }) : null,
    new Date().toISOString(),
  );
  return id;
}

function bindEnvironment(db: Database.Database, id: string, environment = cliEnvironment()) {
  return reconcileAuthBinding(db, {
    connectionId: id,
    auth: environment.auth,
    cliGeneration: environment.cliGeneration,
    authStoreSignal: environment.authStoreSignal,
  }).binding;
}

function useRoutes(routes: Partial<Record<'light' | 'standard' | 'heavy', [string, string]>>) {
  routeConfig.llm = {};
  for (const [tier, value] of Object.entries(routes)) {
    if (!value) continue;
    routeConfig.llm[`${tier}_connection`] = value[0];
    routeConfig.llm[`${tier}_provider`] = 'codex-cli';
    routeConfig.llm[`${tier}_model`] = value[1];
  }
}

const OK = { text: 'TIDEMIND_CONNECTION_OK', actualModel: null, usage: null };

function connectionRow(db: Database.Database, id: string) {
  return db.prepare(`
    SELECT status, status_reason, available_models, validation_fingerprint, last_test_summary
    FROM model_connections WHERE id = ?
  `).get(id) as {
    status: string;
    status_reason: string | null;
    available_models: string | null;
    validation_fingerprint: string | null;
    last_test_summary: string | null;
  };
}

describe('F11 — connections:test failure preserves available_models', () => {
  beforeEach(() => {
    handlers.clear();
    dbHolder.db = setupTestDb();
    registerConnectionHandlers('/tmp/test-data');
    probeAnthropicMock.mockReset();
  });

  it('成功 → 失败 → available_models 仍保留上次成功的列表', async () => {
    const id = seedConnection(dbHolder.db, { available_models: JSON.stringify(['claude-3-5-sonnet', 'claude-3-5-haiku']) });
    const testHandler = handlers.get('connections:test')!;
    expect(testHandler).toBeDefined();

    // 第一次:成功,模型列表更新为新值
    probeAnthropicMock.mockResolvedValueOnce({
      online: true,
      models: ['claude-3-7-sonnet', 'claude-3-5-haiku', 'claude-3-opus'],
    });
    await testHandler(null, id);

    let row = dbHolder.db.prepare('SELECT * FROM model_connections WHERE id = ?').get(id) as { available_models: string };
    expect(JSON.parse(row.available_models)).toEqual(['claude-3-7-sonnet', 'claude-3-5-haiku', 'claude-3-opus']);

    // 第二次:失败,available_models 应保留
    probeAnthropicMock.mockResolvedValueOnce({
      online: false,
      models: [],
      error: 'network down',
    });
    await testHandler(null, id);

    row = dbHolder.db.prepare('SELECT * FROM model_connections WHERE id = ?').get(id) as { available_models: string; status: string };
    expect(row.status).toBe('offline');
    expect(JSON.parse(row.available_models)).toEqual(['claude-3-7-sonnet', 'claude-3-5-haiku', 'claude-3-opus']);
  });

  it('成功有 models → 状态 online + models 更新', async () => {
    const id = seedConnection(dbHolder.db, { available_models: null });
    const testHandler = handlers.get('connections:test')!;

    probeAnthropicMock.mockResolvedValueOnce({ online: true, models: ['m1'] });
    await testHandler(null, id);

    const row = dbHolder.db.prepare('SELECT * FROM model_connections WHERE id = ?').get(id) as { available_models: string; status: string };
    expect(row.status).toBe('online');
    expect(JSON.parse(row.available_models)).toEqual(['m1']);
  });
});

describe('本地订阅 CLI 连接 IPC', () => {
  beforeEach(() => {
    handlers.clear();
    dbHolder.db = setupTestDb();
    routeConfig.llm = {};
    checkCliEnvironmentMock.mockReset();
    runCliLLMMock.mockReset();
    refreshCatalogMock.mockReset();
    refreshCatalogMock.mockResolvedValue({ status: 'refreshed', snapshot: null });
    healthSendMock.mockReset();
    registerConnectionHandlers('/tmp/test-data');
  });

  describe('connections:test 显式目标（design §6 / §7.2）', () => {
    it('不再遍历候选：只有一个在用模型时只测它', async () => {
      const id = seedCliConnection(dbHolder.db, 'online', ['default', 'fast']);
      useRoutes({ light: [id, 'gpt-5.3-codex'], standard: [id, 'gpt-5.3-codex'], heavy: ['mc_otherconn', 'gpt-6'] });
      checkCliEnvironmentMock.mockResolvedValue(cliEnvironment());
      runCliLLMMock.mockResolvedValue(OK);

      const result = await handlers.get('connections:test')!(null, id) as Record<string, unknown>;

      expect(runCliLLMMock).toHaveBeenCalledTimes(1);
      expect(runCliLLMMock.mock.calls[0][2]).toMatchObject({
        connectionId: id,
        modelAlias: 'gpt-5.3-codex',
        purpose: 'connection_test',
      });
      expect(runCliLLMMock.mock.calls[0][3]).toMatchObject({ purpose: 'connection_test' });
      expect(result).toMatchObject({
        online: true,
        models: ['gpt-5.3-codex'],
        successCount: 1,
        totalCount: 1,
        cancelled: false,
        scopeState: 'known',
        attributionUnconfirmed: false,
      });
      const row = connectionRow(dbHolder.db, id);
      expect(row.status).toBe('online');
      // Legacy columns are no longer rewritten by a test.
      expect(JSON.parse(row.available_models!)).toEqual(['default', 'fast']);
      expect(JSON.parse(row.last_test_summary!)).toMatchObject({ success: 1, total: 1, targets: ['gpt-5.3-codex'] });
    });

    it('没有在用路由时测试 CLI 默认（default）', async () => {
      const id = seedCliConnection(dbHolder.db);
      useRoutes({ standard: ['mc_otherconn', 'gpt-6'] });
      checkCliEnvironmentMock.mockResolvedValue(cliEnvironment());
      runCliLLMMock.mockResolvedValue(OK);

      const result = await handlers.get('connections:test')!(null, id);

      expect(runCliLLMMock).toHaveBeenCalledTimes(1);
      expect(runCliLLMMock.mock.calls[0][2]).toMatchObject({ modelAlias: 'default' });
      expect(result).toMatchObject({ online: true, models: ['default'], totalCount: 1 });
    });

    it('多个在用模型且未指定目标：返回 test_target_required，不检查环境也不改状态', async () => {
      const id = seedCliConnection(dbHolder.db, 'online', ['default']);
      useRoutes({ light: [id, 'gpt-5-mini'], standard: [id, 'gpt-5.3-codex'], heavy: [id, 'gpt-5-mini'] });

      const result = await handlers.get('connections:test')!(null, id);

      expect(result).toMatchObject({
        online: false,
        models: [],
        errorKind: 'test_target_required',
        inUseModels: ['gpt-5-mini', 'gpt-5.3-codex'],
      });
      expect(checkCliEnvironmentMock).not.toHaveBeenCalled();
      expect(runCliLLMMock).not.toHaveBeenCalled();
      expect(connectionRow(dbHolder.db, id)).toMatchObject({ status: 'online', status_reason: 'previous reason' });
    });

    it('显式目标：按顺序去重逐个测试，可测试未在用的新模型', async () => {
      const id = seedCliConnection(dbHolder.db, 'untested');
      useRoutes({ light: [id, 'gpt-5-mini'], standard: [id, 'gpt-5.3-codex'] });
      checkCliEnvironmentMock.mockResolvedValue(cliEnvironment());
      runCliLLMMock.mockResolvedValue(OK);

      const result = await handlers.get('connections:test')!(null, id, undefined, {
        models: ['gpt-6-datapilot-preview', 'gpt-5-mini', 'gpt-6-datapilot-preview'],
      });

      expect(runCliLLMMock.mock.calls.map(call => call[2].modelAlias))
        .toEqual(['gpt-6-datapilot-preview', 'gpt-5-mini']);
      expect(result).toMatchObject({ successCount: 2, totalCount: 2, models: ['gpt-6-datapilot-preview', 'gpt-5-mini'] });
      const progress = healthSendMock.mock.calls
        .filter(([channel]) => channel === 'connections:test-progress')
        .map(([, payload]) => payload);
      expect(progress.at(-1)).toMatchObject({ connectionId: id, completed: 2, total: 2 });
    });

    it.each([
      ['超过 10 个', { models: Array.from({ length: 11 }, (_, i) => `gpt-${i}`) }],
      ['空数组', { models: [] }],
      ['非数组', { models: 'gpt-5' }],
      ['非字符串', { models: [42] }],
      ['argv 形态 ID', { models: ['--dangerous'] }],
      ['含空格 ID', { models: ['gpt 5'] }],
      ['超长 ID', { models: ['x'.repeat(129)] }],
    ])('非法显式目标（%s）直接报错，不启动测试', async (_label, options) => {
      const id = seedCliConnection(dbHolder.db, 'online', ['default']);
      await expect(handlers.get('connections:test')!(null, id, undefined, options)).rejects.toThrow(/测试目标无效/);
      expect(checkCliEnvironmentMock).not.toHaveBeenCalled();
      expect(runCliLLMMock).not.toHaveBeenCalled();
      expect(connectionRow(dbHolder.db, id).status).toBe('online');
      // Not left in a busy state: a valid request can start right after.
      checkCliEnvironmentMock.mockResolvedValue(cliEnvironment());
      runCliLLMMock.mockResolvedValue(OK);
      await expect(handlers.get('connections:test')!(null, id, undefined, { models: ['gpt-5'] }))
        .resolves.toMatchObject({ online: true });
    });

    it('恰好 10 个目标是允许的上限；options 缺 models 时按在用路由解析', async () => {
      const id = seedCliConnection(dbHolder.db, 'online');
      checkCliEnvironmentMock.mockResolvedValue(cliEnvironment());
      runCliLLMMock.mockResolvedValue(OK);
      await expect(handlers.get('connections:test')!(null, id, undefined, {
        models: Array.from({ length: 10 }, (_, i) => `gpt-${i}`),
      })).resolves.toMatchObject({ totalCount: 10, successCount: 10 });
      runCliLLMMock.mockClear();
      await handlers.get('connections:test')!(null, id, undefined, {});
      expect(runCliLLMMock.mock.calls.map(call => call[2].modelAlias)).toEqual(['default']);
    });
  });

  describe('connections:test 状态语义', () => {
    it('状态不再按比例降级：部分模型失败仍为 online，失败只留在该模型的结果里', async () => {
      const id = seedCliConnection(dbHolder.db, 'untested');
      checkCliEnvironmentMock.mockResolvedValue(cliEnvironment());
      runCliLLMMock.mockImplementation(async (_db: unknown, _dir: string, request: { modelAlias: string }) => {
        if (request.modelAlias === 'gpt-retired') {
          throw new CliLLMError('model_unavailable', 'model not found');
        }
        return OK;
      });

      const result = await handlers.get('connections:test')!(null, id, undefined, {
        models: ['gpt-5.3-codex', 'gpt-retired'],
      }) as { results: unknown[] };

      expect(result).toMatchObject({ online: true, models: ['gpt-5.3-codex'], successCount: 1, totalCount: 2 });
      expect(result.results).toEqual([
        expect.objectContaining({ model: 'gpt-5.3-codex', success: true }),
        expect.objectContaining({ model: 'gpt-retired', success: false, errorKind: 'model_unavailable' }),
      ]);
      expect(connectionRow(dbHolder.db, id)).toMatchObject({ status: 'online', status_reason: null });
    });

    it('全部模型级失败不把已在线连接降级；未验证连接保持 untested', async () => {
      const online = seedCliConnection(dbHolder.db, 'online', ['default']);
      checkCliEnvironmentMock.mockResolvedValue(cliEnvironment());
      runCliLLMMock.mockRejectedValue(new CliLLMError('model_unavailable', 'model not found'));
      await expect(handlers.get('connections:test')!(null, online, undefined, { models: ['gpt-retired'] }))
        .resolves.toMatchObject({ online: false, successCount: 0 });
      expect(connectionRow(dbHolder.db, online).status).toBe('online');

      dbHolder.db.prepare("UPDATE model_connections SET status = 'untested' WHERE id = ?").run(online);
      await handlers.get('connections:test')!(null, online, undefined, { models: ['gpt-retired'] });
      expect(connectionRow(dbHolder.db, online).status).toBe('untested');
    });

    it('连接级错误（未登录）映射为连接状态', async () => {
      const id = seedCliConnection(dbHolder.db, 'online');
      checkCliEnvironmentMock.mockResolvedValue(cliEnvironment());
      runCliLLMMock.mockRejectedValue(new CliLLMError('not_authenticated', 'codex CLI is not logged in'));
      await handlers.get('connections:test')!(null, id, undefined, { models: ['gpt-5'] });
      expect(connectionRow(dbHolder.db, id)).toMatchObject({
        status: 'not_authenticated',
        status_reason: 'codex CLI is not logged in',
      });
    });

    it('固定模型返回 mismatch 观察时不计为成功', async () => {
      const id = seedCliConnection(dbHolder.db, 'untested');
      const environment = cliEnvironment();
      const binding = bindEnvironment(dbHolder.db, id, environment);
      checkCliEnvironmentMock.mockResolvedValue(environment);
      runCliLLMMock.mockImplementation(async () => {
        // What the real service records when the pinned id resolves to another model.
        recordModelObservation(dbHolder.db!, {
          connectionId: id,
          scopeKey: binding.scopeKey,
          authEpoch: binding.authEpoch,
          modelId: 'gpt-5.3-codex',
          selectionMode: 'pinned_id',
          outcome: 'mismatch',
          source: 'test',
          actualModel: 'gpt-5.2',
        });
        return { ...OK, actualModel: 'gpt-5.2' };
      });
      const result = await handlers.get('connections:test')!(null, id, undefined, { models: ['gpt-5.3-codex'] });
      expect(result).toMatchObject({
        online: false,
        successCount: 0,
        results: [expect.objectContaining({ model: 'gpt-5.3-codex', success: false, mismatch: true, actualModel: 'gpt-5.2' })],
      });
      expect(connectionRow(dbHolder.db, id).status).toBe('untested');
    });

    it('测试期间账号 scope 变化：结果归属未确认，不计成功', async () => {
      const id = seedCliConnection(dbHolder.db, 'untested');
      bindEnvironment(dbHolder.db, id);
      checkCliEnvironmentMock
        .mockResolvedValueOnce(cliEnvironment())
        .mockResolvedValueOnce(cliEnvironment('codex-cli', { scope: 'datapilot-workspace' }));
      runCliLLMMock.mockResolvedValue(OK);
      const result = await handlers.get('connections:test')!(null, id, undefined, { models: ['gpt-5'] });
      expect(result).toMatchObject({ online: false, models: [], successCount: 0, attributionUnconfirmed: true });
      expect(connectionRow(dbHolder.db, id)).toMatchObject({
        status: 'untested',
        status_reason: expect.stringContaining('归属未确认'),
      });
      expect(getAuthBinding(dbHolder.db, id)?.authEpoch).toBe(2);
    });

    it('ambiguous 连接显式测试成功后解除 ambiguous 并恢复 online', async () => {
      const id = seedCliConnection(dbHolder.db, 'ambiguous');
      checkCliEnvironmentMock.mockResolvedValue(cliEnvironment());
      runCliLLMMock.mockResolvedValue(OK);
      await handlers.get('connections:test')!(null, id, undefined, { models: ['gpt-5'] });
      expect(connectionRow(dbHolder.db, id)).toMatchObject({ status: 'online', status_reason: null });
    });

    it('单模型测试成功不能解决此前未决请求或重排可能已计费的 digest', async () => {
      const db = dbHolder.db!;
      const id = seedCliConnection(db, 'ambiguous');
      db.prepare(`INSERT INTO cli_invocations
        (id, connection_id, provider_type, account_scope, model_alias, prompt_committed, outcome, started_at)
        VALUES ('uncertain-old', ?, 'codex-cli', 'old-scope', 'other-model', 1, 'ambiguous', '2026-09-25')`).run(id);
      db.exec(`INSERT INTO pending_digests
        (id, trace_id, input_json, status, created, next_retry_at, ambiguous_invocation_id)
        VALUES ('digest-old', 'trace-old', '{}', 'ambiguous', '2026-09-25', '2026-09-25', 'uncertain-old')`);
      checkCliEnvironmentMock.mockResolvedValue(cliEnvironment());
      runCliLLMMock.mockResolvedValue(OK);
      await handlers.get('connections:test')!(null, id, undefined, { models: ['gpt-5'] });
      expect(connectionRow(db, id)).toMatchObject({ status: 'ambiguous', status_reason: 'previous reason' });
      expect(db.prepare("SELECT resolution FROM cli_invocations WHERE id = 'uncertain-old'").get()).toEqual({ resolution: null });
      expect(db.prepare("SELECT status, ambiguous_invocation_id, next_retry_at FROM pending_digests WHERE id = 'digest-old'").get())
        .toEqual({ status: 'ambiguous', ambiguous_invocation_id: 'uncertain-old', next_retry_at: '2026-09-25' });
    });

    it('ambiguous 连接测试失败保持 ambiguous 与原因', async () => {
      const id = seedCliConnection(dbHolder.db, 'ambiguous');
      checkCliEnvironmentMock.mockResolvedValue(cliEnvironment());
      runCliLLMMock.mockRejectedValue(new CliLLMError('model_unavailable', 'model not found'));
      await handlers.get('connections:test')!(null, id, undefined, { models: ['gpt-5'] });
      expect(connectionRow(dbHolder.db, id)).toMatchObject({ status: 'ambiguous', status_reason: 'previous reason' });
    });

    it('ambiguous 连接在测试期间账号变化，不能以 untested 静默解除 ambiguous', async () => {
      // 复现：client/electron/ipc/connections.ts 在 attributionUnconfirmed 时把状态写成
      // 'untested'，未调用 resolveAmbiguousConnection，也不保留 'ambiguous'。结果：未解决的
      // uncertain invocation 仍在，但后台准入（status 不再是 ambiguous）已放行，违反设计 §5.4
      // “未解决的 uncertain invocation 阻断受影响路由；不能通过刷新/复检清除”。
      const id = seedCliConnection(dbHolder.db, 'ambiguous');
      bindEnvironment(dbHolder.db, id);
      checkCliEnvironmentMock
        .mockResolvedValueOnce(cliEnvironment())
        .mockResolvedValueOnce(cliEnvironment('codex-cli', { scope: 'datapilot-workspace' }));
      runCliLLMMock.mockResolvedValue(OK);
      await handlers.get('connections:test')!(null, id, undefined, { models: ['gpt-5'] });
      expect(connectionRow(dbHolder.db, id).status).toBe('ambiguous');
    });

    it('取消测试会恢复原状态，且操作结束前拒绝重复测试', async () => {
      const id = seedCliConnection(dbHolder.db, 'online', ['default']);
      const environment = cliEnvironment();
      let releaseEnvironment!: (value: ReturnType<typeof cliEnvironment>) => void;
      checkCliEnvironmentMock.mockImplementationOnce(() => new Promise(resolve => {
        releaseEnvironment = resolve;
      }));

      const first = handlers.get('connections:test')!(null, id) as Promise<{ cancelled: boolean }>;
      expect(connectionRow(dbHolder.db, id).status).toBe('testing');
      await expect(handlers.get('connections:test')!(null, id)).rejects.toThrow(/正在检查或测试/);
      expect(handlers.get('connections:cancel-test')!(null, id)).toEqual({ cancelled: true });
      releaseEnvironment(environment);
      const result = await first;

      expect(result.cancelled).toBe(true);
      expect(runCliLLMMock).not.toHaveBeenCalled();
      const row = connectionRow(dbHolder.db, id);
      expect(row.status).toBe('online');
      expect(row.status_reason).toBe('previous reason');
      expect(JSON.parse(row.available_models!)).toEqual(['default']);
      // Note: the environment facts observed before the cancel (path/version/generation)
      // are still persisted; only the status is restored.
    });

    it('测试进行中取消：已完成的结果保留在返回值，状态恢复为原状态（不按结果改写）', async () => {
      const id = seedCliConnection(dbHolder.db, 'ambiguous');
      checkCliEnvironmentMock.mockResolvedValue(cliEnvironment());
      runCliLLMMock
        .mockImplementationOnce(async () => {
          handlers.get('connections:cancel-test')!(null, id);
          return OK;
        })
        .mockResolvedValue(OK);
      const result = await handlers.get('connections:test')!(null, id, undefined, { models: ['gpt-5', 'gpt-5-mini'] });
      expect(result).toMatchObject({ cancelled: true, online: false, totalCount: 2 });
      expect(runCliLLMMock).toHaveBeenCalledTimes(1);
      // A partial success during a cancelled run must not resolve the ambiguous pause.
      expect(connectionRow(dbHolder.db, id)).toMatchObject({ status: 'ambiguous', status_reason: 'previous reason' });
    });

    it('测试中 runCliLLM 因取消而 aborted：恢复原状态', async () => {
      const id = seedCliConnection(dbHolder.db, 'untested');
      checkCliEnvironmentMock.mockResolvedValue(cliEnvironment());
      runCliLLMMock.mockImplementation(async () => {
        handlers.get('connections:cancel-test')!(null, id);
        throw new CliLLMError('aborted', 'CLI invocation was cancelled');
      });
      const result = await handlers.get('connections:test')!(null, id, undefined, { models: ['gpt-5'] });
      expect(result).toMatchObject({ cancelled: true });
      expect(connectionRow(dbHolder.db, id).status).toBe('untested');
    });
  });

  describe('connections:check-environment / refresh-models / models', () => {
    it('检查环境保留 online/ambiguous，其余置为 untested，并刷新同一环境的模型目录', async () => {
      const id = seedCliConnection(dbHolder.db, 'online', ['default']);
      const environment = cliEnvironment();
      checkCliEnvironmentMock.mockResolvedValue(environment);
      refreshCatalogMock.mockResolvedValue({
        status: 'refreshed',
        snapshot: { source: 'codex_app_server', items: [{ id: 'gpt-5.3-codex' }, { id: 'gpt-5.2' }], fetchedAt: '2026-09-25T00:00:00.000Z' },
      });

      const checked = await handlers.get('connections:check-environment')!(null, id);

      expect(checked).toMatchObject({
        status: 'online',
        scopeState: 'known',
        scopeLabel: 'pro',
        catalog: { status: 'refreshed', source: 'codex_app_server', count: 2, fetchedAt: '2026-09-25T00:00:00.000Z', errorKind: null },
      });
      expect(refreshCatalogMock).toHaveBeenCalledTimes(1);
      expect(refreshCatalogMock.mock.calls[0][1]).toMatchObject({ connectionId: id, dataDir: '/tmp/test-data', environment });
      const row = connectionRow(dbHolder.db, id);
      expect(row.status).toBe('online');
      // Model evidence is never cleared by an environment check; generation recorded.
      expect(JSON.parse(row.available_models!)).toEqual(['default']);
      expect(row.validation_fingerprint).toBe('generation-1');

      dbHolder.db.prepare("UPDATE model_connections SET status = 'offline' WHERE id = ?").run(id);
      await expect(handlers.get('connections:refresh-models')!(null, id)).resolves.toMatchObject({ status: 'untested' });
      expect(refreshCatalogMock).toHaveBeenCalledTimes(2);

      dbHolder.db.prepare("UPDATE model_connections SET status = 'ambiguous' WHERE id = ?").run(id);
      await expect(handlers.get('connections:check-environment')!(null, id)).resolves.toMatchObject({ status: 'ambiguous' });
    });

    it('检查环境取消时恢复原状态且不刷新目录', async () => {
      const id = seedCliConnection(dbHolder.db, 'online', ['default']);
      let releaseEnvironment!: (value: ReturnType<typeof cliEnvironment>) => void;
      checkCliEnvironmentMock.mockImplementationOnce(() => new Promise(resolve => {
        releaseEnvironment = resolve;
      }));
      const pending = handlers.get('connections:check-environment')!(null, id) as Promise<{ status: string }>;
      expect(handlers.get('connections:cancel-test')!(null, id)).toEqual({ cancelled: true });
      releaseEnvironment(cliEnvironment());
      await expect(pending).resolves.toMatchObject({ status: 'online' });
      expect(refreshCatalogMock).not.toHaveBeenCalled();
      expect(connectionRow(dbHolder.db, id)).toMatchObject({ status: 'online', status_reason: 'previous reason' });
    });

    it('环境检查成功的 untested CLI 连接按统一准入口径计为可用', async () => {
      const id = seedCliConnection(dbHolder.db);
      checkCliEnvironmentMock.mockResolvedValueOnce(cliEnvironment());

      await handlers.get('connections:check-environment')!(null, id);

      const healthCalls = healthSendMock.mock.calls.filter(
        ([channel]) => channel === 'llm-health-changed',
      );
      const snapshot = healthCalls.at(-1)?.[1] as {
        availableCount: number;
        needsAttentionCount: number;
      };
      expect(connectionRow(dbHolder.db, id).status).toBe('untested');
      expect(snapshot.availableCount).toBe(1);
      expect(snapshot.needsAttentionCount).toBe(0);
    });

    it('环境错误立即广播到 AI 服务状态，并保留可操作的报错原因', async () => {
      const id = seedCliConnection(dbHolder.db);
      checkCliEnvironmentMock.mockRejectedValueOnce(
        new CliLLMError('not_authenticated', 'codex CLI is not logged in', {
          needsUserAction: true,
        }),
      );

      await handlers.get('connections:check-environment')!(null, id);

      const healthCalls = healthSendMock.mock.calls.filter(
        ([channel]) => channel === 'llm-health-changed',
      );
      expect(healthCalls.length).toBeGreaterThan(0);
      const snapshot = healthCalls.at(-1)?.[1] as {
        needsAttentionCount: number;
        errors: Array<{ connectionId: string; kind: string; message: string }>;
      };
      expect(snapshot.needsAttentionCount).toBe(1);
      expect(snapshot.errors).toContainEqual(expect.objectContaining({
        connectionId: id,
        kind: 'not_authenticated',
        message: 'codex CLI is not logged in',
      }));
      expect(refreshCatalogMock).not.toHaveBeenCalled();
    });

    it('connections:models 返回在用路由及与后台一致的准入结论', async () => {
      const id = seedCliConnection(dbHolder.db, 'online');
      useRoutes({
        light: [id, 'gpt-5-mini'],
        standard: [id, 'gpt-5.3-codex'],
        heavy: [id, 'default'],
      });
      // Older epoch evidence is history only.
      const old = bindEnvironment(dbHolder.db, id, cliEnvironment('codex-cli', { generation: 'generation-0' }));
      recordModelObservation(dbHolder.db, {
        connectionId: id, scopeKey: old.scopeKey, authEpoch: old.authEpoch, modelId: 'gpt-5-mini',
        selectionMode: 'pinned_id', outcome: 'success', source: 'business',
      });
      const binding = bindEnvironment(dbHolder.db, id);
      expect(binding.authEpoch).toBe(2);
      recordModelObservation(dbHolder.db, {
        connectionId: id, scopeKey: binding.scopeKey, authEpoch: binding.authEpoch, modelId: 'gpt-5.3-codex',
        selectionMode: 'pinned_id', outcome: 'model_rejected', source: 'test', errorKind: 'model_unavailable',
      });
      recordModelObservation(dbHolder.db, {
        connectionId: id, scopeKey: binding.scopeKey, authEpoch: binding.authEpoch, modelId: 'default',
        selectionMode: 'follow_default', outcome: 'success', source: 'business',
      });

      const view = await handlers.get('connections:models')!(null, id) as {
        binding: { scopeState: string; authEpoch: number };
        inUse: Array<{ tier: string; modelId: string; selectionMode: string; admission: Record<string, unknown> }>;
        observations: Array<{ modelId: string }>;
        history: Array<{ modelId: string; authEpoch: number }>;
        catalog: unknown;
      };
      expect(view.binding).toMatchObject({ scopeState: 'known', authEpoch: 2 });
      expect(view.catalog).toBeNull();
      expect(view.inUse).toEqual([
        expect.objectContaining({
          tier: 'light', modelId: 'gpt-5-mini', selectionMode: 'pinned_id',
          admission: { allowed: true, selectionMode: 'pinned_id', firstCall: true },
        }),
        expect.objectContaining({
          tier: 'standard', modelId: 'gpt-5.3-codex',
          admission: { allowed: false, selectionMode: 'pinned_id', reason: 'model_rejected' },
        }),
        expect.objectContaining({
          tier: 'heavy', modelId: 'default', selectionMode: 'follow_default',
          admission: { allowed: true, selectionMode: 'follow_default', firstCall: false },
        }),
      ]);
      expect(view.observations.map(o => o.modelId).sort()).toEqual(['default', 'gpt-5.3-codex']);
      expect(view.history).toEqual([expect.objectContaining({ modelId: 'gpt-5-mini', authEpoch: 1 })]);

      expect(() => handlers.get('connections:models')!(null, 'mc_deadbeef')).toThrow(/不存在/);
      expect(() => handlers.get('connections:models')!(null, '../etc')).toThrow();
    });

    it('connections:models：scope unknown 与连接 busy 时后台准入不放行', async () => {
      const id = seedCliConnection(dbHolder.db, 'online');
      useRoutes({ standard: [id, 'gpt-5.3-codex'] });
      bindEnvironment(dbHolder.db, id, cliEnvironment('codex-cli', { scope: null }));
      let view = await handlers.get('connections:models')!(null, id) as { inUse: Array<{ admission: Record<string, unknown> }> };
      expect(view.inUse[0].admission).toMatchObject({ allowed: false, reason: 'scope_unknown' });
      bindEnvironment(dbHolder.db, id);
      dbHolder.db.prepare("UPDATE model_connections SET status = 'testing' WHERE id = ?").run(id);
      view = await handlers.get('connections:models')!(null, id) as { inUse: Array<{ admission: Record<string, unknown> }> };
      expect(view.inUse[0].admission).toMatchObject({ allowed: false, reason: 'connection_busy' });
    });
  });
});

// HIGH 2 (audit-10, 2026-05-21): connections:update credentials 8KB cap。
// 之前 create path 有上限但 update path 漏检,renderer 可以先 create 1KB
// 再 update 到 100MB,绕过 create 的限制。修复后 create / update 都用同
// MAX_CREDENTIALS_BYTES 常量,行为对齐。
describe('HIGH 2 — connections credentials 8KB cap (create + update)', () => {
  beforeEach(() => {
    handlers.clear();
    dbHolder.db = setupTestDb();
    registerConnectionHandlers('/tmp/test-data');
  });

  it('create 时 credentials JSON > 8192 → throw,DB 不插入', () => {
    const createHandler = handlers.get('connections:create')! as Handler;
    const huge = { api_key: 'x'.repeat(9000) }; // JSON 后 > 8KB
    expect(() => createHandler(null, { name: 'big', provider_type: 'anthropic', credentials: huge })).toThrow(/too large/i);

    const cnt = dbHolder.db.prepare('SELECT COUNT(*) as n FROM model_connections WHERE name = ?').get('big') as { n: number };
    expect(cnt.n).toBe(0);
  });

  it('update 时 credentials JSON > 8192 → throw,DB 不写入', () => {
    const createHandler = handlers.get('connections:create')! as Handler;
    const updateHandler = handlers.get('connections:update')! as Handler;

    // 先 create 一个小 payload 的连接
    const conn = createHandler(null, {
      name: 'tiny',
      provider_type: 'anthropic',
      credentials: { api_key: 'sk-small' },
    }) as { id: string; credentials: string };

    const beforeCreds = dbHolder.db
      .prepare('SELECT credentials FROM model_connections WHERE id = ?')
      .get(conn.id) as { credentials: string };

    // 然后 update 一个 9KB payload → 必须被拒
    const huge = { api_key: 'y'.repeat(9000) };
    expect(() => updateHandler(null, conn.id, { credentials: huge })).toThrow(/too large/i);

    const afterCreds = dbHolder.db
      .prepare('SELECT credentials FROM model_connections WHERE id = ?')
      .get(conn.id) as { credentials: string };
    expect(afterCreds.credentials, 'credentials 应保持原值,未被部分写入').toBe(beforeCreds.credentials);
  });

  it('update 时只改 name(无 credentials)不受 cap 影响', () => {
    const createHandler = handlers.get('connections:create')! as Handler;
    const updateHandler = handlers.get('connections:update')! as Handler;

    const conn = createHandler(null, {
      name: 'rename-me',
      provider_type: 'anthropic',
      credentials: { api_key: 'sk-1' },
    }) as { id: string };

    expect(() => updateHandler(null, conn.id, { name: 'renamed' })).not.toThrow();
    const row = dbHolder.db
      .prepare('SELECT name FROM model_connections WHERE id = ?')
      .get(conn.id) as { name: string };
    expect(row.name).toBe('renamed');
  });
});
