/**
 * queue.ts 集成测试
 *
 * 测试 processFileQueue / processFileChange / getImportProgress / resetProgress
 * 使用真实临时文件和内存数据库，mock LLM 及外部依赖。
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
  findLandingConnections: vi.fn().mockReturnValue({
    action: 'new',
    confirmedLinks: [],
    pendingLinks: [],
  }),
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

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

// ---- Imports（mock 之后） ----

import type Database from 'better-sqlite3';
import { setupTestDb, seedLink, seedNode } from '../../helpers/test-db.js';
import {
  processFileQueue,
  processFileChange,
  getImportProgress,
  resetProgress,
} from '../../../src/integrations/logseq/queue.js';
import {
  ensureSyncSchema,
  setFileState,
  getFileState,
} from '../../../src/integrations/logseq/sync-state.js';
import { getNode } from '../../../src/db/nodes.js';
import { getLinksFrom } from '../../../src/db/links.js';
import { invalidateGateCache } from '../../../src/db/stats.js';

// ---- Helpers ----

let db: Database.Database;
let tmpDir: string;

/**
 * 创建临时 Logseq graph 目录，包含 pages/ 子目录
 */
function createTempGraph(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-queue-test-'));
  fs.mkdirSync(path.join(dir, 'pages'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'journals'), { recursive: true });
  return dir;
}

/**
 * 在 graph 的 pages/ 下写入测试 .md 文件
 */
