/**
 * editNode flow 集成测试
 *
 * 覆盖客户端 `write:editNode` IPC 的核心流程：
 *   digest(new content + new title) → supersedeNode(old, new)
 *
 * 验证标题可编辑后的端到端行为：
 * - 新节点同时携带新 title 和新 content
 * - 旧节点被标记 superseded
 * - 链接正确迁移到新节点
 * - 只改 title 或只改 content 都走同一条路径
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

vi.mock('../../src/db/connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/connection.js')>();
  return { ...actual, isVecLoaded: () => false };
});

vi.mock('../../src/llm/client.js', () => ({
  callLLM: vi.fn().mockResolvedValue(''),
}));

vi.mock('../../src/utils/logger.js', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

import type Database from 'better-sqlite3';
import { setupTestDb, seedNode, seedLink } from '../helpers/test-db.js';
import { digest } from '../../src/tools/digest.js';
import { getNode } from '../../src/db/nodes.js';
import { getLinksFrom, getLinksTo } from '../../src/db/links.js';
import { supersedeNode } from '../../src/integrations/shared/version.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
  vi.clearAllMocks();
});

/**
 * 模拟 `write:editNode` IPC 的内部流程。
 * 参数、顺序都与 `client/electron/ipc/write.ts` 保持一致。
 */
async function simulateEditNode(
  nodeId: string,
  newContent: string,
  newTitle: string | null,
  reason: string,
): Promise<{ success: boolean; newNodeId?: string; error?: string }> {
  const oldNode = getNode(db, nodeId);
  if (!oldNode) return { success: false, error: `节点 ${nodeId} 不存在` };

  const result = await digest(db, {
    content: newContent,
    title: newTitle ?? undefined,
    source: { tool: 'client' },
    context: reason,
    tags: oldNode.tags ? JSON.parse(oldNode.tags) : undefined,
    async: false,
  });

  const newNodeId = result.created_nodes?.[0]?.id;
  if (!newNodeId) return { success: false, error: '新节点创建失败' };

  supersedeNode(db, nodeId, newNodeId);
  return { success: true, newNodeId };
}

describe('editNode flow (digest + supersede with title)', () => {
  it('同时改 title 和 content 时，新节点携带新值且旧节点被 supersede', async () => {
    const oldNode = seedNode(db, {
      title: '旧标题',
      content: '旧的正文内容，足够长以通过质量门控',
    });

    const res = await simulateEditNode(
      oldNode.id,
      '新的正文内容，也是足够长的',
      '新标题',
      'manual edit',
    );

    expect(res.success).toBe(true);
    expect(res.newNodeId).toBeDefined();

    const newNode = getNode(db, res.newNodeId!)!;
    expect(newNode.title).toBe('新标题');
    expect(newNode.content).toBe('新的正文内容，也是足够长的');

    // 旧节点被标记 superseded
    const updatedOld = getNode(db, oldNode.id)!;
    expect(updatedOld.is_superseded).toBe(1);
  });

  it('只改 title 不改 content 时，新节点仍然生成并 supersede 旧节点', async () => {
    const oldNode = seedNode(db, {
      title: '原标题',
      content: '这段正文保持不变，长度足够通过质量门控',
    });

    const res = await simulateEditNode(
      oldNode.id,
      oldNode.content,
      '修改后的标题',
      'title rename',
    );

    expect(res.success).toBe(true);
    const newNode = getNode(db, res.newNodeId!)!;
    expect(newNode.title).toBe('修改后的标题');
    expect(newNode.content).toBe(oldNode.content);
    expect(newNode.id).not.toBe(oldNode.id);

    const updatedOld = getNode(db, oldNode.id)!;
    expect(updatedOld.is_superseded).toBe(1);
  });

  it('只改 content 不改 title 时，新节点保留原 title', async () => {
    const oldNode = seedNode(db, {
      title: '固定标题',
      content: '旧正文内容，足够长通过门控',
    });

    const res = await simulateEditNode(
      oldNode.id,
      '全新的正文内容，同样足够长',
      '固定标题',
      'content only',
    );

    expect(res.success).toBe(true);
    const newNode = getNode(db, res.newNodeId!)!;
    expect(newNode.title).toBe('固定标题');
    expect(newNode.content).toBe('全新的正文内容，同样足够长');
  });

  it('编辑后链接迁移到新节点', async () => {
    const oldNode = seedNode(db, {
      title: '节点A',
      content: '节点A的正文内容足够长',
    });
    const other = seedNode(db, {
      title: '节点B',
      content: '节点B的正文内容足够长',
    });
    // old → other (outgoing)
    seedLink(db, oldNode.id, other.id);
    // other → old (incoming)
    seedLink(db, other.id, oldNode.id);

    const res = await simulateEditNode(
      oldNode.id,
      '节点A的新正文内容',
      '节点A改名',
      'edit with links',
    );

    expect(res.success).toBe(true);
    const newNodeId = res.newNodeId!;

    // 新节点应当承接原有的双向链接（迁移 + 一条 updates 链接指向新节点）
    const newOut = getLinksFrom(db, newNodeId);
    const newIn = getLinksTo(db, newNodeId);
    expect(newOut.some(l => l.to_id === other.id)).toBe(true);
    expect(newIn.some(l => l.from_id === other.id)).toBe(true);
  });

  it('编辑一个原本没有 title 的节点，可以补上 title', async () => {
    const oldNode = seedNode(db, {
      // 不传 title，留空
      content: '一段无标题的旧记忆内容足够长',
    });
    expect(oldNode.title).toBeNull();

    const res = await simulateEditNode(
      oldNode.id,
      oldNode.content,
      '补上的新标题',
      'add title',
    );

    expect(res.success).toBe(true);
    const newNode = getNode(db, res.newNodeId!)!;
    expect(newNode.title).toBe('补上的新标题');
  });

  it('编辑不存在的节点 ID 返回错误，不创建新节点', async () => {
    const res = await simulateEditNode(
      'nonexistent-id',
      '新内容足够长足够长',
      '新标题',
      'should fail',
    );

    expect(res.success).toBe(false);
    expect(res.error).toContain('不存在');
  });
});
