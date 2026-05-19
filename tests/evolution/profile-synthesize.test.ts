/**
 * 画像凝练（profile-synthesize）测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mocks（必须在 import 之前） ----
vi.mock('../../src/strategy/loader.js', () => {
  let params: Record<string, unknown> = {};
  return {
    getParam: (_strategy: string, param: string, fallback: unknown) =>
      params[param] !== undefined ? params[param] : fallback,
    getPrompt: (_s: string, fallback: string) => fallback,
    getLLMOptions: () => ({ model: 'standard' }),
    renderUserPrompt: (_s: string, vars: Record<string, string>, fallback: string) => {
      // 简单拼接所有 vars 模拟渲染
      return Object.values(vars).filter(Boolean).join('\n\n') || fallback;
    },
    loadStrategies: () => {},
    getStrategy: () => null,
    __setParams: (p: Record<string, unknown>) => { params = p; },
  };
});

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
  callLLM: vi.fn(),
}));

import type Database from 'better-sqlite3';
import { setupTestDb, seedNode, seedLink } from '../helpers/test-db.js';
import { runProfileSynthesize } from '../../src/evolution/profile-synthesize.js';
import { callLLM } from '../../src/llm/client.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
  vi.clearAllMocks();
  vi.mocked(callLLM).mockResolvedValue(JSON.stringify({
    profile_text: '用户是一个开发者，偏好简洁的代码风格。',
    structured: { role: 'developer' },
  }));
});

/** 查当前有效画像节点 */
function getProfileNode(db: Database.Database) {
  return db.prepare(
    "SELECT * FROM nodes WHERE type = 'meta' AND title = 'user-profile' AND is_superseded = 0 ORDER BY created DESC LIMIT 1",
  ).get() as { id: string; content: string; type: string; is_superseded: number } | undefined;
}

describe('profile-synthesize - 触发条件', () => {
  it('首次生成：无历史画像时必须跑', async () => {
    seedNode(db, { type: 'crystal', content: 'user likes simplicity' });

    await runProfileSynthesize(db);

    expect(callLLM).toHaveBeenCalledTimes(1);
    const profile = getProfileNode(db);
    expect(profile).toBeDefined();
    expect(profile!.content).toContain('开发者');
  });

  it('已有画像但未满足触发条件：跳过', async () => {
    // 先创建一个已有的画像节点
    db.prepare(`
      INSERT INTO nodes (id, type, content, title, heat, refinement, connectivity, independence, maturity_score, is_meta, created)
      VALUES ('prof-old', 'meta', '旧画像', 'user-profile', 1.0, 0, 0, 0, 0.2, 1, datetime('now'))
    `).run();

    // 没有新增结晶或 preference
    await runProfileSynthesize(db);

    expect(callLLM).not.toHaveBeenCalled();
  });

  it('新增 ≥3 条结晶：触发更新', async () => {
    // 旧画像
    db.prepare(`
      INSERT INTO nodes (id, type, content, title, heat, refinement, connectivity, independence, maturity_score, is_meta, created)
      VALUES ('prof-old', 'meta', '旧画像', 'user-profile', 1.0, 0, 0, 0, 0.2, 1, datetime('now', '-1 hour'))
    `).run();

    // 3 条新结晶（创建时间晚于旧画像）
    seedNode(db, { type: 'crystal', content: 'crystal 1' });
    seedNode(db, { type: 'crystal', content: 'crystal 2' });
    seedNode(db, { type: 'crystal', content: 'crystal 3' });

    await runProfileSynthesize(db);

    expect(callLLM).toHaveBeenCalledTimes(1);
  });

  it('新增 ≥4 条 preference：触发更新', async () => {
    db.prepare(`
      INSERT INTO nodes (id, type, content, title, heat, refinement, connectivity, independence, maturity_score, is_meta, created)
      VALUES ('prof-old', 'meta', '旧画像', 'user-profile', 1.0, 0, 0, 0, 0.2, 1, datetime('now', '-1 hour'))
    `).run();

    for (let i = 0; i < 4; i++) {
      seedNode(db, { type: 'preference', content: `pref ${i}` });
    }

    await runProfileSynthesize(db);

    expect(callLLM).toHaveBeenCalledTimes(1);
  });

  it('兜底：超过 max_days 强制触发', async () => {
    // 10 天前的画像
    db.prepare(`
      INSERT INTO nodes (id, type, content, title, heat, refinement, connectivity, independence, maturity_score, is_meta, created)
      VALUES ('prof-old', 'meta', '旧画像', 'user-profile', 1.0, 0, 0, 0, 0.2, 1, datetime('now', '-10 days'))
    `).run();

    // 没有新增内容
    await runProfileSynthesize(db);

    expect(callLLM).toHaveBeenCalledTimes(1);
  });
});

