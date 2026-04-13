/**
 * sync-state.ts 单元测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  removeFileState,
  getAllFileStates,
  removeStaleFiles,
  hasCompletedFullScan,
  markFullScanCompleted,
  resetFullScanState,
  isFileChanged,
  computeFileHash,
} from '../../../src/integrations/logseq/sync-state.js';

let db: Database.Database;
let tmpDir: string;

beforeEach(() => {
  db = setupTestDb();
  ensureSyncSchema(db);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-sync-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ===== CRUD =====

describe('sync state CRUD', () => {
  it('新文件无状态 → 返回 null', () => {
    expect(getFileState(db, '/nonexistent')).toBeNull();
  });

  it('setFileState + getFileState 往返', () => {
    const state = {
      file_path: '/test/page.md',
      content_hash: 'abc123',
      mtime: 1234567890,
      size: 1024,
      last_synced: '2024-01-01T00:00:00Z',
      node_ids: ['node-1', 'node-2'],
    };

    setFileState(db, state);
    const got = getFileState(db, '/test/page.md');
    expect(got).toEqual(state);
  });

  it('removeFileState 删除记录', () => {
    setFileState(db, {
      file_path: '/test/page.md',
      content_hash: 'abc',
      mtime: 123,
      size: 100,
      last_synced: '2024-01-01',
      node_ids: [],
    });

    removeFileState(db, '/test/page.md');
    expect(getFileState(db, '/test/page.md')).toBeNull();
  });

  it('getAllFileStates 返回所有记录', () => {
    setFileState(db, { file_path: '/a', content_hash: 'h1', mtime: 1, size: 10, last_synced: 't', node_ids: [] });
    setFileState(db, { file_path: '/b', content_hash: 'h2', mtime: 2, size: 20, last_synced: 't', node_ids: [] });

    const all = getAllFileStates(db);
    expect(all.size).toBe(2);
    expect(all.has('/a')).toBe(true);
    expect(all.has('/b')).toBe(true);
  });
});

// ===== removeStaleFiles =====

describe('removeStaleFiles', () => {
  it('清理不在当前文件集中的记录', () => {
    setFileState(db, { file_path: '/existing', content_hash: 'h', mtime: 1, size: 10, last_synced: 't', node_ids: [] });
    setFileState(db, { file_path: '/deleted', content_hash: 'h', mtime: 1, size: 10, last_synced: 't', node_ids: [] });

    const result = removeStaleFiles(db, new Set(['/existing']));
    expect(result.removed).toBe(1);
    expect(getFileState(db, '/existing')).not.toBeNull();
    expect(getFileState(db, '/deleted')).toBeNull();
  });

  it('无过期记录时返回 0', () => {
    setFileState(db, { file_path: '/a', content_hash: 'h', mtime: 1, size: 10, last_synced: 't', node_ids: [] });
    const result = removeStaleFiles(db, new Set(['/a']));
    expect(result.removed).toBe(0);
  });

  it('返回被清理文件的 orphanNodeIds', () => {
    setFileState(db, { file_path: '/keep', content_hash: 'h', mtime: 1, size: 10, last_synced: 't', node_ids: ['n1'] });
    setFileState(db, { file_path: '/gone', content_hash: 'h', mtime: 1, size: 10, last_synced: 't', node_ids: ['n2', 'n3'] });

    const result = removeStaleFiles(db, new Set(['/keep']));
    expect(result.removed).toBe(1);
    expect(result.orphanNodeIds).toEqual(['n2', 'n3']);
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

// ===== isFileChanged =====

describe('isFileChanged', () => {
  it('无 syncState（新文件） → true', () => {
    const filePath = path.join(tmpDir, 'new.md');
    fs.writeFileSync(filePath, 'hello');
    expect(isFileChanged(filePath, null)).toBe(true);
  });

  it('文件不存在 → false（由 removeStaleFiles 处理）', () => {
    const fakePath = path.join(tmpDir, 'ghost.md');
    expect(isFileChanged(fakePath, {
      file_path: fakePath,
      content_hash: 'abc',
      mtime: 123,
      size: 10,
      last_synced: 't',
      node_ids: [],
    })).toBe(false);
  });

  it('mtime + size 相同 → false（快速路径）', () => {
    const filePath = path.join(tmpDir, 'unchanged.md');
    fs.writeFileSync(filePath, 'content');
    const stat = fs.statSync(filePath);

    const syncState = {
      file_path: filePath,
      content_hash: 'whatever',
      mtime: Math.floor(stat.mtimeMs),
      size: stat.size,
      last_synced: 't',
      node_ids: [],
    };

    expect(isFileChanged(filePath, syncState)).toBe(false);
  });

  it('mtime 不同但内容相同（hash 匹配） → false', () => {
    const filePath = path.join(tmpDir, 'same-content.md');
    fs.writeFileSync(filePath, 'same content');
    const hash = computeFileHash(filePath);

    const syncState = {
      file_path: filePath,
      content_hash: hash,
      mtime: 0, // 故意不同
      size: 999, // 故意不同
      last_synced: 't',
      node_ids: [],
    };

    expect(isFileChanged(filePath, syncState)).toBe(false);
  });

  it('内容真的变了 → true', () => {
    const filePath = path.join(tmpDir, 'changed.md');
    fs.writeFileSync(filePath, 'original content');
    const oldHash = computeFileHash(filePath);

    // 修改内容（但 hash 已记录旧值）
    fs.writeFileSync(filePath, 'modified content');

    const syncState = {
      file_path: filePath,
      content_hash: oldHash,
      mtime: 0,
      size: 0,
      last_synced: 't',
      node_ids: [],
    };

    expect(isFileChanged(filePath, syncState)).toBe(true);
  });
});

// ===== computeFileHash =====

describe('computeFileHash', () => {
  it('返回 16 字符的 hex 字符串', () => {
    const filePath = path.join(tmpDir, 'hashme.md');
    fs.writeFileSync(filePath, 'test content');

    const hash = computeFileHash(filePath);
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[a-f0-9]+$/);
  });

  it('相同内容产生相同 hash', () => {
    const file1 = path.join(tmpDir, 'a.md');
    const file2 = path.join(tmpDir, 'b.md');
    fs.writeFileSync(file1, 'same');
    fs.writeFileSync(file2, 'same');

    expect(computeFileHash(file1)).toBe(computeFileHash(file2));
  });

  it('不同内容产生不同 hash', () => {
    const file1 = path.join(tmpDir, 'x.md');
    const file2 = path.join(tmpDir, 'y.md');
    fs.writeFileSync(file1, 'hello');
    fs.writeFileSync(file2, 'world');

    expect(computeFileHash(file1)).not.toBe(computeFileHash(file2));
  });
});
