/**
 * logseq/index.ts 编排模块测试
 *
 * 测试入口函数的 config 边界、停止清理、孤立节点归档逻辑。
 * 大部分依赖 mock，仅 DB 使用内存真实实例。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---- Mocks（必须在 import 之前） ----

vi.mock('../../../src/strategy/loader.js', () => ({
  getParam: (_s: string, _p: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

vi.mock('../../../src/db/log.js', () => ({
  logTimelineEvent: vi.fn(),
}));

let mockConfig: any = null;
vi.mock('../../../src/config.js', () => ({
  getConfig: () => mockConfig ?? {
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
  },
  getDataDir: () => '/tmp/test-eb',
  isLlmConfigured: () => true,
}));

vi.mock('../../../src/db/connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/db/connection.js')>();
  return { ...actual, isVecLoaded: () => false };
});

vi.mock('../../../src/llm/embedding.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(3072)),
}));

vi.mock('../../../src/llm/client.js', () => ({
  callLLM: vi.fn().mockResolvedValue('LLM response'),
}));

vi.mock('../../../src/graph/landing.js', () => ({
  findLandingConnections: vi.fn().mockReturnValue({ action: 'new', confirmedLinks: [], pendingLinks: [] }),
}));

vi.mock('../../../src/graph/dedup.js', () => ({
  reconsolidateNode: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/db/vectors.js', () => ({
  insertVector: vi.fn(),
}));

vi.mock('../../../src/stream/writer.js', () => ({
  appendToStream: vi.fn().mockReturnValue('stream:2026-03-25:abc123:1'),
}));

// ---- Imports（mock 之后） ----

import type Database from 'better-sqlite3';
import { setupTestDb, seedNode } from '../../helpers/test-db.js';
import { invalidateGateCache } from '../../../src/db/stats.js';
import {
  ensureSyncSchema, setFileState, hasCompletedFullScan, markFullScanCompleted,
  removeStaleFiles,
} from '../../../src/integrations/logseq/sync-state.js';
import { getNode } from '../../../src/db/nodes.js';
import {
  startLogseqIntegration, stopLogseqIntegration, triggerFullRescan,
} from '../../../src/integrations/logseq/index.js';

// ---- Test suite ----

let db: Database.Database;
let tmpDir: string;

beforeEach(() => {
  db = setupTestDb();
  invalidateGateCache();
  mockConfig = null;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logseq-index-test-'));
});

afterEach(async () => {
  await stopLogseqIntegration(); // async(drain 在途链)→ await 再 close db,对齐生产 shutdown 顺序
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================
// startLogseqIntegration - config 边界
// ============================================================

describe('startLogseqIntegration', () => {
  it('config.sources.logseq 未定义时静默返回', async () => {
    // 默认 mockConfig 的 sources 为空对象 -> logseq undefined
    await expect(startLogseqIntegration(db)).resolves.toBeUndefined();
    // 确认没有创建同步表（因为提前返回了）
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='logseq_sync'",
    ).all();
    expect(tables).toHaveLength(0);
  });

  it('logseq.path 为空字符串时静默返回', async () => {
    mockConfig = {
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
      sources: { logseq: { path: '' } },
    };
    await expect(startLogseqIntegration(db)).resolves.toBeUndefined();
  });

  it('graph 路径不存在时静默返回（不抛异常）', async () => {
    mockConfig = {
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
      sources: { logseq: { path: '/tmp/definitely-does-not-exist-xyz123' } },
    };
    await expect(startLogseqIntegration(db)).resolves.toBeUndefined();
    // 同步表也不应被创建（因为路径检查在 ensureSyncSchema 之前）
    // 但实际代码中 ensureSyncSchema 不在此 if 分支，先确认行为即可
  });
});

// ============================================================
// stopLogseqIntegration - 清理
// ============================================================

describe('stopLogseqIntegration', () => {
  it('未启动时调用不抛异常', async () => {
    await expect(stopLogseqIntegration()).resolves.toBeUndefined();
  });

  it('多次调用不抛异常', async () => {
    await stopLogseqIntegration();
    await stopLogseqIntegration();
    await expect(stopLogseqIntegration()).resolves.toBeUndefined();
  });
});

// ============================================================
// archiveOrphanNodes - 通过 DB 层间接测试
// ============================================================

describe('archiveOrphanNodes (间接测试)', () => {
  it('stale 文件关联的节点被归档：archived=1, heat=0.01', () => {
    ensureSyncSchema(db);

    // 创建两个节点
    const node1 = seedNode(db, { content: '将被归档的节点 A', heat: 0.8 });
    const node2 = seedNode(db, { content: '将被归档的节点 B', heat: 0.6 });
    const nodeKeep = seedNode(db, { content: '保留的节点', heat: 0.5 });

    // 模拟同步记录：一个 stale 文件关联 node1 和 node2
    setFileState(db, {
      file_path: 'pages/deleted-note.md',
      content_hash: 'abc123',
      mtime: Date.now(),
      size: 100,
      last_synced: new Date().toISOString(),
      node_ids: [node1.id, node2.id],
    });

    // 另一个仍存在的文件关联 nodeKeep
    setFileState(db, {
      file_path: 'pages/existing-note.md',
      content_hash: 'def456',
      mtime: Date.now(),
      size: 200,
      last_synced: new Date().toISOString(),
      node_ids: [nodeKeep.id],
    });

    // archiveOrphanNodes 是私有函数，无法直接调用。
    // 通过 removeStaleFiles 获取 orphanNodeIds，然后手动模拟归档逻辑。
    const currentFiles = new Set(['pages/existing-note.md']);
    const { removed, orphanNodeIds } = removeStaleFiles(db, currentFiles);

    expect(removed).toBe(1);
    expect(orphanNodeIds).toContain(node1.id);
    expect(orphanNodeIds).toContain(node2.id);
    expect(orphanNodeIds).toHaveLength(2);

    // 手动执行与 archiveOrphanNodes 相同的 SQL
    const stmt = db.prepare(
      'UPDATE nodes SET archived = 1, heat = 0.01 WHERE id = ? AND archived = 0',
    );
    for (const id of orphanNodeIds) {
      stmt.run(id);
    }

    // 验证节点状态
    const archived1 = getNode(db, node1.id);
    const archived2 = getNode(db, node2.id);
    const kept = getNode(db, nodeKeep.id);

    expect(archived1).not.toBeNull();
    expect(archived1!.archived).toBe(1);
    expect(archived1!.heat).toBeCloseTo(0.01);

    expect(archived2).not.toBeNull();
    expect(archived2!.archived).toBe(1);
    expect(archived2!.heat).toBeCloseTo(0.01);

    expect(kept).not.toBeNull();
    expect(kept!.archived).toBe(0);
    expect(kept!.heat).toBeCloseTo(0.5);
  });

  it('已归档的节点不被重复更新', () => {
    ensureSyncSchema(db);

    const node = seedNode(db, { content: '已经归档的节点', heat: 0.5 });

    // 手动标记为已归档
    db.prepare('UPDATE nodes SET archived = 1, heat = 0.05 WHERE id = ?').run(node.id);

    // 执行与 archiveOrphanNodes 相同的 SQL（WHERE archived = 0 会跳过已归档的）
    const result = db.prepare(
      'UPDATE nodes SET archived = 1, heat = 0.01 WHERE id = ? AND archived = 0',
    ).run(node.id);

    expect(result.changes).toBe(0);

    // heat 保持 0.05 而不是被覆盖为 0.01
    const after = getNode(db, node.id);
    expect(after!.heat).toBeCloseTo(0.05);
  });
});

// ============================================================
// triggerFullRescan - 基本行为
// ============================================================

describe('triggerFullRescan', () => {
  it('config 无 logseq 路径时静默返回', async () => {
    // 默认 config.sources 为空
    await expect(triggerFullRescan(db)).resolves.toBeUndefined();
  });

  it('路径不存在时静默返回', async () => {
    mockConfig = {
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
      sources: { logseq: { path: '/tmp/nonexistent-graph-xyz987' } },
    };
    await expect(triggerFullRescan(db)).resolves.toBeUndefined();
  });

  it('重置 full scan 标志后重新执行同步', async () => {
    ensureSyncSchema(db);
    markFullScanCompleted(db);
    expect(hasCompletedFullScan(db)).toBe(true);

    // 配置指向一个空临时目录（无 .md 文件 -> runSync 快速返回）
    mockConfig = {
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
      sources: { logseq: { path: tmpDir, watch: false } },
    };

    await triggerFullRescan(db);

    // triggerFullRescan 先 resetFullScanState，然后 runSync 内部
    // 因为 allFiles.length === 0 直接 return，不会 markFullScanCompleted
    // 所以最终 full scan 标志应该被清除
    expect(hasCompletedFullScan(db)).toBe(false);
  });
});

// ============================================================
// 同步状态与归档 - 端到端小场景
// ============================================================

describe('sync state + archive 端到端', () => {
  it('removeStaleFiles 正确识别已删除文件并收集 orphan node IDs', () => {
    ensureSyncSchema(db);

    // 模拟 3 个同步记录
    const n1 = seedNode(db, { content: 'note1 内容' });
    const n2 = seedNode(db, { content: 'note2 内容' });
    const n3 = seedNode(db, { content: 'note3 内容' });

    setFileState(db, {
      file_path: 'pages/note1.md',
      content_hash: 'h1',
      mtime: 1000,
      size: 50,
      last_synced: '2026-01-01T00:00:00Z',
      node_ids: [n1.id],
    });
    setFileState(db, {
      file_path: 'pages/note2.md',
      content_hash: 'h2',
      mtime: 2000,
      size: 60,
      last_synced: '2026-01-01T00:00:00Z',
      node_ids: [n2.id],
    });
    setFileState(db, {
      file_path: 'journals/note3.md',
      content_hash: 'h3',
      mtime: 3000,
      size: 70,
      last_synced: '2026-01-01T00:00:00Z',
      node_ids: [n3.id],
    });

    // 只有 note1.md 还存在
    const currentFiles = new Set(['pages/note1.md']);
    const { removed, orphanNodeIds } = removeStaleFiles(db, currentFiles);

    expect(removed).toBe(2);
    expect(orphanNodeIds).toHaveLength(2);
    expect(orphanNodeIds).toContain(n2.id);
    expect(orphanNodeIds).toContain(n3.id);
    expect(orphanNodeIds).not.toContain(n1.id);
  });
});