describe('profile-synthesize - 存储', () => {
  it('新画像 supersede 旧画像', async () => {
    // 旧画像
    db.prepare(`
      INSERT INTO nodes (id, type, content, title, heat, refinement, connectivity, independence, maturity_score, is_meta, created)
      VALUES ('prof-old', 'meta', '旧画像', 'user-profile', 1.0, 0, 0, 0, 0.2, 1, datetime('now', '-10 days'))
    `).run();

    await runProfileSynthesize(db);

    // 旧节点被标记为 superseded
    const old = db.prepare("SELECT is_superseded FROM nodes WHERE id = 'prof-old'").get() as { is_superseded: number };
    expect(old.is_superseded).toBe(1);

    // 存在新的活跃画像节点
    const current = getProfileNode(db);
    expect(current).toBeDefined();
    expect(current!.id).not.toBe('prof-old');
  });

  it('content 包含 profile_text 和 structured JSON', async () => {
    seedNode(db, { type: 'crystal', content: 'user likes tdd' });

    await runProfileSynthesize(db);

    const profile = getProfileNode(db);
    expect(profile!.content).toContain('开发者');
    expect(profile!.content).toContain('developer');
    expect(profile!.content).toContain('```json');
  });

  it('旧节点的 updates 链接指向新节点', async () => {
    db.prepare(`
      INSERT INTO nodes (id, type, content, title, heat, refinement, connectivity, independence, maturity_score, is_meta, created)
      VALUES ('prof-old', 'meta', '旧画像', 'user-profile', 1.0, 0, 0, 0, 0.2, 1, datetime('now', '-10 days'))
    `).run();

    await runProfileSynthesize(db);

    const updatesLink = db.prepare(
      "SELECT to_id FROM links WHERE from_id = 'prof-old' AND relation LIKE '%updates%'",
    ).get() as { to_id: string } | undefined;
    expect(updatesLink).toBeDefined();

    const newProfile = getProfileNode(db);
    expect(updatesLink!.to_id).toBe(newProfile!.id);
  });
});

describe('profile-synthesize - preference 去重', () => {
  it('与 crystal 有链接的 preference 不出现在 LLM 输入中', async () => {
    const crystal = seedNode(db, { type: 'crystal', content: 'user prefers concise code' });
    const prefLinked = seedNode(db, { type: 'preference', content: 'prefer concise', heat: 0.7 });
    const prefFree = seedNode(db, { type: 'preference', content: 'likes dark theme', heat: 0.7 });

    // 链接 crystal 和 prefLinked
    seedLink(db, crystal.id, prefLinked.id, { relation: [{ type: 'supports', confidence: 0.8 }] });

    await runProfileSynthesize(db);

    // 检查 LLM 调用的 prompt 参数
    const call = vi.mocked(callLLM).mock.calls[0][0] as { prompt: string };
    expect(call.prompt).toContain('likes dark theme'); // 未链接的保留
    expect(call.prompt).not.toContain('prefer concise'); // 已被 crystal 链接的被去重
  });
});

describe('profile-synthesize - 错误处理', () => {
  it('LLM 无响应时不创建节点', async () => {
    vi.mocked(callLLM).mockResolvedValueOnce('');
    seedNode(db, { type: 'crystal', content: 'some crystal' });

    await runProfileSynthesize(db);

    const profile = getProfileNode(db);
    expect(profile).toBeUndefined();
  });

  it('LLM 返回非 JSON 时退化为纯文本画像', async () => {
    vi.mocked(callLLM).mockResolvedValueOnce('这是一段纯文本画像');
    seedNode(db, { type: 'crystal', content: 'some crystal' });

    await runProfileSynthesize(db);

    const profile = getProfileNode(db);
    expect(profile).toBeDefined();
    expect(profile!.content).toContain('纯文本画像');
  });
});

describe('profile-synthesize - 时间线记录', () => {
  it('生成后记录 timeline 事件', async () => {
    seedNode(db, { type: 'crystal', content: 'crystal' });

    await runProfileSynthesize(db);

    const events = db.prepare(
      "SELECT * FROM timeline_events WHERE subtype = 'profile_synthesize'",
    ).all();
    expect(events.length).toBe(1);
  });
});
