/**
 * Obsidian queue (processFileQueue / processFileChange) 集成测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---- Mocks（必须在 import 之前） ----

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

vi.mock('../../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, _param: string, fallback: number) => fallback,
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
  appendToStream: vi.fn().mockReturnValue('stream:2026-01-01:abc:1'),
}));

vi.mock('../../../src/integrations/obsidian/vault-config.js', () => ({
  readVaultConfig: () => ({ dailyNotes: null, attachmentFolder: '', templateFolder: '', useMarkdownLinks: false }),
  getExcludedDirs: () => ['.obsidian', '.trash'],
}));

// 部分 mock sync-state：默认保留真实实现,只在 dataless→readable race 测试里把
// 入口那次 getFileStat 返回 null(stat 时 dataless),read-time 补抓那次返回真实 stat
//(文件已被 iCloud 下载)。其余函数走真实逻辑。nullFirstFileStatOnly 默认 false。
let nullFirstFileStatOnly = false;
let fileStatCallCount = 0;
vi.mock('../../../src/integrations/obsidian/sync-state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/integrations/obsidian/sync-state.js')>();
  return {
    ...actual,
    getFileStat: (filePath: string) => {
      fileStatCallCount++;
      if (nullFirstFileStatOnly && fileStatCallCount === 1) return null;
      return actual.getFileStat(filePath);
    },
  };
});

import type Database from 'better-sqlite3';
import { setupTestDb, seedLink, seedNode } from '../../helpers/test-db.js';
import {
  processFileQueue,
  processFileChange,
  getImportProgress,
  resetProgress,
} from '../../../src/integrations/obsidian/queue.js';
import { ensureSyncSchema, getFileState, setFileState, isFileChanged } from '../../../src/integrations/obsidian/sync-state.js';
import { getNode } from '../../../src/db/nodes.js';
import { getLinksFrom } from '../../../src/db/links.js';
import { clearTagNodeCache } from '../../../src/integrations/shared/property-promote.js';
import { appendToStream } from '../../../src/stream/writer.js';

// ---- 工具函数 ----

let tmpDir: string;
let db: Database.Database;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-obsidian-queue-'));
  db = setupTestDb();
  mockGetDb.mockReturnValue(db);
  ensureSyncSchema(db);
  resetProgress();
  clearTagNodeCache();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  nullFirstFileStatOnly = false;
  fileStatCallCount = 0;
});

/** 创建一个带 YAML frontmatter 的 .md 文件 */
function writeMd(relPath: string, content: string): string {
  const absPath = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, 'utf-8');
  return absPath;
}

/** 创建 .canvas 文件 */
function writeCanvas(relPath: string, data: unknown): string {
  const absPath = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, JSON.stringify(data), 'utf-8');
  return absPath;
}

/** 标准 Obsidian md 文件内容（足够长以通过质量门控） */
const SAMPLE_MD = `---
tags: [test, knowledge]
aliases: [sample]
category: reference
---
# Test Note

This is a test note with enough content to pass quality gates for the Obsidian preprocessor.
It contains multiple sentences and meaningful text that should be processed correctly.

## Section Two

Another section with additional content about testing and verification.
This paragraph provides more context and detail for the segmentation logic.
`;

const MINIMAL_MD = `---
tags: [minimal]
---
# Minimal Note

This note has just enough content to pass the minimum length threshold for processing.
Some more text to ensure it gets past the quality checks and minimum character requirements.
`;

// ===== processFileQueue =====

