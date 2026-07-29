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
  healthSendMock,
  dbHolder,
  electronMock,
} = vi.hoisted(() => {
  const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown | Promise<unknown>>();
  return {
    handlers,
    probeAnthropicMock: vi.fn(),
    checkCliEnvironmentMock: vi.fn(),
    runCliLLMMock: vi.fn(),
    healthSendMock: vi.fn(),
    dbHolder: { db: null as Database.Database | null },
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

import { registerConnectionHandlers } from '../../client/electron/ipc/connections.js';
import { CliLLMError } from '../../src/llm/cli/errors.js';

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

function cliEnvironment(providerType: 'claude-cli' | 'codex-cli' = 'codex-cli') {
  return {
    providerType,
    status: 'untested' as const,
    resolved: {
      kind: providerType === 'codex-cli' ? 'codex' : 'claude',
      path: providerType === 'codex-cli' ? '/usr/local/bin/codex' : '/usr/local/bin/claude',
      version: '1.0.0',
      controlledPath: '/usr/bin:/bin',
      source: 'known_path' as const,
      identity: { device: 1, inode: 1, size: 1, ctimeMs: 1, sha256: 'fixture' },
    },
    auth: {
      method: 'subscription' as const,
      accountScope: `${providerType}:test-account`,
    },
    authFingerprint: 'auth-fingerprint',
    validationFingerprint: 'validation-fingerprint',
    capabilityFingerprint: 'capability-fingerprint',
    capabilityStatus: 'verified' as const,
    candidateModels: ['default', 'fast'],
    codexGate: providerType === 'codex-cli' ? {
      fingerprint: 'capability-fingerprint',
      manifest: {
        version: '1.0.0',
        disabledFeatures: [],
        requiredArgs: [],
      },
    } : undefined,
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
    status === 'online' ? 'previous reason' : null,
    '/usr/local/bin/codex',
    '1.0.0',
    'subscription',
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
    checkCliEnvironmentMock.mockReset();
    runCliLLMMock.mockReset();
    healthSendMock.mockReset();
    registerConnectionHandlers('/tmp/test-data');
  });

  it('测试全部候选模型并只把真实成功模型写入 available_models', async () => {
    const id = seedCliConnection(dbHolder.db);
    const environment = cliEnvironment();
    checkCliEnvironmentMock.mockResolvedValue(environment);
    runCliLLMMock.mockImplementation(async (
      _db: unknown,
      _dataDir: string,
      request: { modelAlias: string },
    ) => {
      if (request.modelAlias === 'fast') throw new Error('model unavailable');
      return { text: 'TIDEMIND_CONNECTION_OK', actualModel: 'gpt-test', usage: null };
    });

    const result = await handlers.get('connections:test')!(null, id) as {
      online: boolean;
      models: string[];
      successCount: number;
      totalCount: number;
    };

    expect(runCliLLMMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      online: true,
      models: ['default'],
      successCount: 1,
      totalCount: 2,
    });
    const row = dbHolder.db.prepare(`
      SELECT status, available_models, validation_fingerprint
      FROM model_connections WHERE id = ?
    `).get(id) as {
      status: string;
      available_models: string;
      validation_fingerprint: string;
    };
    expect(row.status).toBe('degraded');
    expect(JSON.parse(row.available_models)).toEqual(['default']);
    expect(row.validation_fingerprint).toBe(environment.validationFingerprint);
  });

  it('取消测试会恢复同一环境下原有验证结果，且操作结束前拒绝重复测试', async () => {
    const id = seedCliConnection(dbHolder.db, 'online', ['default']);
    const environment = cliEnvironment();
    let releaseEnvironment!: (value: ReturnType<typeof cliEnvironment>) => void;
    checkCliEnvironmentMock.mockImplementationOnce(() => new Promise(resolve => {
      releaseEnvironment = resolve;
    }));

    const first = handlers.get('connections:test')!(null, id) as Promise<{
      cancelled: boolean;
    }>;
    await expect(handlers.get('connections:test')!(null, id)).rejects.toThrow(/正在检查或测试/);
    expect(handlers.get('connections:cancel-test')!(null, id)).toEqual({ cancelled: true });
    releaseEnvironment(environment);
    const result = await first;

    expect(result.cancelled).toBe(true);
    expect(runCliLLMMock).not.toHaveBeenCalled();
    const row = dbHolder.db.prepare(`
      SELECT status, status_reason, available_models, validation_fingerprint
      FROM model_connections WHERE id = ?
    `).get(id) as {
      status: string;
      status_reason: string | null;
      available_models: string;
      validation_fingerprint: string;
    };
    expect(row.status).toBe('online');
    expect(row.status_reason).toBe('previous reason');
    expect(JSON.parse(row.available_models)).toEqual(['default']);
    expect(row.validation_fingerprint).toBe('validation-fingerprint');
  });

  it('检查环境不改变同一指纹下已验证连接状态，取消时也恢复原状态', async () => {
    const id = seedCliConnection(dbHolder.db, 'online', ['default']);
    const environment = cliEnvironment();
    checkCliEnvironmentMock.mockResolvedValueOnce(environment);

    const checked = await handlers.get('connections:check-environment')!(null, id) as {
      status: string;
    };
    expect(checked.status).toBe('online');

    let releaseEnvironment!: (value: ReturnType<typeof cliEnvironment>) => void;
    checkCliEnvironmentMock.mockImplementationOnce(() => new Promise(resolve => {
      releaseEnvironment = resolve;
    }));
    const pending = handlers.get('connections:check-environment')!(null, id) as Promise<{
      status: string;
    }>;
    expect(handlers.get('connections:cancel-test')!(null, id)).toEqual({ cancelled: true });
    releaseEnvironment(environment);
    const cancelled = await pending;
    expect(cancelled.status).toBe('online');

    const row = dbHolder.db.prepare(`
      SELECT status, available_models FROM model_connections WHERE id = ?
    `).get(id) as { status: string; available_models: string };
    expect(row.status).toBe('online');
    expect(JSON.parse(row.available_models)).toEqual(['default']);
  });

  it('仅环境检查成功的 untested 连接不计为可用', async () => {
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
    expect(snapshot.availableCount).toBe(0);
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
