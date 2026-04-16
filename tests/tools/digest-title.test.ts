/**
 * digest tool — title 字段测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, _param: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

vi.mock('../../src/stream/writer.js', () => ({
  appendToStream: vi.fn().mockReturnValue('stream:test:1'),
}));

vi.mock('../../src/config.js', () => ({
  getConfig: () => ({
    general: { data_dir: '/tmp/test-eb', user_name: 'tester' },
    anthropic: { api_key: 'test-key' },
    vertex: { project_id: '', region: 'us-central1' },
    ollama: { url: 'http://localhost:11434' },
    gemini: { api_key: '' },
    llm: { provider: 'anthropic', standard_model: 'test', heavy_model: 'test' },
    embedding: { provider: 'vertex', model: 'gemini-embedding-001', dimensions: 3072 },
    search: {},
    metabolism: {},
    gates: {},
    sources: {},
  }),
  getDataDir: () => '/tmp/test-eb',
  isLlmConfigured: () => true,
}));

const mockGetDb = vi.fn();
vi.mock('../../src/db/connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/connection.js')>();
  return { ...actual, isVecLoaded: () => false, getDb: () => mockGetDb() };
});

vi.mock('../../src/llm/client.js', () => ({
  callLLM: vi.fn().mockResolvedValue(''),
}));

import type Database from 'better-sqlite3';
import { setupTestDb } from '../helpers/test-db.js';
import { digest } from '../../src/tools/digest.js';
import { getNode } from '../../src/db/nodes.js';
import { SqliteRepository } from '../../src/db/sqlite-repository.js';

let db: Database.Database;
let repo: InstanceType<typeof SqliteRepository>;

beforeEach(() => {
  vi.clearAllMocks();
  db = setupTestDb();
  repo = new SqliteRepository(db);
  mockGetDb.mockReturnValue(db);
});

describe('digest with title', () => {
  it('传入 title 时节点正确存储 title', async () => {
    const result = await digest(repo, {
      content: '详细的技术方案说明',
      title: '架构设计文档',
      async: false,
    });

    expect(result.status).toBe('processed');
    const nodeId = result.created_nodes![0].id;
    const node = getNode(db, nodeId)!;
    expect(node.title).toBe('架构设计文档');
    expect(node.content).toBe('详细的技术方案说明');
  });

  it('不传 title 时节点 title 为 null', async () => {
    const result = await digest(repo, {
      content: '一段普通的记忆内容',
      async: false,
    });

    expect(result.status).toBe('processed');
    const nodeId = result.created_nodes![0].id;
    const node = getNode(db, nodeId)!;
    expect(node.title).toBeNull();
  });

  it('有 title 时允许 content 为空（不被质量门控拒绝）', async () => {
    const result = await digest(repo, {
      content: '',
      title: '标签节点',
      async: false,
    });

    expect(result.status).toBe('processed');
    const nodeId = result.created_nodes![0].id;
    const node = getNode(db, nodeId)!;
    expect(node.title).toBe('标签节点');
    expect(node.content).toBe('');
  });

  it('无 title 且 content 过短时仍被拒绝', async () => {
    const result = await digest(repo, {
      content: 'hi',
      async: false,
    });

    expect(result.status).toBe('rejected');
  });

  it('有 title 且 content 过短时不被拒绝', async () => {
    const result = await digest(repo, {
      content: 'hi',
      title: '简短笔记',
      async: false,
    });

    expect(result.status).toBe('processed');
  });
});
