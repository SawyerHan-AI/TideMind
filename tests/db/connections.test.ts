/**
 * db/connections.ts 单元测试
 *
 * ModelConnection CRUD：创建、列表、更新、归档、凭据序列化。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_s: string, _p: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

import type Database from 'better-sqlite3';
import { setupTestDb } from '../helpers/test-db.js';
import {
  createConnection,
  getConnection,
  listConnections,
  updateConnection,
  updateConnectionStatus,
  archiveConnection,
  unarchiveConnection,
  deleteConnection,
} from '../../src/db/connections.js';
import type { AnthropicCredentials, VertexCredentials } from '../../src/db/connections.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
});

// ===== createConnection + getConnection =====

describe('createConnection', () => {
  it('创建连接并读取回来', () => {
    const conn = createConnection(db, {
      name: 'My Anthropic',
      provider_type: 'anthropic',
      credentials: { api_key: 'sk-test-123' },
    });

    expect(conn.id).toMatch(/^mc_[a-f0-9]{8}$/);
    expect(conn.name).toBe('My Anthropic');
    expect(conn.provider_type).toBe('anthropic');
    expect(conn.status).toBe('unconfigured');
    expect(conn.archived).toBe(0);

    const fetched = getConnection(db, conn.id);
    expect(fetched).toBeDefined();
    expect(fetched!.name).toBe('My Anthropic');
    expect(fetched!.provider_type).toBe('anthropic');
  });

  it('无凭据时默认为空 JSON 对象', () => {
    const conn = createConnection(db, {
      name: 'Empty',
      provider_type: 'ollama',
    });
    expect(conn.credentials).toBe('{}');
    const fetched = getConnection(db, conn.id);
    expect(JSON.parse(fetched!.credentials)).toEqual({});
  });
});

// ===== listConnections =====

describe('listConnections', () => {
  it('返回所有非归档连接', () => {
    createConnection(db, { name: 'A', provider_type: 'anthropic' });
    createConnection(db, { name: 'B', provider_type: 'vertex' });
    const archived = createConnection(db, { name: 'C', provider_type: 'gemini' });
    archiveConnection(db, archived.id);

    const active = listConnections(db);
    expect(active).toHaveLength(2);
    expect(active.map(c => c.name).sort()).toEqual(['A', 'B']);
  });

  it('includeArchived=true 返回全部', () => {
    createConnection(db, { name: 'A', provider_type: 'anthropic' });
    const archived = createConnection(db, { name: 'B', provider_type: 'vertex' });
    archiveConnection(db, archived.id);

    const all = listConnections(db, true);
    expect(all).toHaveLength(2);
  });

  it('空表返回空数组', () => {
    expect(listConnections(db)).toEqual([]);
  });
});

// ===== updateConnectionStatus =====

describe('updateConnectionStatus', () => {
  it('更新状态和可用模型', () => {
    const conn = createConnection(db, { name: 'Test', provider_type: 'anthropic' });
    updateConnectionStatus(db, conn.id, 'online', ['claude-3-haiku', 'claude-3-sonnet']);

    const fetched = getConnection(db, conn.id)!;
    expect(fetched.status).toBe('online');
    expect(JSON.parse(fetched.available_models!)).toEqual(['claude-3-haiku', 'claude-3-sonnet']);
    expect(fetched.last_checked).toBeTruthy();
  });

  it('availableModels 为 null 时正确存储', () => {
    const conn = createConnection(db, { name: 'Test', provider_type: 'ollama' });
    updateConnectionStatus(db, conn.id, 'offline', null);

    const fetched = getConnection(db, conn.id)!;
    expect(fetched.status).toBe('offline');
    expect(fetched.available_models).toBeNull();
  });
});

// ===== archiveConnection / unarchiveConnection =====

describe('archiveConnection / unarchiveConnection', () => {
  it('归档后从默认列表中消失，取消归档后恢复', () => {
    const conn = createConnection(db, { name: 'Temp', provider_type: 'gemini' });

    archiveConnection(db, conn.id);
    expect(listConnections(db)).toHaveLength(0);
    expect(getConnection(db, conn.id)!.archived).toBe(1);

    unarchiveConnection(db, conn.id);
    expect(listConnections(db)).toHaveLength(1);
    expect(getConnection(db, conn.id)!.archived).toBe(0);
  });
});

// ===== deleteConnection =====

describe('deleteConnection', () => {
  it('物理删除后 getConnection 返回 undefined', () => {
    const conn = createConnection(db, { name: 'ToDelete', provider_type: 'anthropic' });
    deleteConnection(db, conn.id);
    expect(getConnection(db, conn.id)).toBeUndefined();
  });
});

// ===== 凭据序列化 =====

describe('credentials 序列化', () => {
  it('Anthropic 凭据正确序列化/反序列化', () => {
    const creds: AnthropicCredentials = { api_key: 'sk-ant-test-key-123' };
    const conn = createConnection(db, {
      name: 'Anthropic',
      provider_type: 'anthropic',
      credentials: creds,
    });

    const fetched = getConnection(db, conn.id)!;
    const parsed = JSON.parse(fetched.credentials) as AnthropicCredentials;
    expect(parsed.api_key).toBe('sk-ant-test-key-123');
  });

  it('Vertex 凭据正确序列化/反序列化', () => {
    const creds: VertexCredentials = { project_id: 'my-project', region: 'us-central1' };
    const conn = createConnection(db, {
      name: 'Vertex',
      provider_type: 'vertex',
      credentials: creds,
    });

    const fetched = getConnection(db, conn.id)!;
    const parsed = JSON.parse(fetched.credentials) as VertexCredentials;
    expect(parsed.project_id).toBe('my-project');
    expect(parsed.region).toBe('us-central1');
  });

  it('updateConnection 更新凭据后能正确读回', () => {
    const conn = createConnection(db, {
      name: 'Mutable',
      provider_type: 'anthropic',
      credentials: { api_key: 'old-key' },
    });

    updateConnection(db, conn.id, { credentials: { api_key: 'new-key' } });
    const fetched = getConnection(db, conn.id)!;
    expect(JSON.parse(fetched.credentials)).toEqual({ api_key: 'new-key' });
  });
});

// ===== 重名处理 =====

describe('重名连接', () => {
  it('允许创建同名连接（不同 ID）', () => {
    const a = createConnection(db, { name: 'Same Name', provider_type: 'anthropic' });
    const b = createConnection(db, { name: 'Same Name', provider_type: 'vertex' });
    expect(a.id).not.toBe(b.id);
    expect(listConnections(db)).toHaveLength(2);
  });
});

// ===== 按 ID 查询 =====

describe('getConnection', () => {
  it('按 ID 返回正确的连接', () => {
    const a = createConnection(db, { name: 'Alpha', provider_type: 'anthropic' });
    const b = createConnection(db, { name: 'Beta', provider_type: 'vertex' });

    expect(getConnection(db, a.id)!.name).toBe('Alpha');
    expect(getConnection(db, b.id)!.name).toBe('Beta');
  });

  it('不存在的 ID 返回 undefined', () => {
    expect(getConnection(db, 'mc_nonexistent')).toBeUndefined();
  });
});
