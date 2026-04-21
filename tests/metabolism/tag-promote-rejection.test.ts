/**
 * tag-promote 对 rejected_by_user 链接的态度：
 *   - 不重新评估 strength
 *   - 不删除（即使 strength < minStrength）
 *   - 不覆写为 confirmed
 * rejected 链接是用户纠错的反馈痕迹，promotion 必须尊重。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, param: string, fallback: number) => {
    if (param === 'tag_promote_threshold') return 3;
    if (param === 'tag_link_min_strength') return 0.3;
    return fallback;
  },
  getPrompt: (_name: string, fallback: string) => fallback,
  getLLMOptions: () => ({}),
  loadStrategies: () => {},
  renderUserPrompt: (_name: string, _vars: Record<string, string>, fallback: string) => fallback,
}));

vi.mock('../../src/llm/client.js', () => ({
  callLLM: vi.fn().mockResolvedValue(''),
}));

vi.mock('../../src/config.js', () => ({
  getConfig: () => ({
    general: { data_dir: '/tmp/test-eb' },
    anthropic: { api_key: '' },
    vertex: { project_id: '', region: '' },
    ollama: { url: '' },
    gemini: { api_key: '' },
    llm: { provider: 'anthropic' },
    embedding: { provider: 'vertex', model: '', dimensions: 3072 },
    search: {},
    gates: {},
    metabolism: {},
  }),
  isLlmConfigured: () => false,
}));

import type Database from 'better-sqlite3';
import { setupTestDb, seedNode } from '../helpers/test-db.js';
import { promoteFrequentTags } from '../../src/metabolism/tag-promote.js';
import { createLink, updateLinkStatus, getLinksForNode } from '../../src/db/links.js';
import { createNode } from '../../src/db/nodes.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
});

describe('tag-promote — rejected_by_user 链接保护', () => {
  it('rejected tagged 链接不被重新评估 strength，也不被删除', async () => {
    // 1) 建标签节点和引用节点（≥ 阈值 3）
    const tagNode = createNode(db, { type: 'fact', title: 'architecture', content: '', is_tag: 1, heat: 1.0 });
    const n1 = seedNode(db, { tags: ['architecture'], content: 'content 1 about architecture' });
    const n2 = seedNode(db, { tags: ['architecture'], content: 'content 2 about architecture' });
    const n3 = seedNode(db, { tags: ['architecture'], content: 'content 3 about architecture' });

    // 2) 建 confirmed tagged 链接：n1 用户拒绝、n2 和 n3 保留
    const linkN1 = createLink(db, {
      from_id: n1.id,
      to_id: tagNode.id,
      relation: [{ type: 'tagged', confidence: 0.9 }],
      strength: 0.7,
      auto: true,
      status: 'confirmed',
    });
    createLink(db, {
      from_id: n2.id,
      to_id: tagNode.id,
      relation: [{ type: 'tagged', confidence: 0.9 }],
      strength: 0.7,
      auto: true,
      status: 'confirmed',
    });
    createLink(db, {
      from_id: n3.id,
      to_id: tagNode.id,
      relation: [{ type: 'tagged', confidence: 0.9 }],
      strength: 0.7,
      auto: true,
      status: 'confirmed',
    });

    // 3) 用户拒绝 n1→tagNode，并把 strength 打到 0
    updateLinkStatus(db, linkN1!.id, 'rejected_by_user');
    db.prepare('UPDATE links SET strength = 0 WHERE id = ?').run(linkN1!.id);

    // 4) 跑 tag-promote，存量链接会被重评估
    await promoteFrequentTags(db);

    // 5) 验证 rejected 链接：
    const links = getLinksForNode(db, n1.id, { includeRejected: true }).filter(l => l.to_id === tagNode.id);
    expect(links.length).toBe(1);
    const rejected = links[0];
    expect(rejected.status).toBe('rejected_by_user'); // 状态保留
    expect(rejected.strength).toBe(0); // strength 未被重新赋值

    // 6) n2 的 confirmed 链接仍在（说明循环逻辑正常）
    const n2Links = getLinksForNode(db, n2.id, { includeRejected: true }).filter(l => l.to_id === tagNode.id);
    expect(n2Links.length).toBe(1);
    expect(n2Links[0].status).toBe('confirmed');
  });

  it('若用户再次在 node.tags 字符串里恢复该标签，tag-promote 也不会创建新的 confirmed 链接（原 rejected 仍存在）', async () => {
    const tagNode = createNode(db, { type: 'fact', title: 'architecture', content: '', is_tag: 1, heat: 1.0 });
    const n1 = seedNode(db, { tags: ['architecture'], content: 'restored architecture mention' });
    const n2 = seedNode(db, { tags: ['architecture'], content: 'content 2' });
    const n3 = seedNode(db, { tags: ['architecture'], content: 'content 3' });

    const linkN1 = createLink(db, {
      from_id: n1.id,
      to_id: tagNode.id,
      relation: [{ type: 'tagged', confidence: 0.9 }],
      strength: 0.7,
      auto: true,
      status: 'confirmed',
    });
    updateLinkStatus(db, linkN1!.id, 'rejected_by_user');

    // 此时 n1.tags 仍包含 'architecture'（模拟"用户 reject link 但手动又把 tag 加回来"）
    // tag-promote 会走 linkExists 分支（rejected link 存在）→ 不会创建新 link
    await promoteFrequentTags(db);

    const links = getLinksForNode(db, n1.id, { includeRejected: true }).filter(l => l.to_id === tagNode.id);
    expect(links.length).toBe(1);
    expect(links[0].status).toBe('rejected_by_user');
  });
});