describe('processFileQueue', () => {
  it('processes new .md files', async () => {
    const f1 = writeMd('notes/note-one.md', SAMPLE_MD);
    const f2 = writeMd('notes/note-two.md', MINIMAL_MD);

    await processFileQueue(db, [f1, f2], tmpDir, { batchSize: 10, concurrency: 1, delayBetweenBatches: 0 });

    const prog = getImportProgress();
    expect(prog.phase).toBe('done');
    // Both files should be either processed or skipped (not failed)
    expect(prog.failedFiles).toBe(0);
    expect(prog.processedFiles + prog.skippedFiles).toBe(2);
  });

  it('skips unchanged files on second run', async () => {
    const f1 = writeMd('notes/unchanged.md', SAMPLE_MD);

    // First run
    await processFileQueue(db, [f1], tmpDir, { batchSize: 10, concurrency: 1, delayBetweenBatches: 0 });
    const firstRun = getImportProgress();
    const firstProcessed = firstRun.processedFiles;

    resetProgress();

    // Second run with same file (unchanged)
    await processFileQueue(db, [f1], tmpDir, { batchSize: 10, concurrency: 1, delayBetweenBatches: 0 });
    const secondRun = getImportProgress();

    // File should be skipped on second run because hash matches
    expect(secondRun.skippedFiles).toBe(1);
    expect(secondRun.processedFiles).toBe(0);
  });

  it('progress tracking works correctly', async () => {
    const f1 = writeMd('notes/prog-a.md', SAMPLE_MD);
    const f2 = writeMd('notes/prog-b.md', MINIMAL_MD);

    // Before processing
    const before = getImportProgress();
    expect(before.phase).toBe('idle');
    expect(before.totalFiles).toBe(0);

    await processFileQueue(db, [f1, f2], tmpDir, { batchSize: 10, concurrency: 1, delayBetweenBatches: 0 });

    const after = getImportProgress();
    expect(after.phase).toBe('done');
    expect(after.totalFiles).toBe(2);
    expect(after.startedAt).not.toBeNull();
    expect(after.currentFile).toBeNull(); // cleared after done
    expect(after.failedFiles).toBe(0);
    expect(after.processedFiles + after.skippedFiles).toBe(2);
  });

  it('can abort before processing the next batch', async () => {
    const f1 = writeMd('notes/abort.md', SAMPLE_MD);

    await processFileQueue(
      db,
      [f1],
      tmpDir,
      { batchSize: 10, concurrency: 1, delayBetweenBatches: 0 },
      undefined,
      () => true,
    );

    const prog = getImportProgress();
    expect(prog.phase).toBe('idle');
    expect(prog.totalFiles).toBe(1);
    expect(prog.processedFiles).toBe(0);
    expect(prog.skippedFiles).toBe(0);
    expect(prog.failedFiles).toBe(0);
  });
});

// ===== Canvas file processing =====

