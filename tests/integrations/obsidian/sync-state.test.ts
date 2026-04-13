/**
 * sync-state.ts (Obsidian) 单元测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../../src/strategy/loader.js', () => ({
  getParam: () => 0,
  loadStrategies: () => {},
}));

vi.mock('../../../src/config.js', () => ({
  getConfig: () => ({
    general: { data_dir: '/tmp/test-eb' },
    anthropic: { api_key: '' },
    vertex: { project_id: '', region: '' },
    ollama: { url: '' },
    gemini: { api_key: '' },
    llm: { provider: 'anthropic', standard_model: '', heavy_model: '' },
    embedding: { provider: 'vertex', model: '', dimensions: 3072 },
    search: {},
    gates: {},
    metabolism: {},
  }),
  isLlmConfigured: () => false,
}));

import type Database from 'better-sqlite3';
import { setupTestDb } from '../../helpers/test-db.js';
import {
  ensureSyncSchema,
  getFileState,
  setFileState,
  getAllFileStates,
  removeStaleFiles,
  hasCompletedFullScan,
  markFullScanCompleted,
  resetFullScanState,
  isFileChanged,
  computeFileHash,
} from '../../../src/integrations/obsidian/sync-state.js';

let db: Database.Database;
let tmpDir: string;

beforeEach(() => {
  db = setupTestDb();
  ensureSyncSchema(db);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-ob-sync-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ===== Schema =====

describe('ensureSyncSchema', () => {
  it('创建 obsidian_sync 表', () => {
    // 表已在 beforeEach 中创建，验证可以插入数据
    db.prepare(
      `INSERT INTO obsidian_sync (file_path, content_hash, mtime, size, last_synced) VALUES (?, ?, ?, ?, ?)`,
    ).run('/test', 'hash', 1000, 100, '2024-01-01');

    const row = db.prepare('SELECT * FROM obsidian_sync WHERE file_path = ?').get('/test');
    expect(row).toBeDefined();
  });
});

// ===== CRUD =====

describe('sync state CRUD', () => {
  it('setFileState + getFileState 往返', () => {
    const state = {
      file_path: '/vault/note.md',
      content_hash: 'abc123def456',
      mtime: 1700000000,
      size: 2048,
      last_synced: '2024-06-15T12:00:00Z',
      node_ids: ['n1', 'n2'],
    };

    setFileState(db, state);
    const got = getFileState(db, '/vault/note.md');
    expect(got).toEqual(state);
  });

  it('新文件无状态 → 返回 null', () => {
    expect(getFileState(db, '/nonexistent')).toBeNull();
  });

  it('getAllFileStates 返回所有记录的 Map', () => {
    setFileState(db, { file_path: '/a.md', content_hash: 'h1', mtime: 1, size: 10, last_synced: 't', node_ids: [] });
    setFileState(db, { file_path: '/b.md', content_hash: 'h2', mtime: 2, size: 20, last_synced: 't', node_ids: ['x'] });

    const all = getAllFileStates(db);
    expect(all.size).toBe(2);
    expect(all.has('/a.md')).toBe(true);
    expect(all.get('/b.md')!.node_ids).toEqual(['x']);
  });
});

// ===== removeStaleFiles =====

describe('removeStaleFiles', () => {
  it('清理不在当前文件集中的记录', () => {
    setFileState(db, { file_path: '/keep.md', content_hash: 'h', mtime: 1, size: 10, last_synced: 't', node_ids: [] });
    setFileState(db, { file_path: '/stale.md', content_hash: 'h', mtime: 1, size: 10, last_synced: 't', node_ids: [] });

    const result = removeStaleFiles(db, new Set(['/keep.md']));
    expect(result.removed).toBe(1);
    expect(getFileState(db, '/keep.md')).not.toBeNull();
    expect(getFileState(db, '/stale.md')).toBeNull();
  });

  it('返回被清理文件的 orphanNodeIds', () => {
    setFileState(db, { file_path: '/keep.md', content_hash: 'h', mtime: 1, size: 10, last_synced: 't', node_ids: ['n1'] });
    setFileState(db, { file_path: '/gone.md', content_hash: 'h', mtime: 1, size: 10, last_synced: 't', node_ids: ['n2', 'n3'] });

    const result = removeStaleFiles(db, new Set(['/keep.md']));
    expect(result.removed).toBe(1);
    expect(result.orphanNodeIds).toEqual(['n2', 'n3']);
  });
});

// ===== isFileChanged =====

describe('isFileChanged', () => {
  it('无 syncState（新文件） → true', () => {
    const fp = path.join(tmpDir, 'new.md');
    fs.writeFileSync(fp, 'new content');
    expect(isFileChanged(fp, null)).toBe(true);
  });

  it('mtime + size 相同 → false', () => {
    const fp = path.join(tmpDir, 'unchanged.md');
    fs.writeFileSync(fp, 'content');
    const stat = fs.statSync(fp);

    expect(isFileChanged(fp, {
      file_path: fp,
      content_hash: 'whatever',
      mtime: Math.floor(stat.mtimeMs),
      size: stat.size,
      last_synced: 't',
      node_ids: [],
    })).toBe(false);
  });

  it('内容变化 → true', () => {
    const fp = path.join(tmpDir, 'changed.md');
    fs.writeFileSync(fp, 'original');
    const oldHash = computeFileHash(fp);
    fs.writeFileSync(fp, 'modified');

    expect(isFileChanged(fp, {
      file_path: fp,
      content_hash: oldHash,
      mtime: 0,
      size: 0,
      last_synced: 't',
      node_ids: [],
    })).toBe(true);
  });
});

// ===== fullScan 状态 =====

describe('fullScan 状态', () => {
  it('初始状态未完成', () => {
    expect(hasCompletedFullScan(db)).toBe(false);
  });

  it('标记完成后返回 true', () => {
    markFullScanCompleted(db);
    expect(hasCompletedFullScan(db)).toBe(true);
  });

  it('重置后返回 false', () => {
    markFullScanCompleted(db);
    resetFullScanState(db);
    expect(hasCompletedFullScan(db)).toBe(false);
  });
});

// ===== computeFileHash =====

describe('computeFileHash', () => {
  it('返回 16 字符 hex 且相同内容产生相同 hash', () => {
    const f1 = path.join(tmpDir, 'a.md');
    const f2 = path.join(tmpDir, 'b.md');
    fs.writeFileSync(f1, 'same content');
    fs.writeFileSync(f2, 'same content');

    const h1 = computeFileHash(f1);
    expect(h1).toHaveLength(16);
    expect(h1).toMatch(/^[a-f0-9]+$/);
    expect(h1).toBe(computeFileHash(f2));
  });

  it('不同内容产生不同 hash', () => {
    const f1 = path.join(tmpDir, 'x.md');
    const f2 = path.join(tmpDir, 'y.md');
    fs.writeFileSync(f1, 'hello');
    fs.writeFileSync(f2, 'world');

    expect(computeFileHash(f1)).not.toBe(computeFileHash(f2));
  });
});
