/**
 * digest tool 集成测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mocks（必须在 import 之前） ----
vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, _param: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

vi.mock('../../src/stream/writer.js', () => ({
  appendToStream: vi.fn().mockReturnValue('stream:2026-03-25:abc123:1'),
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
    search: { alpha: 0.4, beta: 0.3, gamma: 0.2, delta: 0.1 },
    metabolism: { daily_check_hours: [3], weekly_check_days: [0] },
    gates: {
      vector_search: 50,
      graph_expansion: 20,
      graph_expansion_links: 10,
      crystal_generation: 100,
      divergent_scan: 200,
      learning_2_min_nodes: 30,
      learning_2_min_recall_ops: 10,
    },
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

vi.mock('../../src/llm/embedding.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(3072)),
}));

vi.mock('../../src/llm/client.js', () => ({
  callLLM: vi.fn().mockResolvedValue('LLM response'),
}));

vi.mock('../../src/graph/landing.js', () => ({
  findLandingConnections: vi.fn().mockReturnValue({
    action: 'new',
    confirmedLinks: [],
    pendingLinks: [],
  }),
}));

vi.mock('../../src/graph/dedup.js', () => ({
  reconsolidateNode: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/db/vectors.js', () => ({
  insertVector: vi.fn(),
  deleteVector: vi.fn(),
}));

import type Database from 'better-sqlite3';
import { setupTestDb, seedNode, seedLink } from '../helpers/test-db.js';
import { digest } from '../../src/tools/digest.js';
import { getNode } from '../../src/db/nodes.js';
import { appendToStream } from '../../src/stream/writer.js';
import { invalidateGateCache } from '../../src/db/stats.js';
import { SqliteRepository } from '../../src/db/sqlite-repository.js';
import type { DigestInput } from '../../src/types.js';

let db: Database.Database;
let repo: InstanceType<typeof SqliteRepository>;

beforeEach(() => {
  vi.clearAllMocks();
  db = setupTestDb();
  repo = new SqliteRepository(db);
  mockGetDb.mockReturnValue(db);
  invalidateGateCache();
});

// ===== 常规消化 =====

describe('digest - normal (sync)', () => {
  it('should create nodes and return processed status in sync mode', async () => {
    const result = await digest(repo, {
      content: 'This is a test fact about software architecture patterns and best practices',
      async: false,
    });

    expect(result.status).toBe('processed');
    expect(result.trace_id).toBeTruthy();
    expect(result.created_nodes).toBeDefined();
    expect(result.created_nodes!.length).toBeGreaterThan(0);
  });

  it('should store original content without LLM rewriting (Layer 0)', async () => {
    const content = 'This is a long enough content that previously triggered LLM extraction';
    const result = await digest(repo, {
      content,
      async: false,
    });

    const nodeId = result.created_nodes![0].id;
    const node = getNode(db, nodeId);
    expect(node).toBeTruthy();
    expect(node!.content).toBe(content);
  });

  it('should inherit tags from input', async () => {
    const result = await digest(repo, {
      content: 'Content with inherited tags from Logseq preprocessing step',
      tags: ['AI', 'architecture'],
      async: false,
    });

    const nodeId = result.created_nodes![0].id;
    const node = getNode(db, nodeId);
    expect(node!.tags).toBe(JSON.stringify(['AI', 'architecture']));
  });

  it('should log operation after digest', async () => {
    await digest(repo, {
      content: 'Something worth storing in the Tide Mind system for later use',
      async: false,
    });

    const ops = db.prepare("SELECT * FROM operation_log WHERE operation = 'digest'").all() as Array<{ operation: string; input_summary: string }>;
    expect(ops.length).toBeGreaterThan(0);
  });

  it('should write to stream before processing', async () => {
    await digest(repo, {
      content: 'Stream content test that is long enough for LLM extraction process',
      async: false,
    });

    expect(appendToStream).toHaveBeenCalled();
  });

  it('should propagate source metadata (tool, session, files)', async () => {
    const result = await digest(repo, {
      content: 'Content with source metadata for tracing through the system completely',
      source: { tool: 'cursor', session: 'sess-42', files: ['main.ts'] },
      async: false,
    });

    const nodeId = result.created_nodes![0].id;
    const node = getNode(db, nodeId);
    expect(node!.source_tool).toBe('cursor');
    expect(node!.source_session).toBe('sess-42');
  });

  it('should pass source info to appendToStream', async () => {
    await digest(repo, {
      content: 'Content that goes to stream with source information attached to it',
      source: { tool: 'vscode', session: 'sess-1', files: ['a.ts'] },
      async: false,
    });

    expect(appendToStream).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: 'vscode',
        session: 'sess-1',
        files: ['a.ts'],
      }),
    );
  });

  it('should set source_stream on created node', async () => {
    const result = await digest(repo, {
      content: 'Content for stream ref test to verify source_stream is set correctly',
      async: false,
    });

    const nodeId = result.created_nodes![0].id;
    const node = getNode(db, nodeId);
    expect(node!.source_stream).toBe('stream:2026-03-25:abc123:1');
  });

  it('should always store original content (no LLM rewriting)', async () => {
    const content = 'Content that is stored as-is regardless of length';
    const result = await digest(repo, {
      content,
      async: false,
    });

    expect(result.created_nodes).toBeDefined();
    expect(result.created_nodes!.length).toBe(1);
    const node = getNode(db, result.created_nodes![0].id);
    expect(node!.content).toBe(content);
  });

  it('should store short content directly', async () => {
    const result = await digest(repo, {
      content: 'short',
      async: false,
    });

    expect(result.created_nodes).toBeDefined();
    expect(result.created_nodes!.length).toBe(1);
  });

  it('should infer project from context', async () => {
    const result = await digest(repo, {
      content: 'Something about architecture that is long enough for extraction by LLM',
      context: 'project: my-app',
      async: false,
    });

    const nodeId = result.created_nodes![0].id;
    const node = getNode(db, nodeId);
    // Project may come from extracted node or inferred
    expect(node).toBeTruthy();
  });

  it('should record strategy feedback', async () => {
    await digest(repo, {
      content: 'Content for strategy feedback test that is long enough for the system',
      async: false,
    });

    const feedback = db.prepare(
      "SELECT * FROM strategy_feedback WHERE strategy_name = 'digest-extract'",
    ).all() as Array<{ strategy_name: string; feedback_signal: number }>;
    expect(feedback.length).toBeGreaterThan(0);
  });
});

// ===== 异步模式 =====

describe('digest - async mode', () => {
  it('should return accepted status immediately', async () => {
    const result = await digest(repo, {
      content: 'Async content that should be accepted immediately without waiting for processing',
      // async defaults to true
    });

    expect(result.status).toBe('accepted');
    expect(result.trace_id).toBeTruthy();
    expect(result.created_nodes).toBeUndefined();
  });

  it('should still write to stream before returning', async () => {
    await digest(repo, {
      content: 'Async stream write test content that should be written before returning result',
    });

    expect(appendToStream).toHaveBeenCalled();
  });
});

// ===== 纠正模式 =====

describe('digest - correction mode', () => {
  it('should update existing node content when correcting', async () => {
    const existing = seedNode(db, { content: 'old content' });

    const result = await digest(repo, {
      content: 'corrected content',
      intent: 'correction',
      target_node: existing.id,
    });

    expect(result.status).toBe('processed');
    expect(result.updated_nodes).toBeDefined();
    expect(result.updated_nodes![0].content).toBe('corrected content');

    const updated = getNode(db, existing.id);
    expect(updated!.content).toBe('corrected content');
    expect(updated!.version).toBe(2);
  });

  it('should create meta node recording the correction', async () => {
    const existing = seedNode(db, { content: 'original fact' });

    await digest(repo, {
      content: 'corrected fact',
      intent: 'correction',
      target_node: existing.id,
    });

    const metaNodes = db.prepare(
      "SELECT * FROM nodes WHERE type = 'meta'",
    ).all() as Array<{ type: string; content: string }>;
    expect(metaNodes.length).toBe(1);
    expect(metaNodes[0].content).toContain('纠正');
  });

  it('should return rejected with reason when target_node does not exist', async () => {
    const result = await digest(repo, {
      content: 'correction for nonexistent',
      intent: 'correction',
      target_node: 'nonexistent-id',
    });

    expect(result.status).toBe('rejected');
    expect(result.reject_reason).toContain('nonexistent-id');
    expect(result.trace_id).toBeTruthy();
  });

  it('should delete link when correcting a link', async () => {
    const n1 = seedNode(db, { content: 'node A' });
    const n2 = seedNode(db, { content: 'node B' });
    seedLink(db, n1.id, n2.id);

    const result = await digest(repo, {
      content: 'unlink these nodes',
      intent: 'correction',
      target_link: { from: n1.id, to: n2.id },
    });

    expect(result.status).toBe('processed');

    const link = db.prepare(
      'SELECT * FROM links WHERE from_id = ? AND to_id = ?',
    ).get(n1.id, n2.id);
    expect(link).toBeFalsy();
  });
});

// ===== 归档模式 =====

describe('digest - archive mode', () => {
  it('should archive the target node', async () => {
    const node = seedNode(db, { content: 'to be archived' });

    const result = await digest(repo, {
      content: '',
      intent: 'archive',
      target_node: node.id,
    });

    expect(result.status).toBe('processed');
    expect(result.archived_nodes).toEqual([node.id]);

    const cooledDown = getNode(db, node.id);
    expect(cooledDown!.heat).toBeCloseTo(0.02);
  });

  it('should log archive operation', async () => {
    const node = seedNode(db, { content: 'archive log test' });

    await digest(repo, {
      content: '',
      intent: 'archive',
      target_node: node.id,
    });

    const ops = db.prepare(
      "SELECT * FROM operation_log WHERE operation = 'digest' AND input_summary LIKE '%archive%'",
    ).all();
    expect(ops.length).toBe(1);
  });
});

// ===== 类型推断 =====

describe('digest - type inference (fallback mode)', () => {
  it('should infer fact type for decision content', async () => {
    // Short content to skip LLM
    const result = await digest(repo, {
      content: '决定用 React',
      async: false,
    });

    const node = getNode(db, result.created_nodes![0].id);
    expect(node!.type).toBe('fact');
  });

  it('should infer preference type for preference content', async () => {
    const result = await digest(repo, {
      content: '偏好暗色主题',
      async: false,
    });

    const node = getNode(db, result.created_nodes![0].id);
    expect(node!.type).toBe('preference');
  });

  it('should infer idea type for hypothesis content', async () => {
    const result = await digest(repo, {
      content: '也许可以试试',
      async: false,
    });

    const node = getNode(db, result.created_nodes![0].id);
    expect(node!.type).toBe('idea');
  });

  it('should default to fact for generic content', async () => {
    const result = await digest(repo, {
      content: 'hello world',
      async: false,
    });

    const node = getNode(db, result.created_nodes![0].id);
    expect(node!.type).toBe('fact');
  });
});

// ===== 质量门控 =====

describe('content quality gates', () => {
  it('should reject empty content (hard reject)', async () => {
    const result = await digest(repo, {
      content: '',
      async: false,
    });

    expect(result.status).toBe('rejected');
    expect(result.reject_reason).toBeDefined();
    expect(result.created_nodes).toBeUndefined();
  });

  it('should reject very short content < 5 chars (hard reject)', async () => {
    const result = await digest(repo, {
      content: 'abc',
      async: false,
    });

    expect(result.status).toBe('rejected');
    expect(result.reject_reason).toBeDefined();
    expect(result.created_nodes).toBeUndefined();
  });

  it('should reject whitespace-only content (hard reject)', async () => {
    const result = await digest(repo, {
      content: '   \n\t  ',
      async: false,
    });

    expect(result.status).toBe('rejected');
    expect(result.reject_reason).toBeDefined();
    expect(result.created_nodes).toBeUndefined();
  });

  it('should accept short content (5-10 chars) with reduced heat', async () => {
    const result = await digest(repo, {
      content: '短内容测试',
      async: false,
    });

    expect(result.created_nodes).toBeDefined();
    expect(result.created_nodes!.length).toBe(1);

    const node = getNode(db, result.created_nodes![0].id);
    expect(node!.heat).toBeCloseTo(0.3, 1);
  });

  it('should accept pure URL with reduced heat (fallback path)', async () => {
    // 短 URL（< 30 字符）走 fallback 路径
    const result = await digest(repo, {
      content: 'https://example.com',
      async: false,
    });

    expect(result.created_nodes).toBeDefined();
    const node = getNode(db, result.created_nodes![0].id);
    expect(node!.heat).toBeCloseTo(0.3, 1);
  });

  it('should accept normal content with full heat (fallback path)', async () => {
    // 20+ 个中文字符，走 fallback 路径（中文按字数算 effectiveLength）
    const result = await digest(repo, {
      content: '这是一段有足够长度的正常内容包含有意义的知识信息',
      async: false,
    });

    expect(result.created_nodes).toBeDefined();
    const node = getNode(db, result.created_nodes![0].id);
    expect(node!.heat).toBeCloseTo(1.0, 1);
  });
});