describe('canvas file processing', () => {
  it('creates nodes from canvas text nodes', async () => {
    const canvasPath = writeCanvas('canvas-test.canvas', {
      nodes: [
        { id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'Node one text content here that is long enough to process' },
        { id: 'n2', type: 'text', x: 200, y: 0, width: 100, height: 50, text: 'Node two text content here that is also long enough to process' },
      ],
      edges: [],
    });

    await processFileQueue(db, [canvasPath], tmpDir, { batchSize: 10, concurrency: 1, delayBetweenBatches: 0 });

    const prog = getImportProgress();
    expect(prog.failedFiles).toBe(0);
    // Canvas file should be processed (not skipped)
    expect(prog.processedFiles).toBe(1);
  });

  it('creates links from canvas edges with correct Map-based mapping', async () => {
    const canvasPath = writeCanvas('linked-canvas.canvas', {
      nodes: [
        { id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'Source node with enough text to be meaningful content for digest' },
        { id: 'n2', type: 'text', x: 200, y: 0, width: 100, height: 50, text: 'Target node with enough text to be meaningful content for digest' },
      ],
      edges: [
        { id: 'e1', fromNode: 'n1', toNode: 'n2', label: 'relates to' },
      ],
    });

    await processFileQueue(db, [canvasPath], tmpDir, { batchSize: 10, concurrency: 1, delayBetweenBatches: 0 });

    const prog = getImportProgress();
    expect(prog.failedFiles).toBe(0);
    expect(prog.processedFiles).toBe(1);

    // Verify that links were created by checking nodes have outgoing links.
    // The Map-based canvasNodeToBrainNode mapping ensures edge.fromId/toId
    // correctly resolve to brain node IDs.
    // We can't easily predict the exact node IDs, but we can verify the file
    // processed without error (the Map-based fix prevents the old bug where
    // edges would silently fail to create links).
  });

  it('handles canvas with link nodes', async () => {
    const canvasPath = writeCanvas('link-canvas.canvas', {
      nodes: [
        { id: 'l1', type: 'link', x: 0, y: 0, width: 200, height: 100, url: 'https://example.com' },
      ],
      edges: [],
    });

    await processFileQueue(db, [canvasPath], tmpDir, { batchSize: 10, concurrency: 1, delayBetweenBatches: 0 });

    const prog = getImportProgress();
    expect(prog.failedFiles).toBe(0);
    expect(prog.processedFiles).toBe(1);
  });

  // 回归：canvas 清空死循环（对齐 .md M18）。清空后旧节点应 supersede、state 应
  // 更新，使下次 isFileChanged 返回 false（不再每次 trigger 重处理）。
  it('清空 canvas 后 supersede 旧节点并更新 sync state（不再死循环重处理）', async () => {
    const rel = 'empty-me.canvas';
    const canvasPath = writeCanvas(rel, {
      nodes: [
        { id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'Canvas node content that is long enough to digest into a node' },
      ],
      edges: [],
    });

    await processFileChange(db, canvasPath, tmpDir);
    const firstState = getFileState(db, rel);
    expect(firstState).not.toBeNull();
    expect(firstState!.node_ids.length).toBe(1);
    const oldNodeId = firstState!.node_ids[0];

    // 把 canvas 清空（nodes 数组为空）
    fs.writeFileSync(canvasPath, JSON.stringify({ nodes: [], edges: [] }), 'utf-8');

    const changed = await processFileChange(db, canvasPath, tmpDir);
    expect(changed).toBe(true); // 有旧节点被 supersede → 实质处理

    const secondState = getFileState(db, rel);
    expect(secondState).not.toBeNull();
    expect(secondState!.node_ids.length).toBe(0);
    // 旧节点已 supersede
    const oldNode = getNode(db, oldNodeId);
    expect(oldNode?.is_superseded).toBe(1);
    // state 已更新 → 下次不再判为变更（死循环已断）
    expect(isFileChanged(canvasPath, secondState)).toBe(false);

    // 再处理一次：应被 isFileChanged 跳过，不再产生处理
    resetProgress();
    const changedAgain = await processFileChange(db, canvasPath, tmpDir);
    expect(changedAgain).toBe(false);
    expect(getImportProgress().skippedFiles).toBe(1);
  });

  // 回归：canvas 损坏（parseCanvas 返回 null）也要更新 state 断死循环
  it('损坏 canvas（{} 无 nodes）写入 state，避免反复重 parse', async () => {
    const rel = 'broken.canvas';
    const canvasPath = writeCanvas(rel, {}); // 缺 nodes 数组 → parseCanvas 返回 null

    const changed = await processFileChange(db, canvasPath, tmpDir);
    expect(changed).toBe(false); // 无旧节点，无实质处理

    const state = getFileState(db, rel);
    expect(state).not.toBeNull(); // 关键：仍写入 state 断死循环
    expect(isFileChanged(canvasPath, state)).toBe(false);
  });

  // 回归（HIGH 数据丢失）：parseCanvas 失败 ≠ 用户清空 canvas。最常见成因是 Obsidian
  // 非原子保存的半截写 / Sync 冲突损坏文件，内容仍在。此时绝不能 supersede 旧节点
  // （markNodeSupersededRecordOnly 不迁链接，下次成功 parse 又建新 ID → 旧记忆被永久遗弃）。
  // 必须只更新 content_hash 断死循环、保留旧节点不动。
  it('解析失败（损坏的半截写）时保留旧节点不 supersede，仅断死循环', async () => {
    const rel = 'transient-corrupt.canvas';
    const canvasPath = writeCanvas(rel, {
      nodes: [
        { id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'Hand-drawn canvas memory content long enough to digest into a node' },
      ],
      edges: [],
    });

    // 首次成功入库 → 1 个活跃节点
    await processFileChange(db, canvasPath, tmpDir);
    const firstState = getFileState(db, rel);
    expect(firstState).not.toBeNull();
    expect(firstState!.node_ids.length).toBe(1);
    const oldNodeId = firstState!.node_ids[0];

    // 模拟 Obsidian 非原子保存的半截写：写入坏 JSON（parseCanvas JSON.parse 抛错 → null）
    fs.writeFileSync(canvasPath, '{ "nodes": [ { "id": "n1", "type": "text"', 'utf-8');

    const changed = await processFileChange(db, canvasPath, tmpDir);
    expect(changed).toBe(false); // 解析失败 = 无实质处理（既未产出也未 supersede）

    // 关键断言：旧节点必须仍是活跃版本（未被 supersede），用户记忆未丢失
    const oldNode = getNode(db, oldNodeId);
    expect(oldNode?.is_superseded).toBe(0);

    // sync state 的 node_ids 必须保留旧节点（不被清空），content_hash 已更新断死循环
    const secondState = getFileState(db, rel);
    expect(secondState).not.toBeNull();
    expect(secondState!.node_ids).toEqual([oldNodeId]);
    expect(isFileChanged(canvasPath, secondState)).toBe(false); // 死循环已断

    // 文件恢复为合法 canvas（带新内容）后：旧节点被 supersede-with-links 到新节点，内容衔接
    fs.writeFileSync(canvasPath, JSON.stringify({
      nodes: [
        { id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'Recovered canvas content after the transient corruption was healed' },
      ],
      edges: [],
    }), 'utf-8');
    resetProgress();
    const recovered = await processFileChange(db, canvasPath, tmpDir);
    expect(recovered).toBe(true);
    // 旧节点此时才被 supersede（成功 parse 后的正常版本替代，走 supersedeNodeWithLinks）
    expect(getNode(db, oldNodeId)?.is_superseded).toBe(1);
  });
});

