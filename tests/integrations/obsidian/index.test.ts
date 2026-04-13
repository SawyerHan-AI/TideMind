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

vi.mock('../../../src/db/log.js', () => ({
  logTimelineEvent: vi.fn(),
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
    gates: { vector_search: 50, graph_expansion: 20, graph_expansion_links: 10, crystal_generation: 100, divergent_scan: 200, learning_2_min_nodes: 30, learning_2_min_recall_ops: 10 },
    sources: {},
  }),
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

// ── Imports (after mocks) ────────────────────────────────────

import { setupTestDb, seedNode } from '../../helpers/test-db.js';
import { invalidateGateCache } from '../../../src/db/stats.js';
import { ensureSyncSchema, setFileState, removeStaleFiles } from '../../../src/integrations/obsidian/sync-state.js';
import { getNode } from '../../../src/db/nodes.js';
import {
  startObsidianIntegration,
  stopObsidianIntegration,
} from '../../../src/integrations/obsidian/index.js';

// ── Helpers ──────────────────────────────────────────────────

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
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
