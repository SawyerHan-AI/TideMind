/**
 * recall tool 集成测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mocks（必须在 import 之前） ----
vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, _param: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

vi.mock('../../src/config.js', () => ({
  getConfig: () => ({
    general: { data_dir: '/tmp/test-eb', user_name: 'tester' },
    anthropic: { api_key: '' },
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
  isLlmConfigured: () => false,
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
  callLLM: vi.fn().mockResolvedValue('summary text'),
}));

vi.mock('../../src/search/hybrid.js', () => ({
  searchHybrid: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/metabolism/reconsolidate.js', () => ({
  reconsolidateOnRecall: vi.fn(),
}));

vi.mock('../../src/graph/expansion.js', () => ({
  expandFromNode: vi.fn().mockReturnValue([]),
}));

import type Database from 'better-sqlite3';
import { setupTestDb, seedNode, seedLink } from '../helpers/test-db.js';
import { recall } from '../../src/tools/recall.js';
import { getNode, bumpHeat } from '../../src/db/nodes.js';
import { searchHybrid } from '../../src/search/hybrid.js';
import { reconsolidateOnRecall } from '../../src/metabolism/reconsolidate.js';
import { expandFromNode } from '../../src/graph/expansion.js';
import { invalidateGateCache } from '../../src/db/stats.js';
import { SqliteRepository } from '../../src/db/sqlite-repository.js';
import type { BrainNode } from '../../src/types.js';

let db: Database.Database;
let repo: InstanceType<typeof SqliteRepository>;

beforeEach(() => {
  vi.clearAllMocks();
  db = setupTestDb();
  repo = new SqliteRepository(db);
  mockGetDb.mockReturnValue(db);
  invalidateGateCache();
});

// ===== query 模式 =====

describe('recall - query mode', () => {
  it('should call hybridSearch when query is provided', async () => {
    const node = seedNode(db, { content: 'test fact about TypeScript' });
    vi.mocked(searchHybrid).mockResolvedValueOnce([
      { node, score: 0.9, source: 'hybrid' },
    ]);

    const result = await recall(repo, { query: 'TypeScript' });

    expect(searchHybrid).toHaveBeenCalledWith(
      repo,
      'TypeScript',
      expect.objectContaining({ limit: 8 }),
    );
    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].content).toBe('test fact about TypeScript');
  });

  it('should respect limit parameter', async () => {
    vi.mocked(searchHybrid).mockResolvedValueOnce([]);

    await recall(repo, { query: 'test', limit: 5 });

    expect(searchHybrid).toHaveBeenCalledWith(
      repo,
      'test',
      expect.objectContaining({ limit: 5 }),
    );
  });

  it('should filter by scope (tag-based, post-search)', async () => {
    // scope 过滤现在是 searchHybrid 返回后按标签过滤
    const nodeWithTag = seedNode(db, { content: 'test with tag', tags: ['my-app'] });
    const nodeWithout = seedNode(db, { content: 'test no tag' });
    vi.mocked(searchHybrid).mockResolvedValueOnce([
      { node: nodeWithTag, score: 0.9, source: 'hybrid' },
      { node: nodeWithout, score: 0.8, source: 'hybrid' },
    ]);

    const result = await recall(repo, { query: 'test', scope: 'project:my-app' });

    // 只保留 tags 中包含 'my-app' 的节点
    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].content).toBe('test with tag');
  });

  it('should return summary for empty results', async () => {
    vi.mocked(searchHybrid).mockResolvedValueOnce([]);

    const result = await recall(repo, { query: 'nonexistent' });

    expect(result.nodes).toHaveLength(0);
    expect(result.summary).toBe('未找到相关记忆');
  });

  it('should generate summary with type counts', async () => {
    const n1 = seedNode(db, { type: 'fact', content: 'fact one for summary test' });
    const n2 = seedNode(db, { type: 'idea', content: 'idea one for summary test' });
    vi.mocked(searchHybrid).mockResolvedValueOnce([
      { node: n1, score: 0.9, source: 'hybrid' },
      { node: n2, score: 0.8, source: 'hybrid' },
    ]);

    const result = await recall(repo, { query: 'test' });

    expect(result.summary).toContain('2');
    expect(result.summary).toContain('fact');
    expect(result.summary).toContain('idea');
  });
});

// ===== node_id 模式 =====

describe('recall - node_id mode', () => {
  it('should return specific node by ID', async () => {
    const node = seedNode(db, { content: 'specific node lookup' });

    const result = await recall(repo, { node_id: node.id });

    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].id).toBe(node.id);
    expect(result.nodes[0].content).toBe('specific node lookup');
  });

  it('should return empty for nonexistent node_id', async () => {
    const result = await recall(repo, { node_id: 'nonexistent-id' });

    expect(result.nodes).toHaveLength(0);
  });

  it('should not return archived nodes', async () => {
    const node = seedNode(db, { content: 'archived node' });
    db.prepare('UPDATE nodes SET heat = 0.005 WHERE id = ?').run(node.id);

    const result = await recall(repo, { node_id: node.id });

    expect(result.nodes).toHaveLength(0);
  });

  it('should include maturity info in response', async () => {
    // 2026-05-19: heat 字段语义统一到 [0,1]。原测试用 heat=2.0 是基于旧"钳到 10"行为,
    // 现在 seed 起点必须 ≤1.0,bump 后也 ≤1.0。改用 heat=0.5 + bump 0.1 = 0.6 验证 bump 生效。
    const node = seedNode(db, { content: 'maturity test', heat: 0.5, refinement: 0.5 });

    const result = await recall(repo, { node_id: node.id });

    expect(result.nodes[0].maturity).toBeDefined();
    // Response uses the in-memory node object (pre-bump value), DB is bumped separately
    expect(result.nodes[0].maturity.heat).toBe(0.5);
    expect(result.nodes[0].maturity.refinement).toBe(0.5);
    // But the DB value should be bumped
    const afterDb = getNode(db, node.id);
    expect(afterDb!.heat).toBeCloseTo(0.6, 5);
  });
});

// ===== heat bump 副作用 =====

describe('recall - heat bump side effect', () => {
  it('should bump heat on recalled nodes', async () => {
    // heat 起点 < 1.0 才能验证 bump 让 heat 增加(钳位上限 1.0)。
    const node = seedNode(db, { content: 'heat bump test', heat: 0.5 });

    await recall(repo, { node_id: node.id });

    const after = getNode(db, node.id);
    expect(after!.heat).toBeCloseTo(0.6, 5);
  });

  it('should bump heat on all returned nodes', async () => {
    const n1 = seedNode(db, { content: 'node A', heat: 0.5 });
    const n2 = seedNode(db, { content: 'node B', heat: 0.4 });
    vi.mocked(searchHybrid).mockResolvedValueOnce([
      { node: n1, score: 0.9, source: 'hybrid' },
      { node: n2, score: 0.8, source: 'hybrid' },
    ]);

    await recall(repo, { query: 'test' });

    const a1 = getNode(db, n1.id);
    const a2 = getNode(db, n2.id);
    // P1-1: heat bump 按排名衰减,第 1 名 +0.1,第 2 名 +0.05
    expect(a1!.heat).toBeCloseTo(0.6, 5);
    expect(a2!.heat).toBeCloseTo(0.45, 5);
  });
});

// ===== reconsolidation =====

describe('recall - reconsolidation', () => {
  it('should call reconsolidateOnRecall with returned nodes', async () => {
    const node = seedNode(db, { content: 'reconsolidate test' });

    await recall(repo, { node_id: node.id });

    expect(reconsolidateOnRecall).toHaveBeenCalledWith(
      db,
      expect.arrayContaining([expect.objectContaining({ id: node.id })]),
      undefined, // no context
      undefined, // no avgSearchScore (node_id mode)
    );
  });

  it('should pass context to reconsolidateOnRecall', async () => {
    const node = seedNode(db, { content: 'context reconsolidate' });

    await recall(repo, { node_id: node.id, context: 'user is debugging' });

    expect(reconsolidateOnRecall).toHaveBeenCalledWith(
      db,
      expect.any(Array),
      'user is debugging',
      undefined, // no avgSearchScore (node_id mode)
    );
  });
});

// ===== meta node 过滤 =====

describe('recall - meta node filtering', () => {
  it('should pass excludeMeta to searchHybrid for query mode', async () => {
    const factNode = seedNode(db, { type: 'fact', content: 'visible fact' });
    vi.mocked(searchHybrid).mockResolvedValueOnce([
      { node: factNode, score: 0.9, source: 'hybrid' },
    ]);

    await recall(repo, { query: 'test' });

    expect(searchHybrid).toHaveBeenCalledWith(
      repo, 'test',
      expect.objectContaining({ excludeMeta: true }),
    );
  });

  it('should not exclude meta when type=meta is explicitly requested', async () => {
    const metaNode = seedNode(db, { type: 'meta', content: 'visible meta' });
    vi.mocked(searchHybrid).mockResolvedValueOnce([
      { node: metaNode, score: 0.9, source: 'hybrid' },
    ]);

    const result = await recall(repo, { query: 'test', type: 'meta' });

    expect(searchHybrid).toHaveBeenCalledWith(
      repo, 'test',
      expect.objectContaining({ excludeMeta: false }),
    );
    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].type).toBe('meta');
  });

  it('should filter meta nodes from source_file results', async () => {
    seedNode(db, { type: 'fact', content: 'source fact' });
    seedNode(db, { type: 'meta', content: 'source meta' });
    db.prepare("UPDATE nodes SET source_stream = 'stream:test.ts' WHERE content LIKE 'source%'").run();

    const result = await recall(repo, { source_file: 'stream:test.ts' });

    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.nodes.every(n => n.type !== 'meta')).toBe(true);
  });
});

// ===== source_file 模式 =====

describe('recall - source_file mode', () => {
  it('should find nodes by exact source_stream match', async () => {
    // source_file 现在是精确匹配 (不再是子串)，避免 '.md' 匹配所有 markdown
    seedNode(db, { content: 'source file node' });
    db.prepare("UPDATE nodes SET source_stream = 'stream:2026:main.ts:1' WHERE content = 'source file node'").run();

    const result = await recall(repo, { source_file: 'stream:2026:main.ts:1' });

    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].content).toBe('source file node');
  });

  it('should return empty when no matching source_file', async () => {
    const result = await recall(repo, { source_file: 'nonexistent.ts' });

    expect(result.nodes).toHaveLength(0);
  });
});

// ===== index_ref 模式 =====

describe('recall - index_ref mode', () => {
  it('should handle project: ref type (treated as tag)', async () => {
    // project:xxx 现在等价于 tag:xxx，按 tags JSON 字段过滤
    seedNode(db, { content: 'tagged node A', tags: ['my-app'] });
    seedNode(db, { content: 'tagged node B', tags: ['my-app'] });
    seedNode(db, { content: 'other tag', tags: ['other'] });

    const result = await recall(repo, { index_ref: 'project:my-app' });

    expect(result.nodes.length).toBe(2);
  });

  it('should handle node: ref type', async () => {
    const node = seedNode(db, { content: 'specific ref node' });

    const result = await recall(repo, { index_ref: `node:${node.id}` });

    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].id).toBe(node.id);
  });

  it('should return empty for invalid index_ref format', async () => {
    const result = await recall(repo, { index_ref: 'invalid' });

    expect(result.nodes).toHaveLength(0);
  });
});

// ===== from_node 模式 =====

describe('recall - from_node mode', () => {
  it('should call expandFromNode with correct parameters', async () => {
    const node = seedNode(db, { content: 'start node' });
    vi.mocked(expandFromNode).mockReturnValueOnce([]);

    await recall(repo, { from_node: node.id, depth: 2, limit: 5 });

    expect(expandFromNode).toHaveBeenCalledWith(
      db,
      node.id,
      expect.objectContaining({
        depth: 2,
        maxNodes: 5,
        minStrength: 0.3,
      }),
    );
  });

  it('should filter by relation type when specified', async () => {
    const start = seedNode(db, { content: 'start' });
    const related = seedNode(db, { content: 'related node' });
    const unrelated = seedNode(db, { content: 'unrelated node' });

    seedLink(db, start.id, related.id, { relation: 'supports' });
    seedLink(db, start.id, unrelated.id, { relation: 'contradicts' });

    vi.mocked(expandFromNode).mockReturnValueOnce([
      getNode(db, related.id)!,
      getNode(db, unrelated.id)!,
    ]);

    const result = await recall(repo, {
      from_node: start.id,
      relation: 'supports',
    });

    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].content).toBe('related node');
  });
});

// ===== 默认模式 =====

describe('recall - default mode', () => {
  it('should return recent active nodes when no query params', async () => {
    seedNode(db, { content: 'active node 1', heat: 0.9 });
    seedNode(db, { content: 'active node 2', heat: 0.5 });

    const result = await recall(repo, {});

    expect(result.nodes.length).toBe(2);
  });
});

// ===== operation log =====

describe('recall - operation log', () => {
  it('should log recall operation', async () => {
    const node = seedNode(db, { content: 'log test' });
    await recall(repo, { node_id: node.id });

    const ops = db.prepare("SELECT * FROM operation_log WHERE operation = 'recall'").all() as Array<{ operation: string; input_summary: string }>;
    expect(ops.length).toBe(1);
  });

  it('should record strategy feedback', async () => {
    await recall(repo, { query: 'test' });

    const feedback = db.prepare(
      "SELECT * FROM strategy_feedback WHERE strategy_name = 'recall-search'",
    ).all() as Array<{ strategy_name: string; feedback_signal: number }>;
    expect(feedback.length).toBe(1);
  });
});

// ===== links in response =====

describe('recall - response format', () => {
  it('should include links for returned nodes', async () => {
    const n1 = seedNode(db, { content: 'node with link' });
    const n2 = seedNode(db, { content: 'linked target' });
    seedLink(db, n1.id, n2.id, { relation: [{ type: 'supports', confidence: 0.7 }], strength: 0.8 });

    const result = await recall(repo, { node_id: n1.id });

    expect(result.nodes[0].links.length).toBe(1);
    expect(result.nodes[0].links[0].relation).toEqual([{ type: 'supports', confidence: 0.7 }]);
    expect(result.nodes[0].links[0].to_id).toBe(n2.id);
  });

  it('should include tags when present', async () => {
    const node = seedNode(db, { content: 'tagged node', tags: ['alpha', 'beta'] });

    const result = await recall(repo, { node_id: node.id });

    expect(result.nodes[0].tags).toEqual(['alpha', 'beta']);
  });

  it('should include tags when present (project field removed)', async () => {
    const node = seedNode(db, { content: 'tagged node', tags: ['my-proj'] });

    const result = await recall(repo, { node_id: node.id });

    // project 字段已移除，数据通过 tags 传递
    expect(result.nodes[0].tags).toContain('my-proj');
  });

  it('should default to detail mode and include mode field in output', async () => {
    const node = seedNode(db, { content: 'test' });
    const result = await recall(repo, { node_id: node.id });
    expect(result.mode).toBe('detail');
    // detail 模式包含完整 content
    expect((result.nodes[0] as any).content).toBe('test');
  });

  it('should skip orphan links (dangling to_id)', async () => {
    const node = seedNode(db, { content: 'with orphan link' });
    // 手动插入一条指向不存在节点的链接（绕过 FK，用 INSERT OR IGNORE 配合已存在的有效节点先删）
    // 方法：插入链接指向一个有效 target，然后暂时关闭 FK 检查删除 target
    const target = seedNode(db, { content: 'target to delete' });
    seedLink(db, node.id, target.id, { relation: [{ type: 'supports', confidence: 0.7 }] });

    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM nodes WHERE id = ?').run(target.id);
    db.pragma('foreign_keys = ON');

    const result = await recall(repo, { node_id: node.id });

    // 悬空链接应被过滤
    expect((result.nodes[0] as any).links).toEqual([]);
  });

  it('detail mode link should include to_type instead of to_content_preview', async () => {
    const n1 = seedNode(db, { content: 'source', type: 'fact' });
    const n2 = seedNode(db, { content: 'target', type: 'idea' });
    seedLink(db, n1.id, n2.id, { relation: [{ type: 'supports', confidence: 0.7 }] });

    const result = await recall(repo, { node_id: n1.id });

    const link = (result.nodes[0] as any).links[0];
    expect(link.to_type).toBe('idea');
    expect(link.to_content_preview).toBeUndefined();
  });
});

// ===== index 模式 =====

describe('recall - index mode', () => {
  it('should return lightweight index items in index mode', async () => {
    const node = seedNode(db, {
      content: 'detailed content that should be truncated to snippet',
      tags: ['alpha'],
      heat: 0.8,
    });

    const result = await recall(repo, { node_id: node.id, mode: 'index' });

    expect(result.mode).toBe('index');
    expect(result.nodes.length).toBe(1);
    const item = result.nodes[0] as any;
    expect(item.id).toBe(node.id);
    expect(item.type).toBe('fact');
    expect(item.snippet).toContain('detailed content');
    expect(item.tags).toEqual(['alpha']);
    // Index mode should not include content/maturity/links
    expect(item.content).toBeUndefined();
    expect(item.maturity).toBeUndefined();
    expect(item.links).toBeUndefined();
  });

  it('should truncate snippet to configured length', async () => {
    const longContent = 'a'.repeat(200);
    const node = seedNode(db, { content: longContent });

    const result = await recall(repo, { node_id: node.id, mode: 'index' });

    const item = result.nodes[0] as any;
    // 默认 snippet 长度 80
    expect(item.snippet.length).toBeLessThanOrEqual(80);
  });

  it('should normalize newlines to spaces in snippet', async () => {
    const node = seedNode(db, { content: 'line 1\nline 2\nline 3' });

    const result = await recall(repo, { node_id: node.id, mode: 'index' });

    const item = result.nodes[0] as any;
    expect(item.snippet).not.toContain('\n');
    expect(item.snippet).toContain('line 1');
  });

  it('should use index_max_results as default limit in index mode', async () => {
    vi.mocked(searchHybrid).mockResolvedValueOnce([]);

    await recall(repo, { query: 'test', mode: 'index' });

    // 索引模式默认 limit 为 30（从 getParam fallback）
    expect(searchHybrid).toHaveBeenCalledWith(
      repo,
      'test',
      expect.objectContaining({ limit: 30 }),
    );
  });

  it('should use detail_max_results as default limit in detail mode', async () => {
    vi.mocked(searchHybrid).mockResolvedValueOnce([]);

    await recall(repo, { query: 'test' });

    // 详情模式默认 limit 为 8
    expect(searchHybrid).toHaveBeenCalledWith(
      repo,
      'test',
      expect.objectContaining({ limit: 8 }),
    );
  });

  it('should respect explicit limit over mode default', async () => {
    vi.mocked(searchHybrid).mockResolvedValueOnce([]);

    await recall(repo, { query: 'test', mode: 'index', limit: 10 });

    expect(searchHybrid).toHaveBeenCalledWith(
      repo,
      'test',
      expect.objectContaining({ limit: 10 }),
    );
  });

  it('should still bump heat in index mode', async () => {
    const node = seedNode(db, { content: 'index heat test', heat: 0.5 });

    await recall(repo, { node_id: node.id, mode: 'index' });

    const after = getNode(db, node.id);
    expect(after!.heat).toBeCloseTo(0.6, 5);
  });
});