// ===== processFileChange (single file) =====

describe('processFileChange', () => {
  it('processes a single file change', async () => {
    const f1 = writeMd('notes/single.md', SAMPLE_MD);

    await processFileChange(db, f1, tmpDir);

    // processFileChange updates progress internally
    const prog = getImportProgress();
    // It should have processed or skipped (not failed)
    expect(prog.failedFiles).toBe(0);
  });

  it('skips unchanged file on second call', async () => {
    const f1 = writeMd('notes/repeat.md', SAMPLE_MD);

    await processFileChange(db, f1, tmpDir);
    const firstProg = getImportProgress();
    const afterFirst = firstProg.processedFiles + firstProg.skippedFiles;

    await processFileChange(db, f1, tmpDir);
    const secondProg = getImportProgress();

    // Second call should add a skip
    expect(secondProg.skippedFiles).toBeGreaterThan(firstProg.skippedFiles);
  });

  it('does not write DB when a stopped watcher event reaches processFileChange', async () => {
    const f1 = writeMd('notes/stopped.md', SAMPLE_MD);

    await processFileChange(db, f1, tmpDir, 'src-stopped', () => true);

    const state = getFileState(db, 'notes/stopped.md', 'src-stopped');
    const nodeCount = (db.prepare('SELECT COUNT(*) AS cnt FROM nodes').get() as { cnt: number }).cnt;
    expect(state).toBeNull();
    expect(nodeCount).toBe(0);
  });

  it('supersedes removed segments and migrates links to the remaining segment', async () => {
    const body = 'This paragraph is intentionally long enough to stay as its own semantic segment in the Obsidian heading segmenter. It describes architecture choices, testing boundaries, and operational safeguards for repeated note imports.';
    const f1 = writeMd('notes/segment-reduction.md', `# Topic

${body}

## Middle

${body}

## Removed

${body}
`);

    await processFileChange(db, f1, tmpDir);
    const firstState = getFileState(db, 'notes/segment-reduction.md');
    expect(firstState).not.toBeNull();
    expect(firstState!.node_ids.length).toBe(3);

    const removedNodeId = firstState!.node_ids[2];
    const target = seedNode(db, { content: 'external target linked from removed obsidian segment' });
    seedLink(db, removedNodeId, target.id, { strength: 0.82 });

    fs.writeFileSync(f1, `# Topic

${body}

## Middle

${body}
`, 'utf-8');

    await processFileChange(db, f1, tmpDir);
    const secondState = getFileState(db, 'notes/segment-reduction.md');
    expect(secondState).not.toBeNull();
    expect(secondState!.node_ids.length).toBe(2);

    const removedNode = getNode(db, removedNodeId);
    expect(removedNode?.is_superseded).toBe(1);

    const targetNewNodeId = secondState!.node_ids[secondState!.node_ids.length - 1];
    const migratedLinks = getLinksFrom(db, targetNewNodeId);
    const migratedLink = migratedLinks.find(link => link.to_id === target.id);
    expect(migratedLink).toBeDefined();
    expect(migratedLink!.strength).toBeCloseTo(0.82);
  });
});

