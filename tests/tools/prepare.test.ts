/**
 * prepare tool 集成测试
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
    general: { data_dir: '/tmp/test-eb', user_name: 'TestUser' },
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

vi.mock('../../src/db/connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/connection.js')>();
  return { ...actual, isVecLoaded: () => false };
});

vi.mock('../../src/metabolism/scheduler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/metabolism/scheduler.js')>();
  return { ...actual, maybeRunMaintenance: vi.fn() };
});

vi.mock('../../src/llm/client.js', () => ({
  callLLM: vi.fn().mockResolvedValue('LLM summary'),
}));

import type Database from 'better-sqlite3';
import { setupTestDb, seedNode, seedLink } from '../helpers/test-db.js';
import { prepare } from '../../src/tools/prepare.js';
import { maybeRunMaintenance } from '../../src/metabolism/scheduler.js';
import { invalidateGateCache } from '../../src/db/stats.js';
import { SqliteRepository } from '../../src/db/sqlite-repository.js';

let db: Database.Database;
let repo: InstanceType<typeof SqliteRepository>;

beforeEach(() => {
  db = setupTestDb();
  repo = new SqliteRepository(db);
  invalidateGateCache();
  vi.clearAllMocks();
});

// ===== 空数据库 =====

describe('prepare - empty database', () => {
  it('should return profile indicating no memories', async () => {
    const result = await prepare(repo, { tool: 'cursor' });

    expect(result.profile.text).toContain('刚刚启动');
  });

  it('should return empty arrays for empty database', async () => {
    const result = await prepare(repo, { tool: 'cursor' });

    expect(result.keystones).toEqual([]);
    expect(result.tags).toEqual([]);
    expect(result.crystals.highlighted).toEqual([]);
    expect(result.crystals.others).toEqual([]);
    expect(result.recent).toEqual([]);
  });

  it('should include guidance for empty brain', async () => {
    const result = await prepare(repo, { tool: 'cursor' });

    expect(result.guidance).toContain('brain_digest');
  });
});

// ===== 有节点的数据库 =====

describe('prepare - database with nodes', () => {
  it('should show memory stats in profile when no profile node exists', async () => {
    seedNode(db, { type: 'fact', content: 'fact 1' });
    seedNode(db, { type: 'idea', content: 'idea 1' });
    seedNode(db, { type: 'fact', content: 'fact 2' });

    const result = await prepare(repo, { tool: 'cursor' });

    // 画像尚未生成时，显示基础统计
    expect(result.profile.text).toContain('3');
    expect(result.profile.text).toContain('fact');
  });

  it('should read pre-generated profile from meta node', async () => {
    db.prepare(`
      INSERT INTO nodes (id, type, content, title, heat, refinement, connectivity, independence, maturity_score, is_meta, created)
      VALUES ('prof-1', 'meta', '这是一个开发者画像', 'user-profile', 1.0, 0, 0, 0, 0.2, 1, datetime('now'))
    `).run();

    const result = await prepare(repo, { tool: 'cursor' });

    expect(result.profile.text).toBe('这是一个开发者画像');
  });

  // F3 读取侧自愈:存量污染节点(2026-06 事故)不能把 raw JSON 当画像注入
  it('污染的 raw JSON 画像节点 → 净化为干净文本,不注入 fence 全文', async () => {
    const poison = '```json\n{\n  "profile_text": "用户是星海科技的产品负责人，主导 DataPilot。",\n  "structured": {"role": "PM"}\n}\n```';
    db.prepare(`
      INSERT INTO nodes (id, type, content, title, heat, refinement, connectivity, independence, maturity_score, is_meta, created)
      VALUES ('prof-poison', 'meta', ?, 'user-profile', 1.0, 0, 0, 0, 0.2, 1, datetime('now'))
    `).run(poison);

    const result = await prepare(repo, { tool: 'cursor' });

    expect(result.profile.text).toContain('星海科技');
    expect(result.profile.text.trimStart().startsWith('```')).toBe(false);
    expect(result.profile.text).not.toContain('"profile_text"');
  });

  it('不可救污染节点 → 降级为基础统计,绝不返回 raw JSON', async () => {
    const unsalvageable = '```json\n{ "wrong_key": "无 profile_text 未转义 " 破坏", "list": ["x"] }\n```';
    db.prepare(`
      INSERT INTO nodes (id, type, content, title, heat, refinement, connectivity, independence, maturity_score, is_meta, created)
      VALUES ('prof-bad', 'meta', ?, 'user-profile', 1.0, 0, 0, 0, 0.2, 1, datetime('now'))
    `).run(unsalvageable);
    // 给点普通节点,让基础统计有内容
    seedNode(db, { type: 'fact', content: 'fact 1' });

    const result = await prepare(repo, { tool: 'cursor' });

    expect(result.profile.text.trimStart().startsWith('```')).toBe(false);
    expect(result.profile.text).not.toContain('"wrong_key"');
  });
});

// ===== 枢纽节点 =====

describe('prepare - keystones', () => {
  it('should return keystone nodes', async () => {
    db.prepare(`
      INSERT INTO nodes (id, type, content, title, heat, refinement, connectivity, independence, maturity_score, is_keystone, created)
      VALUES ('ks-1', 'fact', 'hub content', 'Hub Node', 1.0, 0, 0, 0, 0.5, 1, datetime('now'))
    `).run();

    const result = await prepare(repo, { tool: 'cursor' });

    expect(result.keystones.length).toBe(1);
    expect(result.keystones[0].title).toBe('Hub Node');
    expect(result.keystones[0].id).toBe('ks-1');
  });

  it('should include link_count in keystone entries', async () => {
    db.prepare(`
      INSERT INTO nodes (id, type, content, title, heat, refinement, connectivity, independence, maturity_score, is_keystone, created)
      VALUES ('ks-hub', 'fact', 'hub', 'Hub', 1.0, 0, 0, 0, 0.5, 1, datetime('now'))
    `).run();
    const n1 = seedNode(db, { content: 'node 1' });
    const n2 = seedNode(db, { content: 'node 2' });
    seedLink(db, 'ks-hub', n1.id, { relation: [{ type: 'supports', confidence: 0.8 }] });
    seedLink(db, 'ks-hub', n2.id, { relation: [{ type: 'supports', confidence: 0.8 }] });

    const result = await prepare(repo, { tool: 'cursor' });

    expect(result.keystones[0].link_count).toBe(2);
  });

  it('should exclude superseded keystones', async () => {
    db.prepare(`
      INSERT INTO nodes (id, type, content, title, heat, refinement, connectivity, independence, maturity_score, is_keystone, is_superseded, created)
      VALUES ('ks-old', 'fact', 'old hub', 'Old', 1.0, 0, 0, 0, 0.5, 1, 1, datetime('now'))
    `).run();

    const result = await prepare(repo, { tool: 'cursor' });

    expect(result.keystones.length).toBe(0);
  });
});

// ===== 标签索引 =====

describe('prepare - tags', () => {
  it('should include tag index entries', async () => {
    db.prepare(`
      INSERT INTO nodes (id, type, content, title, heat, refinement, connectivity, independence, maturity_score, is_tag, created)
      VALUES ('tag-alpha', 'fact', 'alpha', 'alpha', 1.0, 0, 0, 0, 0.2, 1, datetime('now'))
    `).run();

    const result = await prepare(repo, { tool: 'cursor' });

    expect(result.tags.length).toBeGreaterThanOrEqual(1);
    expect(result.tags[0].title).toBe('alpha');
    expect(result.tags[0].id).toBe('tag-alpha');
  });

  it('should use content as title fallback when title is null', async () => {
    db.prepare(`
      INSERT INTO nodes (id, type, content, title, heat, refinement, connectivity, independence, maturity_score, is_tag, created)
      VALUES ('tag-2', 'fact', 'beta', NULL, 1.0, 0, 0, 0, 0.2, 1, datetime('now'))
    `).run();

    const result = await prepare(repo, { tool: 'cursor' });

    expect(result.tags[0].title).toBe('beta');
  });

  it('should order tags by link_count DESC', async () => {
    db.prepare(`
      INSERT INTO nodes (id, type, content, title, heat, refinement, connectivity, independence, maturity_score, is_tag, created)
      VALUES ('tag-popular', 'fact', 'popular', 'popular', 1.0, 0, 0, 0, 0.2, 1, datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO nodes (id, type, content, title, heat, refinement, connectivity, independence, maturity_score, is_tag, created)
      VALUES ('tag-rare', 'fact', 'rare', 'rare', 1.0, 0, 0, 0, 0.2, 1, datetime('now'))
    `).run();
    // Popular tag gets 2 links, rare gets 0
    const n1 = seedNode(db, { content: 'n1' });
    const n2 = seedNode(db, { content: 'n2' });
    seedLink(db, 'tag-popular', n1.id, { relation: [{ type: 'tagged', confidence: 0.8 }] });
    seedLink(db, 'tag-popular', n2.id, { relation: [{ type: 'tagged', confidence: 0.8 }] });

    const result = await prepare(repo, { tool: 'cursor' });

    expect(result.tags[0].title).toBe('popular');
    expect(result.tags[0].link_count).toBe(2);
  });
});

// ===== 结晶 =====

describe('prepare - crystals', () => {
  it('should include crystal nodes with snippets in highlighted', async () => {
    seedNode(db, { type: 'crystal', content: 'user prefers concise code and TDD approach', heat: 0.9 });

    const result = await prepare(repo, { tool: 'cursor' });

    expect(result.crystals.highlighted.length).toBe(1);
    expect(result.crystals.highlighted[0].snippet).toContain('user prefers concise code');
  });

  it('should split crystals into highlighted and others', async () => {
    // Seed 10 crystals (default highlighted limit is 8)
    // heat 在 [0,1] 范围内,递减保持排序
    for (let i = 0; i < 10; i++) {
      seedNode(db, { type: 'crystal', content: `crystal insight ${i}`, heat: 1.0 - i * 0.05 });
    }

    const result = await prepare(repo, { tool: 'cursor' });

    expect(result.crystals.highlighted.length).toBe(8);
    expect(result.crystals.others.length).toBe(2);
    // Others should only have id and title, no snippet
    expect((result.crystals.others[0] as any).snippet).toBeUndefined();
  });

  it('should truncate highlighted snippet to snippet length', async () => {
    const longContent = 'crystal: ' + 'a'.repeat(200);
    seedNode(db, { type: 'crystal', content: longContent, heat: 0.9 });

    const result = await prepare(repo, { tool: 'cursor' });

    // Default crystal_snippet_length is 80
    expect(result.crystals.highlighted[0].snippet.length).toBeLessThanOrEqual(80);
  });

  it('should order crystals by heat DESC', async () => {
    // heat 在 [0,1] 范围内,保持 hot > cold 的相对大小
    seedNode(db, { type: 'crystal', content: 'cold insight', heat: 0.3 });
    seedNode(db, { type: 'crystal', content: 'hot insight', heat: 0.9 });

    const result = await prepare(repo, { tool: 'cursor' });

    expect(result.crystals.highlighted[0].snippet).toContain('hot insight');
  });

  it('should exclude superseded crystals', async () => {
    db.prepare(`
      INSERT INTO nodes (id, type, content, heat, refinement, connectivity, independence, maturity_score, is_crystal, is_superseded, created)
      VALUES ('c-old', 'crystal', 'old crystal', 1.0, 0, 0, 0, 0.2, 1, 1, datetime('now'))
    `).run();

    const result = await prepare(repo, { tool: 'cursor' });

    expect(result.crystals.highlighted.length).toBe(0);
    expect(result.crystals.others.length).toBe(0);
  });
});

// ===== profile =====

describe('prepare - profile content parsing', () => {
  it('should parse structured JSON block from profile node content', async () => {
    const content = `用户是一个开发者\n\n---\n\n\`\`\`json\n{"role":"dev","expertise":["ts"]}\n\`\`\``;
    db.prepare(`
      INSERT INTO nodes (id, type, content, title, heat, refinement, connectivity, independence, maturity_score, is_meta, created)
      VALUES ('prof', 'meta', ?, 'user-profile', 1.0, 0, 0, 0, 0.2, 1, datetime('now'))
    `).run(content);

    const result = await prepare(repo, { tool: 'cursor' });

    expect(result.profile.text).toBe('用户是一个开发者');
    expect(result.profile.structured).toEqual({ role: 'dev', expertise: ['ts'] });
  });

  it('should handle profile node without structured block', async () => {
    db.prepare(`
      INSERT INTO nodes (id, type, content, title, heat, refinement, connectivity, independence, maturity_score, is_meta, created)
      VALUES ('prof', 'meta', '只有纯文本画像', 'user-profile', 1.0, 0, 0, 0, 0.2, 1, datetime('now'))
    `).run();

    const result = await prepare(repo, { tool: 'cursor' });

    expect(result.profile.text).toBe('只有纯文本画像');
    expect(result.profile.structured).toBeUndefined();
  });

  it('should skip superseded profile nodes', async () => {
    db.prepare(`
      INSERT INTO nodes (id, type, content, title, heat, refinement, connectivity, independence, maturity_score, is_meta, is_superseded, created)
      VALUES ('old-prof', 'meta', '旧画像', 'user-profile', 1.0, 0, 0, 0, 0.2, 1, 1, datetime('now', '-1 hour'))
    `).run();
    db.prepare(`
      INSERT INTO nodes (id, type, content, title, heat, refinement, connectivity, independence, maturity_score, is_meta, created)
      VALUES ('new-prof', 'meta', '新画像', 'user-profile', 1.0, 0, 0, 0, 0.2, 1, datetime('now'))
    `).run();

    const result = await prepare(repo, { tool: 'cursor' });

    expect(result.profile.text).toBe('新画像');
  });

  it('should include generated_at timestamp', async () => {
    db.prepare(`
      INSERT INTO nodes (id, type, content, title, heat, refinement, connectivity, independence, maturity_score, is_meta, created)
      VALUES ('prof', 'meta', '画像', 'user-profile', 1.0, 0, 0, 0, 0.2, 1, datetime('now'))
    `).run();

    const result = await prepare(repo, { tool: 'cursor' });

    expect(result.profile.generated_at).toBeTruthy();
  });
});

// ===== 最近活跃 =====

describe('prepare - recent', () => {
  it('should include recently created nodes', async () => {
    seedNode(db, { content: 'just created', heat: 1.0 });

    const result = await prepare(repo, { tool: 'cursor' });

    expect(result.recent.length).toBeGreaterThan(0);
  });

  it('should exclude meta nodes from recent', async () => {
    db.prepare(`
      INSERT INTO nodes (id, type, content, title, heat, refinement, connectivity, independence, maturity_score, is_meta, created)
      VALUES ('meta-1', 'meta', 'meta content', 'user-profile', 1.0, 0, 0, 0, 0.2, 1, datetime('now'))
    `).run();
    seedNode(db, { content: 'regular node' });

    const result = await prepare(repo, { tool: 'cursor' });

    expect(result.recent.every(r => r.type !== 'meta')).toBe(true);
    expect(result.recent.length).toBe(1);
  });

  it('should exclude nodes created outside recent window', async () => {
    // 5 天前的节点（超出 48h 窗口）
    db.prepare(`
      INSERT INTO nodes (id, type, content, heat, refinement, connectivity, independence, maturity_score, created)
      VALUES ('old-1', 'fact', 'old content', 1.0, 0, 0, 0, 0.2, datetime('now', '-5 days'))
    `).run();

    const result = await prepare(repo, { tool: 'cursor' });

    expect(result.recent.find(r => r.id === 'old-1')).toBeUndefined();
  });

  it('should order by latest_activity DESC', async () => {
    db.prepare(`
      INSERT INTO nodes (id, type, content, heat, refinement, connectivity, independence, maturity_score, created)
      VALUES ('n-early', 'fact', 'early', 1.0, 0, 0, 0, 0.2, datetime('now', '-1 hours'))
    `).run();
    db.prepare(`
      INSERT INTO nodes (id, type, content, heat, refinement, connectivity, independence, maturity_score, created)
      VALUES ('n-late', 'fact', 'late', 1.0, 0, 0, 0, 0.2, datetime('now'))
    `).run();

    const result = await prepare(repo, { tool: 'cursor' });

    const lateIdx = result.recent.findIndex(r => r.id === 'n-late');
    const earlyIdx = result.recent.findIndex(r => r.id === 'n-early');
    expect(lateIdx).toBeLessThan(earlyIdx);
  });
});

// ===== guidance =====

describe('prepare - guidance', () => {
  it('should include recall guidance when nodes exist', async () => {
    seedNode(db, { content: 'existing node' });

    const result = await prepare(repo, { tool: 'cursor' });

    expect(result.guidance).toContain('brain_recall');
  });

  it('should note low memory count', async () => {
    seedNode(db, { content: 'single node' });

    const result = await prepare(repo, { tool: 'cursor' });

    expect(result.guidance).toContain('记忆较少');
  });

  it('should mention recall multi-dimensional feature (v0.2.77+)', async () => {
    seedNode(db, { content: 'existing node' });

    const result = await prepare(repo, { tool: 'cursor' });

    // PR-6 (2026-05-22)：mode 不再是核心提示词，改为强调"多维度叠加 + 永不空返"。
    // 原期望 "mode" → 新期望 "多维度" 或 "exact_matches"。
    expect(result.guidance).toMatch(/多维度|exact_matches|related_matches/);
  });
});

// ===== maintenance trigger =====

describe('prepare - maintenance', () => {
  it('should trigger maybeRunMaintenance (fire-and-forget)', async () => {
    await prepare(repo, { tool: 'cursor' });

    expect(maybeRunMaintenance).toHaveBeenCalledWith(db, expect.anything());
  });
});

// ===== operation log =====

describe('prepare - operation log', () => {
  it('should log prepare operation', async () => {
    await prepare(repo, { tool: 'vscode' });

    const ops = db.prepare("SELECT * FROM operation_log WHERE operation = 'prepare'").all() as Array<{ operation: string; input_summary: string }>;
    expect(ops.length).toBe(1);
    expect(ops[0].input_summary).toContain('vscode');
  });

  it('should record strategy feedback', async () => {
    await prepare(repo, { tool: 'cursor' });

    const feedback = db.prepare(
      "SELECT * FROM strategy_feedback WHERE strategy_name = 'prepare-assemble'",
    ).all() as Array<{ strategy_name: string; feedback_signal: number }>;
    expect(feedback.length).toBe(1);
  });
});
