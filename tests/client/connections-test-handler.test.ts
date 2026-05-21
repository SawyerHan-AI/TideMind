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
const { handlers, probeAnthropicMock, dbHolder, electronMock } = vi.hoisted(() => {
  const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown | Promise<unknown>>();
  return {
    handlers,
    probeAnthropicMock: vi.fn(),
    dbHolder: { db: null as Database.Database | null },
    electronMock: {
      ipcMain: {
        handle: (channel: string, handler: (e: unknown, ...args: unknown[]) => unknown | Promise<unknown>) => {
          handlers.set(channel, handler);
        },
      },
      dialog: { showOpenDialog: vi.fn() },
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

import { registerConnectionHandlers } from '../../client/electron/ipc/connections.js';

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