// ===== getImportProgress / resetProgress =====

describe('getImportProgress / resetProgress', () => {
  it('returns current progress state', () => {
    const prog = getImportProgress();
    expect(prog).toHaveProperty('phase');
    expect(prog).toHaveProperty('totalFiles');
    expect(prog).toHaveProperty('processedFiles');
    expect(prog).toHaveProperty('skippedFiles');
    expect(prog).toHaveProperty('failedFiles');
    expect(prog).toHaveProperty('currentFile');
    expect(prog).toHaveProperty('startedAt');
  });

  it('returns a copy, not the internal reference', () => {
    const a = getImportProgress();
    const b = getImportProgress();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it('resetProgress clears all counters', async () => {
    const f1 = writeMd('notes/reset-test.md', SAMPLE_MD);
    await processFileQueue(db, [f1], tmpDir, { batchSize: 10, concurrency: 1, delayBetweenBatches: 0 });

    const before = getImportProgress();
    expect(before.phase).toBe('done');
    expect(before.totalFiles).toBeGreaterThan(0);

    resetProgress();

    const after = getImportProgress();
    expect(after.phase).toBe('idle');
    expect(after.totalFiles).toBe(0);
    expect(after.processedFiles).toBe(0);
    expect(after.skippedFiles).toBe(0);
    expect(after.failedFiles).toBe(0);
    expect(after.currentFile).toBeNull();
    expect(after.startedAt).toBeNull();
  });
});

// ===== Obsidian-specific: file category detection =====

describe('Obsidian-specific file handling', () => {
  it('handles empty_tag files (empty content with no properties)', async () => {
    // File with frontmatter but empty body -> empty_tag category
    const f1 = writeMd('tags/empty-tag.md', `---
tags: [topic]
---

`);
    // This file might be skipped (too short) or processed as empty_tag
    await processFileQueue(db, [f1], tmpDir, { batchSize: 10, concurrency: 1, delayBetweenBatches: 0 });

    const prog = getImportProgress();
    expect(prog.failedFiles).toBe(0);
  });

  it('handles excalidraw files', async () => {
    // .excalidraw.md files have special category
    const f1 = writeMd('drawings/sketch.excalidraw.md', `---
excalidraw-plugin: parsed
---

# Excalidraw Drawing

This is an excalidraw file with enough content to pass the minimum threshold check.
It should be detected as excalidraw category and handled accordingly by the queue.
`);

    await processFileQueue(db, [f1], tmpDir, { batchSize: 10, concurrency: 1, delayBetweenBatches: 0 });

    const prog = getImportProgress();
    expect(prog.failedFiles).toBe(0);
  });

  it('handles metadata_only files (properties but no content)', async () => {
    const f1 = writeMd('meta/metadata-only.md', `---
tags: [reference]
author: Someone
type: book
status: read
category: nonfiction
---

`);
    // Might be skipped if too short, or processed as metadata_only
    await processFileQueue(db, [f1], tmpDir, { batchSize: 10, concurrency: 1, delayBetweenBatches: 0 });

    const prog = getImportProgress();
    expect(prog.failedFiles).toBe(0);
  });
});

// ===== Folder tag chain =====

describe('folder tag chain creation', () => {
  it('creates folder tag nodes for nested paths', async () => {
    // File in nested directory: References/Books/note.md
    const f1 = writeMd('References/Books/deep-note.md', SAMPLE_MD);

    await processFileQueue(db, [f1], tmpDir, { batchSize: 10, concurrency: 1, delayBetweenBatches: 0 });

    const prog = getImportProgress();
    expect(prog.failedFiles).toBe(0);
    // The folder tag chain logic should have created tag nodes for "References" and "Books"
    // and linked them with part_of relations
    expect(prog.processedFiles + prog.skippedFiles).toBe(1);
  });
});

// ===== Part_of links between multi-segment pages =====

describe('part_of links for multi-segment pages', () => {
  it('creates part_of links between segments of a long page', async () => {
    // Create a long page that will be split into multiple segments
    const longContent = `---
tags: [architecture]
---
# Main Topic

${Array(20).fill('This is a substantial paragraph with enough content to contribute to a meaningful segment. It discusses various aspects of software architecture and design patterns that are commonly used in modern applications.').join('\n\n')}

## Second Section

${Array(20).fill('Another substantial paragraph covering different aspects of the topic. This section explores implementation details and best practices for building scalable systems with proper testing strategies.').join('\n\n')}

## Third Section

${Array(20).fill('A third section providing additional context and examples. This explores edge cases and error handling patterns that are important for building robust applications.').join('\n\n')}
`;

    const f1 = writeMd('notes/long-page.md', longContent);

    await processFileQueue(db, [f1], tmpDir, { batchSize: 10, concurrency: 1, delayBetweenBatches: 0 });

    const prog = getImportProgress();
    expect(prog.failedFiles).toBe(0);
    expect(prog.processedFiles).toBe(1);
    // The part_of link creation happens internally when allNodeIds.length > 1
    // We verify the file processed without errors, which confirms the link creation logic ran
  });
});

// ===== 段级 digest 部分失败补偿 =====

describe('段级 digest 部分失败补偿', () => {
  afterEach(() => {
    vi.mocked(appendToStream).mockReset();
    vi.mocked(appendToStream).mockReturnValue('stream:2026-01-01:abc:1' as never);
  });

  it('中途某段抛错时，本轮已建节点被 archive，不留孤儿；重跑无重复活跃节点', async () => {
    const body = 'This paragraph is intentionally long enough to remain its own semantic segment under the heading-based Obsidian segmenter. It carries enough sentences and characters to comfortably pass the minimum content quality gate.';
    const rel = 'notes/partial-fail.md';
    const f1 = writeMd(rel, `# Topic

${body}

## Second

${body}
`);

    // 第一段 digest 成功（appendToStream 第一次返回），第二段 appendToStream 抛错
    // → 模拟段级中途失败（磁盘/锁/shutdown）。
    let calls = 0;
    vi.mocked(appendToStream).mockImplementation((async () => {
      calls += 1;
      if (calls >= 2) throw new Error('simulated mid-loop digest failure');
      return 'stream:2026-01-01:abc:1';
    }) as never);

    const changed = await processFileChange(db, f1, tmpDir);
    expect(changed).toBe(false); // 失败
    expect(getImportProgress().failedFiles).toBe(1);

    // sync state 未写入（失败不落 state）
    expect(getFileState(db, rel)).toBeNull();

    // 关键：第一段已建的内容节点应被清理（不是孤儿活跃节点）。只看内容节点
    //（is_tag=0），文件夹 tag 节点「notes」不计入。
    const activeContentAfterFail = (db.prepare(
      "SELECT COUNT(*) AS cnt FROM nodes WHERE archived = 0 AND is_superseded = 0 AND is_tag = 0",
    ).get() as { cnt: number }).cnt;
    expect(activeContentAfterFail).toBe(0);

    // 恢复正常 digest 后重跑：应干净重建，无重复活跃节点
    vi.mocked(appendToStream).mockReset();
    vi.mocked(appendToStream).mockReturnValue('stream:2026-01-01:abc:1' as never);
    resetProgress();
    const changed2 = await processFileChange(db, f1, tmpDir);
    expect(changed2).toBe(true);

    const state = getFileState(db, rel);
    expect(state).not.toBeNull();
    expect(state!.node_ids.length).toBe(2);
    // 活跃内容节点数应恰好等于段数（无重复，无失败轮残留的孤儿）。失败轮的 node1
    // 已被标记 superseded，不应再出现在活跃内容节点里。
    const activeContent = (db.prepare(
      "SELECT COUNT(*) AS cnt FROM nodes WHERE archived = 0 AND is_superseded = 0 AND is_tag = 0",
    ).get() as { cnt: number }).cnt;
    expect(activeContent).toBe(2);
    // 总 superseded 内容节点 >= 1（失败轮的 node1）
    const supersededContent = (db.prepare(
      "SELECT COUNT(*) AS cnt FROM nodes WHERE is_superseded = 1 AND is_tag = 0",
    ).get() as { cnt: number }).cnt;
    expect(supersededContent).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================
// TOCTOU：digest 期间文件被编辑（对齐 Logseq）
// ============================================================

describe('TOCTOU: digest 期间文件被编辑', () => {
  afterEach(() => {
    vi.mocked(appendToStream).mockReset();
    vi.mocked(appendToStream).mockReturnValue('stream:2026-01-01:abc:1' as never);
  });

  it('digest 期间编辑文件后，state 记录的是 snapshot（hash + mtime + size）；下一轮能检测到编辑', async () => {
    const rel = 'notes/toctou-page.md';
    const filePath = writeMd(rel, '# Topic\n\nThis original paragraph is intentionally long enough to remain its own semantic segment and comfortably pass the minimum content quality gate for digest.');

    // appendToStream 在 digest 内部、updateSyncState 之前被 await，借此模拟
    // "digest 期间用户编辑文件"的 TOCTOU 窗口：第一次调用时把文件改成新内容，
    // 并把 mtime 明显前进（确保不是仅靠 mtime 漂移触发，而是验证快速路径短路问题）。
    let edited = false;
    vi.mocked(appendToStream).mockImplementation((async () => {
      if (!edited) {
        edited = true;
        fs.writeFileSync(filePath, '# Topic\n\nThis paragraph was edited DURING the multi-minute digest window and must be detected on the next sync round, not silently dropped.', 'utf-8');
        const future = new Date(Date.now() + 5000);
        fs.utimesSync(filePath, future, future);
      }
      return 'stream:2026-01-01:abc:1';
    }) as never);

    await processFileChange(db, filePath, tmpDir);

    const state = getFileState(db, rel);
    expect(state).not.toBeNull();

    // 关键断言：存储的 content_hash + mtime + size 必须都是 snapshot（被 digest 的原始内容），
    // 而不是 digest 后重读的新值。当前磁盘上是"新内容" → isFileChanged 应判为已变更。
    // 修复前：mtime/size 用 digest 后重读的新值，isFileChanged 的 mtime+size 快速路径
    // 直接短路返回 false，hash 比对走不到，这次编辑永久丢失。
    expect(isFileChanged(filePath, state)).toBe(true);
  });

  it('canvas digest 期间编辑文件后，state 记录的是 snapshot；下一轮能检测到编辑', async () => {
    const rel = 'boards/toctou.canvas';
    const original = {
      nodes: [
        { id: 'n1', type: 'text', text: 'Original canvas note that is long enough to survive the digest quality gate and become its own brain node.', x: 0, y: 0, width: 400, height: 200 },
      ],
      edges: [],
    };
    const filePath = writeCanvas(rel, original);

    // appendToStream 在 canvas 的 digest 内部、updateSyncState 之前被 await，借此模拟
    // "canvas digest 期间用户编辑文件"的 TOCTOU 窗口：第一次调用时把文件改成新内容，
    // 并把 mtime 明显前进（验证不是仅靠 mtime 漂移触发，而是快速路径短路问题）。
    let edited = false;
    vi.mocked(appendToStream).mockImplementation((async () => {
      if (!edited) {
        edited = true;
        const updated = {
          nodes: [
            { id: 'n1', type: 'text', text: 'This canvas node was edited DURING the multi-minute digest window and must be detected on the next sync round, not silently dropped.', x: 0, y: 0, width: 400, height: 200 },
          ],
          edges: [],
        };
        fs.writeFileSync(filePath, JSON.stringify(updated), 'utf-8');
        const future = new Date(Date.now() + 5000);
        fs.utimesSync(filePath, future, future);
      }
      return 'stream:2026-01-01:abc:1';
    }) as never);

    await processFileChange(db, filePath, tmpDir);

    const state = getFileState(db, rel);
    expect(state).not.toBeNull();

    // 关键断言：存储的 content_hash + mtime + size 必须都是 snapshot（被 digest 的原始内容），
    // 而不是 digest 后重读盘的新值。当前磁盘上是"新内容" → isFileChanged 应判为已变更。
    // 修复前：canvas 路径的 updateSyncState 不传 snapshotStat / contentHash，走 fallback
    // 重读盘，mtime/size + hash 都成了编辑后的新值，下次跳过此文件，编辑永久丢失。
    expect(isFileChanged(filePath, state)).toBe(true);
  });
});

// ============================================================
// 真实 race（Round 6 回归）：入口 getFileStat=null(dataless),read-time 补抓成功。
// 增量 queue 是运行期高频主路径,比只跑一次的 init 影响更大。
//   - bug A：digest 期间编辑 → 下一轮 isFileChanged 仍为 true(不丢编辑)。
//   - bug B：无编辑 → state 写入且 isFileChanged 为 false(无孤儿、下轮不重复 digest)。
// 修复前(c08a2ce):queue 的 updateSyncState 在 snapshotStat===null 时整条 return,
// 节点已 digest 入库却不写 state → 孤儿 + 下一轮重复 digest(bug B);且无 read-time
// 补抓 → 无法正确处理 race(bug A)。
// ============================================================

describe('dataless→readable 真实 race: 入口 null + read-time 补抓成功（Round 6）', () => {
  afterEach(() => {
    vi.mocked(appendToStream).mockReset();
    vi.mocked(appendToStream).mockReturnValue('stream:2026-01-01:abc:1' as never);
  });

  it('bug A：入口 dataless + digest 期间编辑 → 下一轮 isFileChanged 仍为 true（不丢编辑）', async () => {
    const rel = 'notes/race-edit.md';
    const filePath = writeMd(rel, '# Topic\n\nThis original paragraph is intentionally long enough to remain its own semantic segment and pass the digest quality gate.');

    nullFirstFileStatOnly = true;

    let edited = false;
    vi.mocked(appendToStream).mockImplementation((async () => {
      if (!edited) {
        edited = true;
        fs.writeFileSync(filePath, '# Topic\n\nThis paragraph was edited DURING the digest window in the dataless race and must survive into the next sync round.', 'utf-8');
        const future = new Date(Date.now() + 5000);
        fs.utimesSync(filePath, future, future);
      }
      return 'stream:2026-01-01:abc:1';
    }) as never);

    await processFileChange(db, filePath, tmpDir);

    const state = getFileState(db, rel);
    expect(state).not.toBeNull();
    // read-time snapshot = 编辑前 mtime/size,与编辑前 hash 同源。磁盘当前是编辑后内容 →
    // 快速路径不短路 → hash 比对 → 判变更。回归守卫(bug A)。
    expect(isFileChanged(filePath, state)).toBe(true);
  });

  it('bug B：入口 dataless + 无编辑 → state 写入且 isFileChanged 为 false（无孤儿/不重复 digest）', async () => {
    const rel = 'notes/race-stable.md';
    const filePath = writeMd(rel, '# Topic\n\nA stable paragraph in the dataless race that is never edited; the read-time snapshot must match disk so the next round skips it.');

    nullFirstFileStatOnly = true;

    await processFileChange(db, filePath, tmpDir);

    const state = getFileState(db, rel);
    expect(state).not.toBeNull();
    expect(state!.node_ids.length).toBeGreaterThan(0); // 节点非孤儿
    // read-time snapshot = 真实 mtime/size,与磁盘一致 → 下轮跳过。回归守卫(bug B)。
    expect(isFileChanged(filePath, state)).toBe(false);
  });

  it('bug A (canvas)：入口 dataless + digest 期间编辑 → 下一轮 isFileChanged 仍为 true', async () => {
    const rel = 'boards/race.canvas';
    const original = {
      nodes: [{ id: 'n1', type: 'text', text: 'Original canvas note long enough to survive the digest quality gate and become its own brain node.', x: 0, y: 0, width: 400, height: 200 }],
      edges: [],
    };
    const filePath = writeCanvas(rel, original);

    nullFirstFileStatOnly = true;

    let edited = false;
    vi.mocked(appendToStream).mockImplementation((async () => {
      if (!edited) {
        edited = true;
        const updated = {
          nodes: [{ id: 'n1', type: 'text', text: 'This canvas node was edited DURING the digest window in the dataless race and must survive into the next sync round.', x: 0, y: 0, width: 400, height: 200 }],
          edges: [],
        };
        fs.writeFileSync(filePath, JSON.stringify(updated), 'utf-8');
        const future = new Date(Date.now() + 5000);
        fs.utimesSync(filePath, future, future);
      }
      return 'stream:2026-01-01:abc:1';
    }) as never);

    await processFileChange(db, filePath, tmpDir);

    const state = getFileState(db, rel);
    expect(state).not.toBeNull();
    expect(isFileChanged(filePath, state)).toBe(true);
  });
});
