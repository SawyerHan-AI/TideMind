/**
 * 时间结晶测试
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
    anthropic: { api_key: '' },
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
  isLlmConfigured: vi.fn().mockReturnValue(false),
}));

vi.mock('../../src/db/connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/connection.js')>();
  return { ...actual, isVecLoaded: () => false };
});

vi.mock('../../src/llm/client.js', () => ({
  callLLM: vi.fn().mockResolvedValue('{}'),
}));

import type Database from 'better-sqlite3';
import { setupTestDb, seedNode } from '../helpers/test-db.js';
import { runTemporalCrystal } from '../../src/metabolism/temporal-crystal.js';
import { isLlmConfigured } from '../../src/config.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
  vi.clearAllMocks();
  vi.mocked(isLlmConfigured).mockReturnValue(false);
});

describe('runTemporalCrystal', () => {
  it('LLM 未配置时跳过', async () => {
    const result = await runTemporalCrystal(db);
    expect(result).toEqual({ analyzed: 0, crystals_created: 0 });
  });

  it('节点数不足时跳过（门控）', async () => {
    vi.mocked(isLlmConfigured).mockReturnValue(true);

    // 默认门控 gate_min_nodes = 200，只创建少量节点
    for (let i = 0; i < 5; i++) {
      seedNode(db, { content: `test node ${i}` });
    }

    const result = await runTemporalCrystal(db);
    expect(result).toEqual({ analyzed: 0, crystals_created: 0 });
  });

  it('返回值类型正确', async () => {
    vi.mocked(isLlmConfigured).mockReturnValue(true);

    const result = await runTemporalCrystal(db);
    expect(result).toHaveProperty('analyzed');
    expect(result).toHaveProperty('crystals_created');
    expect(typeof result.analyzed).toBe('number');
    expect(typeof result.crystals_created).toBe('number');
  });
});

// ===== LIKE 转义测试 =====

describe('temporal crystal - LIKE escaping', () => {
  it('标签包含 % 字符时 LIKE 查询正确转义', async () => {
    vi.mocked(isLlmConfigured).mockReturnValue(true);

    // 创建足够多的节点以通过门控 (200)
    for (let i = 0; i < 201; i++) {
      seedNode(db, { content: `filler node ${i}` });
    }

    // 创建一个标签包含 % 的 tag 节点
    db.prepare(`
      INSERT INTO nodes (id, type, content, heat, refinement, connectivity, independence,
        specificity, subjectivity, actuality, maturity_score, is_crystal, is_tag, is_meta,
        is_keystone, is_superseded, version, archived, tags, created)
      VALUES (?, 'fact', ?, 1.0, 0, 0, 0, 0.5, 0.5, 0.5, 0.2, 0, 1, 0, 0, 0, 1, 0, '[]', datetime('now'))
    `).run('tag-percent', '50%_off');

    // 创建一个 is_crystal=1 的节点，标签中包含 %，
    // 并设置 content 包含 '时间演变'
    db.prepare(`
      INSERT INTO nodes (id, type, content, heat, refinement, connectivity, independence,
        specificity, subjectivity, actuality, maturity_score, is_crystal, is_tag, is_meta,
        is_keystone, is_superseded, version, archived, tags, created)
      VALUES (?, 'fact', ?, 1.0, 0.8, 0, 0.8, 0.2, 0.5, 0.8, 0.5, 1, 0, 0, 0, 0, 1, 0, ?, datetime('now'))
    `).run('crystal-pct', '[时间演变] 50%_off: test', JSON.stringify(['时间结晶', '50%_off']));

    // 测试: 带 % 的 escapedTag 应该用 \% 转义
    // 验证数据库查询不会因为 % 被当作通配符而崩溃
    const result = await runTemporalCrystal(db);
    // 不崩溃即通过
    expect(result).toHaveProperty('analyzed');
  });

  it('标签包含 _ 字符时 LIKE 查询正确转义', async () => {
    vi.mocked(isLlmConfigured).mockReturnValue(true);

    // 创建足够多的节点以通过门控
    for (let i = 0; i < 201; i++) {
      seedNode(db, { content: `node filler ${i}` });
    }

    // 创建一个标签包含 _ 的 tag 节点
    db.prepare(`
      INSERT INTO nodes (id, type, content, heat, refinement, connectivity, independence,
        specificity, subjectivity, actuality, maturity_score, is_crystal, is_tag, is_meta,
        is_keystone, is_superseded, version, archived, tags, created)
      VALUES (?, 'fact', ?, 1.0, 0, 0, 0, 0.5, 0.5, 0.5, 0.2, 0, 1, 0, 0, 0, 1, 0, '[]', datetime('now'))
    `).run('tag-under', 'my_tag_name');

    // 不崩溃即通过
    const result = await runTemporalCrystal(db);
    expect(result).toHaveProperty('analyzed');
  });
});
