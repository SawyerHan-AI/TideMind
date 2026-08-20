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
  computeSegmentHash,
  getFileStat,
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
      segment_hashes: ['hash-1', 'hash-2'],
    };

    setFileState(db, state);
    const got = getFileState(db, '/test/page.md');
    expect(got).toEqual(state);
  });

  it('segment_hashes 缺失时回退为空数组', () => {
    // 模拟旧数据（无 segment_hashes 列值）
    db.prepare(`
      INSERT INTO logseq_sync (file_path, content_hash, mtime, size, last_synced, node_ids, source_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('/old/page.md', 'abc', 123, 100, '2024-01-01', '["n1"]', '');

    const got = getFileState(db, '/old/page.md');
    expect(got).not.toBeNull();
    expect(got!.segment_hashes).toEqual([]);
  });

  it('removeFileState 删除记录', () => {
    setFileState(db, {
      file_path: '/test/page.md',
      content_hash: 'abc',
      mtime: 123,
      size: 100,
      last_synced: '2024-01-01',
      node_ids: [],
      segment_hashes: [],
    });

    removeFileState(db, '/test/page.md');
    expect(getFileState(db, '/test/page.md')).toBeNull();
  });

  it('getAllFileStates 返回所有记录', () => {
    setFileState(db, { file_path: '/a', content_hash: 'h1', mtime: 1, size: 10, last_synced: 't', node_ids: [], segment_hashes: [] });
    setFileState(db, { file_path: '/b', content_hash: 'h2', mtime: 2, size: 20, last_synced: 't', node_ids: [], segment_hashes: [] });

    const all = getAllFileStates(db);
    expect(all.size).toBe(2);
    expect(all.has('/a')).toBe(true);
    expect(all.has('/b')).toBe(true);
  });
});

// ===== removeStaleFiles =====

describe('removeStaleFiles', () => {
  it('清理不在当前文件集中的记录', () => {
    setFileState(db, { file_path: '/existing', content_hash: 'h', mtime: 1, size: 10, last_synced: 't', node_ids: [], segment_hashes: [] });
    setFileState(db, { file_path: '/deleted', content_hash: 'h', mtime: 1, size: 10, last_synced: 't', node_ids: [], segment_hashes: [] });

    const result = removeStaleFiles(db, new Set(['/existing']));
    expect(result.removed).toBe(1);
    expect(getFileState(db, '/existing')).not.toBeNull();
    expect(getFileState(db, '/deleted')).toBeNull();
  });

  it('无过期记录时返回 0', () => {
    setFileState(db, { file_path: '/a', content_hash: 'h', mtime: 1, size: 10, last_synced: 't', node_ids: [], segment_hashes: [] });
    const result = removeStaleFiles(db, new Set(['/a']));
    expect(result.removed).toBe(0);
  });

  it('返回被清理文件的 orphanNodeIds', () => {
    setFileState(db, { file_path: '/keep', content_hash: 'h', mtime: 1, size: 10, last_synced: 't', node_ids: ['n1'], segment_hashes: ['sh1'] });
    setFileState(db, { file_path: '/gone', content_hash: 'h', mtime: 1, size: 10, last_synced: 't', node_ids: ['n2', 'n3'], segment_hashes: ['sh2', 'sh3'] });

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
  it('保留文件系统的亚毫秒mtime精度', () => {
    const filePath = path.join(tmpDir, 'precise-mtime.md');
    fs.writeFileSync(filePath, 'content');
    const desired = new Date(1_700_000_000_123.456);
    fs.utimesSync(filePath, desired, desired);
    const actual = fs.statSync(filePath).mtimeMs;
    const observed = getFileStat(filePath);
    expect(observed?.mtime).toBe(actual);
    if (!Number.isInteger(actual)) expect(observed?.mtime).not.toBe(Math.floor(actual));
  });

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
      segment_hashes: [],
    })).toBe(false);
  });

  it('mtime + size 相同且hash相同 → false', () => {
    const filePath = path.join(tmpDir, 'unchanged.md');
    fs.writeFileSync(filePath, 'content');
    const stat = fs.statSync(filePath);

    const syncState = {
      file_path: filePath,
      content_hash: computeFileHash(filePath)!,
      mtime: stat.mtimeMs,
      size: stat.size,
      last_synced: 't',
      node_ids: [],
      segment_hashes: [],
    };

    expect(isFileChanged(filePath, syncState)).toBe(false);
  });

  it('周期扫描可复用block索引同次读取的content hash', () => {
    const filePath = path.join(tmpDir, 'cached-hash.md');
    fs.writeFileSync(filePath, 'content');
    const stat = fs.statSync(filePath);
    const syncState = {
      file_path: filePath,
      content_hash: computeFileHash(filePath)!,
      mtime: stat.mtimeMs,
      size: stat.size,
      last_synced: 't',
      node_ids: [],
      segment_hashes: [],
    };
    expect(isFileChanged(filePath, syncState, syncState.content_hash)).toBe(false);
    expect(isFileChanged(filePath, syncState, 'different-scan-hash')).toBe(true);
  });

  it('mtime + size 相同但内容不同 → true', () => {
    const filePath = path.join(tmpDir, 'same-stat-different-content.md');
    fs.writeFileSync(filePath, 'AAAA');
    const originalStat = fs.statSync(filePath);
    const syncState = {
      file_path: filePath,
      content_hash: computeFileHash(filePath)!,
      mtime: originalStat.mtimeMs,
      size: originalStat.size,
      last_synced: 't',
      node_ids: [],
      segment_hashes: [],
    };
    fs.writeFileSync(filePath, 'BBBB');
    fs.utimesSync(filePath, originalStat.atime, originalStat.mtime);
    expect(fs.statSync(filePath).size).toBe(syncState.size);
    expect(isFileChanged(filePath, syncState)).toBe(true);
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
      segment_hashes: [],
    };

    expect(isFileChanged(filePath, syncState)).toBe(false);
  });

  it('dataless 回流后内容 hash 相同 → false，避免重复 digest', () => {
    const filePath = path.join(tmpDir, 'icloud-returned.md');
    fs.writeFileSync(filePath, 'same content after iCloud returns');
    const hash = computeFileHash(filePath);

    const syncState = {
      file_path: filePath,
      content_hash: hash,
      mtime: 1,
      size: 1,
      last_synced: 't',
      node_ids: ['existing-node'],
      segment_hashes: ['existing-segment'],
    };

    // iCloud 回流后 mtime/size 可能漂移，但内容没变时不能重新 digest。
    expect(isFileChanged(filePath, syncState)).toBe(false);
  });

  it('仅CRLF/LF形式和size变化但归一化hash相同 → false', () => {
    const filePath = path.join(tmpDir, 'eol-only.md');
    fs.writeFileSync(filePath, 'line one\nline two\n');
    const syncState = {
      file_path: filePath,
      content_hash: computeFileHash(filePath)!,
      mtime: fs.statSync(filePath).mtimeMs,
      size: fs.statSync(filePath).size,
      last_synced: 't',
      node_ids: [],
      segment_hashes: [],
    };
    fs.writeFileSync(filePath, 'line one\r\nline two\r\n');
    expect(fs.statSync(filePath).size).not.toBe(syncState.size);
    expect(isFileChanged(filePath, syncState)).toBe(false);
  });

  it('dataless 文件保留旧 sync state，不被当作变更覆盖', () => {
    const filePath = path.join(tmpDir, 'offline.md');
    fs.writeFileSync(filePath, 'offline content');
    const stat = fs.statSync(filePath);
    const statSpy = vi.spyOn(fs, 'statSync').mockReturnValue({
      ...stat,
      size: 128,
      blocks: 0,
    } as fs.Stats);

    try {
      expect(isFileChanged(filePath, {
        file_path: filePath,
        content_hash: 'old-hash',
        mtime: 1,
        size: 128,
        last_synced: 't',
        node_ids: ['existing-node'],
        segment_hashes: ['existing-segment'],
      })).toBe(false);
    } finally {
      statSpy.mockRestore();
    }
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
      segment_hashes: [],
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

// ===== composite PK: multiple source IDs =====

describe('composite PK (file_path, source_id)', () => {
  it('同一文件路径不同 source_id 互相独立', () => {
    setFileState(db, {
      file_path: '/shared/page.md',
      content_hash: 'hash-A',
      mtime: 100,
      size: 50,
      last_synced: '2024-01-01',
      node_ids: ['n1'],
      segment_hashes: [],
    }, 'source-A');

    setFileState(db, {
      file_path: '/shared/page.md',
      content_hash: 'hash-B',
      mtime: 200,
      size: 60,
      last_synced: '2024-02-01',
      node_ids: ['n2'],
      segment_hashes: [],
    }, 'source-B');

    const stateA = getFileState(db, '/shared/page.md', 'source-A');
    const stateB = getFileState(db, '/shared/page.md', 'source-B');

    expect(stateA).not.toBeNull();
    expect(stateB).not.toBeNull();
    expect(stateA!.content_hash).toBe('hash-A');
    expect(stateB!.content_hash).toBe('hash-B');
    expect(stateA!.node_ids).toEqual(['n1']);
    expect(stateB!.node_ids).toEqual(['n2']);
  });

  it('getAllFileStates 按 source_id 过滤', () => {
    setFileState(db, {
      file_path: '/a.md', content_hash: 'h1', mtime: 1, size: 10,
      last_synced: 't', node_ids: [], segment_hashes: [],
    }, 'src-1');
    setFileState(db, {
      file_path: '/b.md', content_hash: 'h2', mtime: 2, size: 20,
      last_synced: 't', node_ids: [], segment_hashes: [],
    }, 'src-2');
    setFileState(db, {
      file_path: '/c.md', content_hash: 'h3', mtime: 3, size: 30,
      last_synced: 't', node_ids: [], segment_hashes: [],
    }, 'src-1');

    const src1States = getAllFileStates(db, 'src-1');
    const src2States = getAllFileStates(db, 'src-2');

    expect(src1States.size).toBe(2);
    expect(src2States.size).toBe(1);
    expect(src1States.has('/a.md')).toBe(true);
    expect(src1States.has('/c.md')).toBe(true);
    expect(src2States.has('/b.md')).toBe(true);
  });

  it('removeFileState 按 source_id 精确删除', () => {
    setFileState(db, {
      file_path: '/x.md', content_hash: 'h', mtime: 1, size: 10,
      last_synced: 't', node_ids: [], segment_hashes: [],
    }, 'src-keep');
    setFileState(db, {
      file_path: '/x.md', content_hash: 'h', mtime: 1, size: 10,
      last_synced: 't', node_ids: [], segment_hashes: [],
    }, 'src-remove');

    removeFileState(db, '/x.md', 'src-remove');

    expect(getFileState(db, '/x.md', 'src-keep')).not.toBeNull();
    expect(getFileState(db, '/x.md', 'src-remove')).toBeNull();
  });

  it('removeStaleFiles 按 source_id 独立清理', () => {
    setFileState(db, {
      file_path: '/keep.md', content_hash: 'h', mtime: 1, size: 10,
      last_synced: 't', node_ids: [], segment_hashes: [],
    }, 'src-1');
    setFileState(db, {
      file_path: '/stale.md', content_hash: 'h', mtime: 1, size: 10,
      last_synced: 't', node_ids: ['n99'], segment_hashes: [],
    }, 'src-1');
    setFileState(db, {
      file_path: '/stale.md', content_hash: 'h', mtime: 1, size: 10,
      last_synced: 't', node_ids: ['n100'], segment_hashes: [],
    }, 'src-2');

    const result = removeStaleFiles(db, new Set(['/keep.md']), 'src-1');
    expect(result.removed).toBe(1);
    expect(result.orphanNodeIds).toEqual(['n99']);

    // src-2 的记录不受影响
    expect(getFileState(db, '/stale.md', 'src-2')).not.toBeNull();
  });

  it('fullScan 状态按 source_id 独立', () => {
    markFullScanCompleted(db, 'src-A');
    expect(hasCompletedFullScan(db, 'src-A')).toBe(true);
    expect(hasCompletedFullScan(db, 'src-B')).toBe(false);

    markFullScanCompleted(db, 'src-B');
    expect(hasCompletedFullScan(db, 'src-B')).toBe(true);

    resetFullScanState(db, 'src-A');
    expect(hasCompletedFullScan(db, 'src-A')).toBe(false);
    expect(hasCompletedFullScan(db, 'src-B')).toBe(true);
  });
});

// ===== computeSegmentHash =====

describe('computeSegmentHash', () => {
  it('返回 16 字符的 hex 字符串', () => {
    const hash = computeSegmentHash('test content');
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[a-f0-9]+$/);
  });

  it('相同内容产生相同 hash', () => {
    expect(computeSegmentHash('hello')).toBe(computeSegmentHash('hello'));
  });

  it('不同内容产生不同 hash', () => {
    expect(computeSegmentHash('hello')).not.toBe(computeSegmentHash('world'));
  });
});