function writePage(graphRoot: string, name: string, content: string): string {
  const filePath = path.join(graphRoot, 'pages', `${name}.md`);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/**
 * 在 graph 的 journals/ 下写入测试 .md 文件
 */
function writeJournal(graphRoot: string, name: string, content: string): string {
  const filePath = path.join(graphRoot, 'journals', `${name}.md`);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

// ---- Setup / Teardown ----

beforeEach(() => {
  db = setupTestDb();
  mockGetDb.mockReturnValue(db);
  ensureSyncSchema(db);
  invalidateGateCache();
  resetProgress();
  tmpDir = createTempGraph();
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================
// processFileQueue
// ============================================================

describe('processFileQueue', () => {
  it('processes new files and creates nodes', async () => {
    const file1 = writePage(tmpDir, 'test-page', '- Block one\n- Block two');
    const file2 = writePage(tmpDir, 'another-page', '- Hello world\n- Second block');

    await processFileQueue(db, [file1, file2], tmpDir, {
      concurrency: 1,
      batchSize: 10,
      delayBetweenBatches: 0,
    });

    const progress = getImportProgress();
    expect(progress.phase).toBe('done');
    expect(progress.totalFiles).toBe(2);
    expect(progress.processedFiles).toBe(2);
    expect(progress.skippedFiles).toBe(0);
    expect(progress.failedFiles).toBe(0);

    // 同步状态已写入
    const state1 = getFileState(db, 'pages/test-page.md');
    expect(state1).not.toBeNull();
    expect(state1!.node_ids.length).toBeGreaterThan(0);

    const state2 = getFileState(db, 'pages/another-page.md');
    expect(state2).not.toBeNull();
    expect(state2!.node_ids.length).toBeGreaterThan(0);

    // 验证节点确实存在于数据库
    const nodeId = state1!.node_ids[0];
    const node = getNode(db, nodeId);
    expect(node).not.toBeNull();
  });

  it('skips unchanged files when sync state already exists', async () => {
    const file = writePage(tmpDir, 'stable-page', '- Stable content');

    // 第一次处理
    await processFileQueue(db, [file], tmpDir, {
      concurrency: 1,
      batchSize: 10,
      delayBetweenBatches: 0,
    });

    const firstProgress = getImportProgress();
    expect(firstProgress.processedFiles).toBe(1);
    expect(firstProgress.skippedFiles).toBe(0);

    // 重置进度后再次处理同一个文件（内容未变）
    resetProgress();
    await processFileQueue(db, [file], tmpDir, {
      concurrency: 1,
      batchSize: 10,
      delayBetweenBatches: 0,
    });

    const secondProgress = getImportProgress();
    expect(secondProgress.processedFiles).toBe(0);
    expect(secondProgress.skippedFiles).toBe(1);
  });

  it('tracks progress correctly across files', async () => {
    const file1 = writePage(tmpDir, 'page-a', '- Content A');
    const file2 = writePage(tmpDir, 'page-b', '- Content B');
    const file3 = writePage(tmpDir, 'page-c', '- Content C');

    // 预设 page-b 的同步状态使其被跳过
    await processFileQueue(db, [file1], tmpDir, {
      concurrency: 1,
      batchSize: 10,
      delayBetweenBatches: 0,
    });

    // page-a 已处理过，现在一起跑三个
    resetProgress();
    await processFileQueue(db, [file1, file2, file3], tmpDir, {
      concurrency: 1,
      batchSize: 10,
      delayBetweenBatches: 0,
    });

    const progress = getImportProgress();
    expect(progress.totalFiles).toBe(3);
    // file1 被跳过（未变），file2 和 file3 被处理
    expect(progress.skippedFiles).toBe(1);
    expect(progress.processedFiles).toBe(2);
    expect(progress.phase).toBe('done');
  });

  it('handles empty file list as no-op', async () => {
    await processFileQueue(db, [], tmpDir, {
      concurrency: 1,
      batchSize: 10,
      delayBetweenBatches: 0,
    });

    const progress = getImportProgress();
    expect(progress.phase).toBe('done');
    expect(progress.totalFiles).toBe(0);
    expect(progress.processedFiles).toBe(0);
    expect(progress.skippedFiles).toBe(0);
    expect(progress.failedFiles).toBe(0);
  });

  it('can abort before processing the next batch', async () => {
    const file = writePage(tmpDir, 'abort-page', '- Abort content');

    await processFileQueue(db, [file], tmpDir, {
      concurrency: 1,
      batchSize: 10,
      delayBetweenBatches: 0,
    }, undefined, () => true);

    const progress = getImportProgress();
    expect(progress.phase).toBe('idle');
    expect(progress.totalFiles).toBe(1);
    expect(progress.processedFiles).toBe(0);
    expect(progress.skippedFiles).toBe(0);
    expect(progress.failedFiles).toBe(0);
  });

  it('respects batchSize and concurrency config', async () => {
    // 创建 5 个文件，设置 batchSize=2, concurrency=1
    const files: string[] = [];
    for (let i = 0; i < 5; i++) {
      files.push(writePage(tmpDir, `batch-page-${i}`, `- Batch content ${i}`));
    }

    await processFileQueue(db, files, tmpDir, {
      concurrency: 1,
      batchSize: 2,
      delayBetweenBatches: 0,
    });

    const progress = getImportProgress();
    expect(progress.processedFiles).toBe(5);
    expect(progress.phase).toBe('done');
  });
});

// ============================================================
// processFileChange
// ============================================================

describe('processFileChange', () => {
  it('processes a single file change', async () => {
    const file = writePage(tmpDir, 'changed-page', '- New content here\n- More blocks');

    await processFileChange(db, file, tmpDir);

    // 验证同步状态已写入
    const state = getFileState(db, 'pages/changed-page.md');
    expect(state).not.toBeNull();
    expect(state!.node_ids.length).toBeGreaterThan(0);
    expect(state!.content_hash).toBeTruthy();

    // 验证节点存在
    const node = getNode(db, state!.node_ids[0]);
    expect(node).not.toBeNull();
  });

  it('skips file if unchanged since last sync', async () => {
    const file = writePage(tmpDir, 'watched-page', '- Watched content');

    // 首次处理
    await processFileChange(db, file, tmpDir);
    const stateAfterFirst = getFileState(db, 'pages/watched-page.md');
    expect(stateAfterFirst).not.toBeNull();

    // 再次处理（文件未变）— 不应产生新节点
    const oldNodeIds = stateAfterFirst!.node_ids;
    resetProgress();
    await processFileChange(db, file, tmpDir);

    // 同步状态不变
    const stateAfterSecond = getFileState(db, 'pages/watched-page.md');
    expect(stateAfterSecond!.node_ids).toEqual(oldNodeIds);
  });

  it('does not write DB when a stopped watcher event reaches processFileChange', async () => {
    const file = writePage(tmpDir, 'stopped-page', '- Stopped source content');

    const changed = await processFileChange(db, file, tmpDir, 'src-stopped', () => true);

    const state = getFileState(db, 'pages/stopped-page.md', 'src-stopped');
    const nodeCount = (db.prepare('SELECT COUNT(*) AS cnt FROM nodes').get() as { cnt: number }).cnt;
    expect(changed).toBe(false);
    expect(state).toBeNull();
    expect(nodeCount).toBe(0);
  });

  it('watcher 创建 journal 节点时使用日记日期和年龄衰减 heat', async () => {
    const file = writeJournal(tmpDir, '2026_01_15', '- Journal block with enough content\n  - Detail line');

    await processFileChange(db, file, tmpDir);

    const state = getFileState(db, 'journals/2026_01_15.md');
    expect(state).not.toBeNull();
    const node = getNode(db, state!.node_ids[0]);
    expect(node).not.toBeNull();
    expect(node!.created).toBe('2026-01-15T00:00:00.000Z');
    expect(node!.heat).toBeGreaterThan(0.15);
    expect(node!.heat).toBeLessThan(1);
  });

  it('updates nodes when file content changes', async () => {
    const filePath = path.join(tmpDir, 'pages', 'evolving-page.md');
    fs.writeFileSync(filePath, '- Original content', 'utf-8');

    // 首次处理
    await processFileChange(db, filePath, tmpDir);
    const firstState = getFileState(db, 'pages/evolving-page.md');
    expect(firstState).not.toBeNull();
    const firstNodeIds = firstState!.node_ids;

    // 修改文件内容
    fs.writeFileSync(filePath, '- Updated content with new info', 'utf-8');

    // 再次处理
    await processFileChange(db, filePath, tmpDir);
    const secondState = getFileState(db, 'pages/evolving-page.md');
    expect(secondState).not.toBeNull();

    // 新节点应不同于旧节点（版本替代）
    expect(secondState!.content_hash).not.toBe(firstState!.content_hash);
    expect(secondState!.node_ids.length).toBeGreaterThan(0);

    // 旧节点应被标记为 superseded
    for (const oldId of firstNodeIds) {
      const oldNode = getNode(db, oldId);
      if (oldNode) {
        expect(oldNode.is_superseded).toBe(1);
      }
    }
  });
});

// ============================================================
// 段级去重
// ============================================================

describe('segment-level dedup', () => {
  it('首次导入时存储 segment_hashes', async () => {
    // journal 文件中有子节点的 block 不会被合并
    const file = writeJournal(tmpDir, '2026_03_31', '- Block A with content\n  - Sub block A\n- Block B with content\n  - Sub block B');

    await processFileChange(db, file, tmpDir);

    const state = getFileState(db, 'journals/2026_03_31.md');
    expect(state).not.toBeNull();
    expect(state!.segment_hashes!.length).toBeGreaterThan(0);
    expect(state!.segment_hashes!.length).toBe(state!.node_ids.length);
  });

  it('文件更新时未变化的段保留原节点 ID', async () => {
    // journal 中每个有子节点的 block 独立成段
    const filePath = path.join(tmpDir, 'journals', '2026_03_30.md');
    fs.writeFileSync(filePath, '- First block stays the same\n  - Detail A\n- Second block will change\n  - Detail B', 'utf-8');

    await processFileChange(db, filePath, tmpDir);
    const firstState = getFileState(db, 'journals/2026_03_30.md');
    expect(firstState).not.toBeNull();
    expect(firstState!.node_ids.length).toBe(2);

    const firstNodeId = firstState!.node_ids[0];

    // 只修改第二个 block
    fs.writeFileSync(filePath, '- First block stays the same\n  - Detail A\n- Second block has been modified\n  - Detail C', 'utf-8');

    await processFileChange(db, filePath, tmpDir);
    const secondState = getFileState(db, 'journals/2026_03_30.md');
    expect(secondState).not.toBeNull();

    // 第一个段未变化 → 保留原节点 ID
    expect(secondState!.node_ids[0]).toBe(firstNodeId);
    // 第二个段变化 → 新节点 ID
    expect(secondState!.node_ids[1]).not.toBe(firstState!.node_ids[1]);
  });

  it('尾部追加新段时旧段不变', async () => {
    const filePath = path.join(tmpDir, 'journals', '2026_03_29.md');
    fs.writeFileSync(filePath, '- Existing block\n  - Detail', 'utf-8');

    await processFileChange(db, filePath, tmpDir);
    const firstState = getFileState(db, 'journals/2026_03_29.md');
    const originalNodeId = firstState!.node_ids[0];

    // 追加新 block
    fs.writeFileSync(filePath, '- Existing block\n  - Detail\n- New block added\n  - New detail', 'utf-8');

    await processFileChange(db, filePath, tmpDir);
    const secondState = getFileState(db, 'journals/2026_03_29.md');

    // 原有段保留
    expect(secondState!.node_ids[0]).toBe(originalNodeId);
    // 新段被添加
    expect(secondState!.node_ids.length).toBe(2);
  });

  it('删除段时多余旧节点标记 superseded 并迁移 links', async () => {
    const filePath = path.join(tmpDir, 'journals', '2026_03_28.md');
    fs.writeFileSync(filePath, '- Block A\n  - Detail A\n- Block B\n  - Detail B\n- Block C\n  - Detail C', 'utf-8');

    await processFileChange(db, filePath, tmpDir);
    const firstState = getFileState(db, 'journals/2026_03_28.md');
    expect(firstState!.node_ids.length).toBe(3);
    const removedNodeId = firstState!.node_ids[2];
    const target = seedNode(db, { content: 'external target linked from removed segment' });
    seedLink(db, removedNodeId, target.id, { strength: 0.77 });

    // 删除最后一个 block
    fs.writeFileSync(filePath, '- Block A\n  - Detail A\n- Block B\n  - Detail B', 'utf-8');

    await processFileChange(db, filePath, tmpDir);
    const secondState = getFileState(db, 'journals/2026_03_28.md');
    expect(secondState!.node_ids.length).toBe(2);

    // 被删除的节点应标记为 superseded
    const removedNode = getNode(db, removedNodeId);
    if (removedNode) {
      expect(removedNode.is_superseded).toBe(1);
    }

    const targetNewNodeId = secondState!.node_ids[secondState!.node_ids.length - 1];
    const migratedLinks = getLinksFrom(db, targetNewNodeId);
    const migratedLink = migratedLinks.find(link => link.to_id === target.id);
    expect(migratedLink).toBeDefined();
    expect(migratedLink!.strength).toBeCloseTo(0.77);
  });

  it('空段不产生节点', async () => {
    const file = writeJournal(tmpDir, '2026_03_27', '- \n- Real content here\n  - With detail');

    await processFileChange(db, file, tmpDir);

    const state = getFileState(db, 'journals/2026_03_27.md');
    expect(state).not.toBeNull();
    // 空 block 应被过滤，只有有内容的段产生节点
    for (const nodeId of state!.node_ids) {
      const node = getNode(db, nodeId);
      expect(node).not.toBeNull();
      expect(node!.content.trim().length).toBeGreaterThan(0);
    }
  });
});

// ============================================================
// getImportProgress / resetProgress
// ============================================================

describe('getImportProgress / resetProgress', () => {
  it('returns idle state initially', () => {
    const progress = getImportProgress();
    expect(progress.phase).toBe('idle');
    expect(progress.totalFiles).toBe(0);
    expect(progress.processedFiles).toBe(0);
    expect(progress.skippedFiles).toBe(0);
    expect(progress.failedFiles).toBe(0);
    expect(progress.currentFile).toBeNull();
    expect(progress.startedAt).toBeNull();
  });

  it('reflects processing state during queue run', async () => {
    const file = writePage(tmpDir, 'progress-page', '- Progress test');

    // 运行队列后检查 done 状态
    await processFileQueue(db, [file], tmpDir, {
      concurrency: 1,
      batchSize: 10,
      delayBetweenBatches: 0,
    });

    const progress = getImportProgress();
    expect(progress.phase).toBe('done');
    expect(progress.startedAt).not.toBeNull();
    expect(progress.currentFile).toBeNull(); // done 后 currentFile 应清空
  });

  it('resetProgress clears all counters', async () => {
    const file = writePage(tmpDir, 'reset-page', '- Reset test content');

    await processFileQueue(db, [file], tmpDir, {
      concurrency: 1,
      batchSize: 10,
      delayBetweenBatches: 0,
    });

    // 此时有 done 状态
    expect(getImportProgress().phase).toBe('done');
    expect(getImportProgress().processedFiles).toBeGreaterThan(0);

    resetProgress();

    const progress = getImportProgress();
    expect(progress.phase).toBe('idle');
    expect(progress.totalFiles).toBe(0);
    expect(progress.processedFiles).toBe(0);
    expect(progress.skippedFiles).toBe(0);
    expect(progress.failedFiles).toBe(0);
    expect(progress.currentFile).toBeNull();
    expect(progress.startedAt).toBeNull();
  });

  it('returns a copy, not a reference to internal state', () => {
    const p1 = getImportProgress();
    const p2 = getImportProgress();
    expect(p1).toEqual(p2);
    expect(p1).not.toBe(p2); // 不同对象引用
  });
});
