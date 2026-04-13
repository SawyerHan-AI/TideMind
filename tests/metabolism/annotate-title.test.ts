/**
 * annotate 策略 — title 提取测试
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
    gates: {},
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
import { runAnnotation } from '../../src/metabolism/annotate.js';
import { callLLM } from '../../src/llm/client.js';
import { getNode } from '../../src/db/nodes.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
  vi.clearAllMocks();
});

describe('annotate title extraction', () => {
  it('LLM 返回 title 时写入无 title 的节点', async () => {
    const node = seedNode(db, { content: 'React 虚拟 DOM 的工作原理和优化策略', refinement: 0.0 });
    expect(node.title).toBeNull();

    vi.mocked(callLLM).mockResolvedValueOnce(
      JSON.stringify([{
        index: 1,
        specificity: 0.3,
        subjectivity: 0.1,
        actuality: 0.9,
        tags: ['React'],
        title: 'React 虚拟 DOM 原理',
      }]),
    );

    await runAnnotation(db);

    const updated = getNode(db, node.id)!;
    expect(updated.title).toBe('React 虚拟 DOM 原理');
    expect(updated.refinement).toBeCloseTo(0.1);
  });

  it('已有 title 的节点不被 LLM 返回的 title 覆盖', async () => {
    const node = seedNode(db, {
      content: '项目选用 SQLite 作为存储方案',
      title: '用户自定义标题',
      refinement: 0.0,
    });

    vi.mocked(callLLM).mockResolvedValueOnce(
      JSON.stringify([{
        index: 1,
        specificity: 0.5,
        subjectivity: 0.2,
        actuality: 0.9,
        tags: ['SQLite'],
        title: 'LLM 生成的标题',
      }]),
    );

    await runAnnotation(db);

    const updated = getNode(db, node.id)!;
    expect(updated.title).toBe('用户自定义标题'); // 保持原 title 不变
  });

  it('LLM 未返回 title 字段时不影响节点', async () => {
    const node = seedNode(db, { content: 'some content', refinement: 0.0 });

    vi.mocked(callLLM).mockResolvedValueOnce(
      JSON.stringify([{
        index: 1,
        specificity: 0.5,
        subjectivity: 0.5,
        actuality: 0.5,
        tags: [],
      }]),
    );

    await runAnnotation(db);

    const updated = getNode(db, node.id)!;
    expect(updated.title).toBeNull();
    expect(updated.refinement).toBeCloseTo(0.1);
  });

  it('LLM 返回空字符串 title 时不写入', async () => {
    const node = seedNode(db, { content: 'test content', refinement: 0.0 });

    vi.mocked(callLLM).mockResolvedValueOnce(
      JSON.stringify([{
        index: 1,
        specificity: 0.5,
        subjectivity: 0.5,
        actuality: 0.5,
        tags: [],
        title: '',
      }]),
    );

    await runAnnotation(db);

    const updated = getNode(db, node.id)!;
    expect(updated.title).toBeNull();
  });

  it('批量标注中混合有/无 title 的节点正确处理', async () => {
    const nodeWithTitle = seedNode(db, {
      content: 'has title already',
      title: '已有标题',
      refinement: 0.0,
    });
    const nodeWithoutTitle = seedNode(db, {
      content: 'needs a title',
      refinement: 0.0,
    });

    vi.mocked(callLLM).mockResolvedValueOnce(
      JSON.stringify([
        { index: 1, specificity: 0.5, subjectivity: 0.5, actuality: 0.5, tags: [], title: '不应写入' },
        { index: 2, specificity: 0.5, subjectivity: 0.5, actuality: 0.5, tags: [], title: '新生成标题' },
      ]),
    );

    await runAnnotation(db);

    expect(getNode(db, nodeWithTitle.id)!.title).toBe('已有标题');
    expect(getNode(db, nodeWithoutTitle.id)!.title).toBe('新生成标题');
  });
});
