/**
 * Layer 1 节点标注测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, _param: string, fallback: number) => fallback,
  getPrompt: () => '',
  getLLMOptions: () => ({}),
  loadStrategies: () => {},
  getStrategy: () => null,
  renderUserPrompt: (_strategy: string, _vars: any, fallback: string) => fallback,
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
      vector_search: 50, graph_expansion: 20, graph_expansion_links: 10,
      crystal_generation: 100, divergent_scan: 200,
      learning_2_min_nodes: 30, learning_2_min_recall_ops: 10,
    },
    sources: {},
  }),
  getDataDir: () => '/tmp/test-eb',
  isLlmConfigured: () => true,
}));

vi.mock('../../src/db/connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/connection.js')>();
  return { ...actual, isVecLoaded: () => false };
});

vi.mock('../../src/llm/client.js', () => ({
  callLLM: vi.fn().mockResolvedValue('[]'),
}));

import type Database from 'better-sqlite3';
import { setupTestDb, seedNode } from '../helpers/test-db.js';
import { findUnannotatedNodes, getFrequentTags, runAnnotation } from '../../src/metabolism/annotate.js';
import { callLLM } from '../../src/llm/client.js';
import { getNode } from '../../src/db/nodes.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
  vi.clearAllMocks();
});

// ===== findUnannotatedNodes =====

describe('findUnannotatedNodes', () => {
  it('should find nodes with refinement === 0', () => {
    seedNode(db, { content: 'unannotated node', refinement: 0.0 });
    seedNode(db, { content: 'annotated node', refinement: 0.1 });

    const result = findUnannotatedNodes(db, 10);
    expect(result.length).toBe(1);
    expect(result[0].content).toBe('unannotated node');
  });

  it('should exclude crystal and meta types', () => {
    seedNode(db, { content: 'regular node', type: 'fact', refinement: 0.0 });
    seedNode(db, { content: 'crystal node', type: 'crystal', refinement: 0.0 });
    seedNode(db, { content: 'meta node', type: 'meta', refinement: 0.0 });

    const result = findUnannotatedNodes(db, 10);
    expect(result.length).toBe(1);
    expect(result[0].content).toBe('regular node');
  });

  it('should exclude archived nodes', () => {
    const node = seedNode(db, { content: 'archived', refinement: 0.0 });
    db.prepare('UPDATE nodes SET heat = 0.005 WHERE id = ?').run(node.id);

    const result = findUnannotatedNodes(db, 10);
    expect(result.length).toBe(0);
  });

  it('should respect limit', () => {
    for (let i = 0; i < 5; i++) {
      seedNode(db, { content: `node ${i}`, refinement: 0.0 });
    }

    const result = findUnannotatedNodes(db, 3);
    expect(result.length).toBe(3);
  });
});

// ===== getFrequentTags =====

describe('getFrequentTags', () => {
  it('should return empty array when no tags exist', () => {
    seedNode(db, { content: 'no tags' });
    const tags = getFrequentTags(db, 10);
    expect(tags).toEqual([]);
  });

  it('should aggregate and sort tags by frequency', () => {
    seedNode(db, { content: 'node1', tags: ['AI', 'architecture'] });
    seedNode(db, { content: 'node2', tags: ['AI', 'design'] });
    seedNode(db, { content: 'node3', tags: ['AI'] });

    const tags = getFrequentTags(db, 10);
    expect(tags[0]).toBe('AI'); // most frequent
    expect(tags.length).toBe(3);
  });

  it('should respect limit', () => {
    seedNode(db, { content: 'node1', tags: ['a', 'b', 'c', 'd', 'e'] });
    const tags = getFrequentTags(db, 2);
    expect(tags.length).toBe(2);
  });
});

// ===== runAnnotation =====

describe('runAnnotation', () => {
  it('should skip when no unannotated nodes exist', async () => {
    seedNode(db, { content: 'already annotated', refinement: 0.1 });

    const result = await runAnnotation(db);
    expect(result.annotated).toBe(0);
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('should call LLM and update nodes when unannotated nodes exist', async () => {
    seedNode(db, { content: 'new fact about databases', refinement: 0.0 });

    vi.mocked(callLLM).mockResolvedValueOnce(
      JSON.stringify([{ type: 'fact', tags: ['database'], project: 'MyProject' }]),
    );

    const result = await runAnnotation(db);
    expect(result.annotated).toBe(1);
    expect(callLLM).toHaveBeenCalledOnce();
  });

  it('should merge existing tags with LLM-suggested tags', async () => {
    const node = seedNode(db, {
      content: 'node with existing tags',
      tags: ['existing-tag'],
      refinement: 0.0,
    });

    vi.mocked(callLLM).mockResolvedValueOnce(
      JSON.stringify([{ type: 'fact', tags: ['new-tag', 'existing-tag'] }]),
    );

    await runAnnotation(db);

    const updated = getNode(db, node.id);
    const tags = JSON.parse(updated!.tags!);
    expect(tags).toContain('existing-tag');
    expect(tags).toContain('new-tag');
    // no duplicates
    expect(tags.filter((t: string) => t === 'existing-tag').length).toBe(1);
  });

  it('should set refinement to 0.1 after annotation', async () => {
    const node = seedNode(db, { content: 'to be annotated', refinement: 0.0 });

    vi.mocked(callLLM).mockResolvedValueOnce(
      JSON.stringify([{ type: 'idea', tags: [] }]),
    );

    await runAnnotation(db);

    const updated = getNode(db, node.id);
    expect(updated!.refinement).toBeCloseTo(0.1);
  });

  it('should handle LLM failure gracefully', async () => {
    seedNode(db, { content: 'will fail annotation', refinement: 0.0 });

    vi.mocked(callLLM).mockRejectedValueOnce(new Error('LLM timeout'));

    const result = await runAnnotation(db);
    expect(result.annotated).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('should handle malformed LLM response gracefully', async () => {
    seedNode(db, { content: 'malformed response test', refinement: 0.0 });

    vi.mocked(callLLM).mockResolvedValueOnce('not valid json at all');

    const result = await runAnnotation(db);
    expect(result.annotated).toBe(0);
  });
});
