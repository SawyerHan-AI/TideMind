/**
 * Obsidian integration entry point tests
 *
 * Tests orchestration logic, edge cases, and orphan archiving.
 * Does NOT test the full pipeline (requires complex config/fs mocking).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';

// ── Mocks ────────────────────────────────────────────────────

vi.mock('../../../src/strategy/loader.js', () => ({
  getParam: (_s: string, _p: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

// 不 mock db/log.js：周期删除检测测试会走完整 digest 路径（digest 调用
// repo.log.logOperation / logParamFeedback），用真实实现写入测试 DB（schema 完整）。

vi.mock('../../../src/config.js', () => ({
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
    gates: { vector_search: 50, graph_expansion: 20, graph_expansion_links: 10, crystal_generation: 100, divergent_scan: 200, learning_2_min_nodes: 30, learning_2_min_recall_ops: 10 },
    sources: {},
  }),
  getDataDir: () => '/tmp/test-eb',
  isLlmConfigured: () => true,
}));

const mockGetDb = vi.fn();
vi.mock('../../../src/db/connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/db/connection.js')>();
  return { ...actual, isVecLoaded: () => false, getDb: () => mockGetDb() };
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

// ── Imports (after mocks) ────────────────────────────────────

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupTestDb, seedNode } from '../../helpers/test-db.js';
import { invalidateGateCache } from '../../../src/db/stats.js';
import { ensureSyncSchema, setFileState, removeStaleFiles, getFileState } from '../../../src/integrations/obsidian/sync-state.js';
import { getNode } from '../../../src/db/nodes.js';
import {
  startObsidianIntegration,
  stopObsidianIntegration,
  startObsidianSource,
  stopObsidianSource,
} from '../../../src/integrations/obsidian/index.js';
import { appendToStream } from '../../../src/stream/writer.js';

// ── Helpers ──────────────────────────────────────────────────

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
  mockGetDb.mockReturnValue(db);
  invalidateGateCache();
  ensureSyncSchema(db);
});

afterEach(() => {
  stopObsidianIntegration();
  db.close();
});

// ── Tests ────────────────────────────────────────────────────

describe('startObsidianIntegration', () => {
  it('returns early when config.sources.obsidian is undefined (no error)', async () => {
    // Default mock has sources: {} (no obsidian key), so this should just return
    await expect(startObsidianIntegration(db)).resolves.toBeUndefined();
  });

  it('returns early when vault path does not exist', async () => {
    // Override getConfig to return a non-existent vault path
    const configMod = await import('../../../src/config.js');
    const origGetConfig = configMod.getConfig;
    vi.spyOn(configMod, 'getConfig').mockReturnValue({
      ...origGetConfig(),
      sources: { obsidian: { path: '/tmp/this-vault-does-not-exist-999' } },
    } as ReturnType<typeof origGetConfig>);

    await expect(startObsidianIntegration(db)).resolves.toBeUndefined();

    vi.mocked(configMod.getConfig).mockRestore();
  });
});

describe('stopObsidianIntegration', () => {
  it('does not throw when called without prior start', () => {
    expect(() => stopObsidianIntegration()).not.toThrow();
  });
});

// 回归（poll_interval 被忽略 → 删除检测不周期触发）：
// watcher 不处理删除，删除检测只在 runSync 里发生。修复前 startObsidianSource 的
// pollInterval 参数命名为 `_pollInterval` 显式弃用、没有任何周期 runSync，用户删笔记后
// 节点无限期留在活跃 recall。现在按 poll_interval 注册周期 runSync（删除检测兜底）。
// 这里验证「定时器被正确注册 + 用配置的间隔 + stop 时清理」这一被修复的核心契约；
// 定时器触发的 removeStaleFiles/archiveOrphanNodes 删除逻辑已由本文件 orphan archiving 套件覆盖。
// 回归（daemon shutdown 无法停止仍在初始 runSync 中的源）：
// stopObsidianIntegration 修复前遍历 watchers.keys()，但 watcher 在首扫 await 完成后
// 才注册，首扫期间该源不在 watchers 里 → stop no-op → 首扫继续跑。修复:改为遍历
// activeSources（startObsidianSource 入口即 add，见 index.ts:83），并在 runSyncInner
// (index.ts:201/234/282) 与 processFileQueue (queue.ts:106/110/per-segment) 各加 isStopped 短路。
//
// 这里只校验"stop 期间启动的源不会真正启动 watcher/poll"这一确定性子契约
// （依赖 startObsidianSource 末尾的 `if (!stoppedSources.has(sourceId))` 守卫，
//  index.ts:100/107）。"首扫处理中途被中止"原本用「阻塞 appendToStream 制造在途窗口」
// 测试,但该路径要跑通真实 digest pipeline(classify/segment 依赖被 mock 成无效输出的
// callLLM),文件能否跑到 appendToStream 本身不确定 → firstCalled 偶发永挂、30s 超时
// (隔离 ~17%,满载更高),会偶发卡死发版全量套件(CLAUDE.md 防坑规则 #10)。中止主路径
// (activeSources + isStopped 检查) 已由源码审查确认,不为它保留一个不可稳定的计时竞态测试。
describe('shutdown 停止仍在首次同步中的源', () => {
  it('stop 期间启动的源不会启动 watcher / poll 定时器（activeSources/stoppedSources 守卫生效）', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-obs-shutdown-'));
    fs.writeFileSync(path.join(vaultRoot, 'a.md'), '# A\n\nNote a with enough content to become a node during initial sync.\n', 'utf-8');

    try {
      // 不 await 启动:startObsidianSource 入口同步 activeSources.add(src-sd) 后 await runSync,
      // 控制权回到测试 → 立刻 stopObsidianIntegration()(遍历 activeSources 标记 stopped),
      // 模拟"首扫在途、watcher 尚未注册时收到 SIGTERM"。startObsidianSource 末尾的
      // stoppedSources 守卫(index.ts:100/107)应阻止 watcher 与 poll 定时器启动。
      // 不依赖 digest pipeline 跑到任何具体步骤 → 确定性。
      const startPromise = startObsidianSource(db, 'src-sd', vaultRoot, 45);
      stopObsidianIntegration();
      await startPromise;

      // 已停止 → 不应注册 poll 定时器（45_000ms）
      const pollCall = setIntervalSpy.mock.calls.find(([, ms]) => ms === 45_000);
      expect(pollCall).toBeUndefined();
    } finally {
      stopObsidianSource('src-sd');
      setIntervalSpy.mockRestore();
      fs.rmSync(vaultRoot, { recursive: true, force: true });
    }
  }, 30000);
});

describe('周期性删除检测（poll_interval）', () => {
  it('startObsidianSource 按 poll_interval 注册周期 runSync 定时器，stop 时清理', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-obs-poll-'));
    fs.writeFileSync(
      path.join(vaultRoot, 'note.md'),
      '# Note\n\nThis note has enough content to pass the quality gate and become a brain node.\n',
      'utf-8',
    );

    try {
      await startObsidianSource(db, 'src-poll', vaultRoot, 45);

      // 修复前没有任何周期定时器；现在应注册一个、且用配置的间隔（45s → 45000ms）
      const pollCall = setIntervalSpy.mock.calls.find(([, ms]) => ms === 45_000);
      expect(pollCall).toBeDefined();
      const registeredTimer = setIntervalSpy.mock.results.find(
        (_r, i) => setIntervalSpy.mock.calls[i][1] === 45_000,
      )?.value;
      expect(registeredTimer).toBeDefined();

      // stop 应清理该定时器（避免泄漏 + 停后仍扫描）
      stopObsidianSource('src-poll');
      expect(clearIntervalSpy).toHaveBeenCalledWith(registeredTimer);
    } finally {
      stopObsidianSource('src-poll');
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
      fs.rmSync(vaultRoot, { recursive: true, force: true });
    }
  }, 30000);
});

describe('orphan node archiving', () => {
  it('archives nodes whose source files are deleted', () => {
    // 1. Create nodes in the DB
    const nodeA = seedNode(db, { content: 'Obsidian note A', source_tool: 'obsidian' });
    const nodeB = seedNode(db, { content: 'Obsidian note B', source_tool: 'obsidian' });
    const nodeC = seedNode(db, { content: 'Obsidian note C (kept)', source_tool: 'obsidian' });

    // 2. Register sync states mapping files to node IDs
    setFileState(db, {
      file_path: 'notes/a.md',
      content_hash: 'aaa',
      mtime: 1000,
      size: 100,
      last_synced: new Date().toISOString(),
      node_ids: [nodeA.id],
    });
    setFileState(db, {
      file_path: 'notes/b.md',
      content_hash: 'bbb',
      mtime: 1000,
      size: 200,
      last_synced: new Date().toISOString(),
      node_ids: [nodeB.id],
    });
    setFileState(db, {
      file_path: 'notes/c.md',
      content_hash: 'ccc',
      mtime: 1000,
      size: 300,
      last_synced: new Date().toISOString(),
      node_ids: [nodeC.id],
    });

    // 3. Simulate: only c.md still exists
    const currentFiles = new Set(['notes/c.md']);
    const { removed, orphanNodeIds } = removeStaleFiles(db, currentFiles);

    expect(removed).toBe(2);
    expect(orphanNodeIds).toContain(nodeA.id);
    expect(orphanNodeIds).toContain(nodeB.id);
    expect(orphanNodeIds).not.toContain(nodeC.id);

    // 4. Run archiving SQL (same logic as archiveOrphanNodes)
    const stmt = db.prepare(
      'UPDATE nodes SET archived = 1, heat = 0.01 WHERE id = ? AND archived = 0',
    );
    for (const id of orphanNodeIds) {
      stmt.run(id);
    }

    // 5. Verify archived state
    const archivedA = getNode(db, nodeA.id)!;
    expect(archivedA.archived).toBe(1);
    expect(archivedA.heat).toBeCloseTo(0.01);

    const archivedB = getNode(db, nodeB.id)!;
    expect(archivedB.archived).toBe(1);
    expect(archivedB.heat).toBeCloseTo(0.01);

    // Node C should be untouched
    const keptC = getNode(db, nodeC.id)!;
    expect(keptC.archived).toBe(0);
    expect(keptC.heat).toBeGreaterThan(0.01);
  });

  it('handles files with multiple node_ids', () => {
    const node1 = seedNode(db, { content: 'Multi-node file part 1', source_tool: 'obsidian' });
    const node2 = seedNode(db, { content: 'Multi-node file part 2', source_tool: 'obsidian' });

    setFileState(db, {
      file_path: 'notes/multi.md',
      content_hash: 'mmm',
      mtime: 1000,
      size: 500,
      last_synced: new Date().toISOString(),
      node_ids: [node1.id, node2.id],
    });

    // File deleted
    const currentFiles = new Set<string>();
    const { removed, orphanNodeIds } = removeStaleFiles(db, currentFiles);

    expect(removed).toBe(1);
    expect(orphanNodeIds).toHaveLength(2);
    expect(orphanNodeIds).toContain(node1.id);
    expect(orphanNodeIds).toContain(node2.id);
  });

  it('returns empty orphanNodeIds when no files have associated nodes', () => {
    setFileState(db, {
      file_path: 'notes/empty.md',
      content_hash: 'eee',
      mtime: 1000,
      size: 50,
      last_synced: new Date().toISOString(),
      node_ids: [],
    });

    const currentFiles = new Set<string>();
    const { removed, orphanNodeIds } = removeStaleFiles(db, currentFiles);

    expect(removed).toBe(1);
    expect(orphanNodeIds).toHaveLength(0);
  });

  it('does not re-archive already archived nodes', () => {
    const node = seedNode(db, { content: 'Already archived', source_tool: 'obsidian' });

    // Pre-archive the node
    db.prepare('UPDATE nodes SET archived = 1, heat = 0.01 WHERE id = ?').run(node.id);

    setFileState(db, {
      file_path: 'notes/old.md',
      content_hash: 'ooo',
      mtime: 1000,
      size: 100,
      last_synced: new Date().toISOString(),
      node_ids: [node.id],
    });

    const currentFiles = new Set<string>();
    const { orphanNodeIds } = removeStaleFiles(db, currentFiles);

    // The archiving SQL has WHERE archived = 0, so it won't change an already-archived node
    const stmt = db.prepare(
      'UPDATE nodes SET archived = 1, heat = 0.01 WHERE id = ? AND archived = 0',
    );
    const result = stmt.run(orphanNodeIds[0]);
    expect(result.changes).toBe(0); // No rows changed
  });
});
