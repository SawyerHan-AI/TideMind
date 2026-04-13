/**
 * apple-notes/sync-state.ts 单元测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  getNoteState,
  setNoteState,
  removeNoteState,
  getAllNoteStates,
  removeStaleNotes,
  hasCompletedFullScan,
  markFullScanCompleted,
  resetFullScanState,
  isNoteChanged,
  computeContentHash,
} from '../../../src/integrations/apple-notes/sync-state.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
  ensureSyncSchema(db);
});

afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
});

describe('ensureSyncSchema', () => {
  it('创建 apple_notes_sync 表', () => {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='apple_notes_sync'",
    ).get();
    expect(row).toBeTruthy();
  });

  it('表结构包含所有必需字段', () => {
    const columns = db.pragma('table_info(apple_notes_sync)') as Array<{ name: string }>;
    const colNames = columns.map(c => c.name).sort();
    expect(colNames).toContain('note_uuid');
    expect(colNames).toContain('modification_date');
    expect(colNames).toContain('content_hash');
    expect(colNames).toContain('last_synced');
    expect(colNames).toContain('node_ids');
    expect(colNames).toContain('source_id');
  });
});

describe('setNoteState / getNoteState', () => {
  it('写入后能读取', () => {
    const state = {
      note_uuid: 'uuid-1',
      modification_date: 1000,
      content_hash: 'hash1',
      last_synced: '2026-04-09T00:00:00Z',
      node_ids: ['n1', 'n2'],
      source_id: 'src1',
    };
    setNoteState(db, state);

    const loaded = getNoteState(db, 'uuid-1', 'src1');
    expect(loaded).toEqual(state);
  });

  it('未存在的 uuid 返回 null', () => {
    expect(getNoteState(db, 'nonexistent')).toBeNull();
  });

  it('INSERT OR REPLACE 正确更新记录', () => {
    setNoteState(db, {
      note_uuid: 'uuid-1', modification_date: 1000, content_hash: 'h1',
      last_synced: '2026-04-09', node_ids: ['n1'], source_id: 'src1',
    });
    setNoteState(db, {
      note_uuid: 'uuid-1', modification_date: 2000, content_hash: 'h2',
      last_synced: '2026-04-10', node_ids: ['n2', 'n3'], source_id: 'src1',
    });

    const loaded = getNoteState(db, 'uuid-1', 'src1');
    expect(loaded?.modification_date).toBe(2000);
    expect(loaded?.content_hash).toBe('h2');
    expect(loaded?.node_ids).toEqual(['n2', 'n3']);
  });
});

describe('isNoteChanged', () => {
  it('没有同步状态 → 视为变更', () => {
    expect(isNoteChanged(1000, 'hash1', null)).toBe(true);
  });

  it('modification_date 相同 → 未变更', () => {
    const state = {
      note_uuid: 'u', modification_date: 1000, content_hash: 'h',
      last_synced: '', node_ids: [], source_id: '',
    };
    expect(isNoteChanged(1000, 'h', state)).toBe(false);
  });

  it('modification_date 不同但 hash 相同 → 未变更', () => {
    const state = {
      note_uuid: 'u', modification_date: 1000, content_hash: 'h',
      last_synced: '', node_ids: [], source_id: '',
    };
    expect(isNoteChanged(2000, 'h', state)).toBe(false);
  });

  it('modification_date 不同且 hash 不同 → 变更', () => {
    const state = {
      note_uuid: 'u', modification_date: 1000, content_hash: 'h1',
      last_synced: '', node_ids: [], source_id: '',
    };
    expect(isNoteChanged(2000, 'h2', state)).toBe(true);
  });
});

describe('removeStaleNotes', () => {
  it('清理已不存在的笔记并返回 orphan node_ids', () => {
    setNoteState(db, {
      note_uuid: 'uuid-1', modification_date: 1000, content_hash: 'h1',
      last_synced: '', node_ids: ['n1', 'n2'], source_id: 'src1',
    });
    setNoteState(db, {
      note_uuid: 'uuid-2', modification_date: 2000, content_hash: 'h2',
      last_synced: '', node_ids: ['n3'], source_id: 'src1',
    });

    const currentUuids = new Set(['uuid-1']); // uuid-2 已不存在
    const result = removeStaleNotes(db, currentUuids, 'src1');

    expect(result.removed).toBe(1);
    expect(result.orphanNodeIds).toContain('n3');
    expect(getNoteState(db, 'uuid-1', 'src1')).toBeTruthy();
    expect(getNoteState(db, 'uuid-2', 'src1')).toBeNull();
  });
});

describe('全量扫描标记', () => {
  it('hasCompletedFullScan 初始为 false', () => {
    expect(hasCompletedFullScan(db, 'src1')).toBe(false);
  });

  it('markFullScanCompleted 后变为 true', () => {
    markFullScanCompleted(db, 'src1');
    expect(hasCompletedFullScan(db, 'src1')).toBe(true);
  });

  it('resetFullScanState 重置为 false', () => {
    markFullScanCompleted(db, 'src1');
    resetFullScanState(db, 'src1');
    expect(hasCompletedFullScan(db, 'src1')).toBe(false);
  });

  it('不同 sourceId 独立', () => {
    markFullScanCompleted(db, 'src1');
    expect(hasCompletedFullScan(db, 'src1')).toBe(true);
    expect(hasCompletedFullScan(db, 'src2')).toBe(false);
  });
});

describe('computeContentHash', () => {
  it('相同内容产生相同 hash', () => {
    expect(computeContentHash('hello')).toBe(computeContentHash('hello'));
  });

  it('不同内容产生不同 hash', () => {
    expect(computeContentHash('hello')).not.toBe(computeContentHash('world'));
  });

  it('hash 长度为 16', () => {
    expect(computeContentHash('test').length).toBe(16);
  });
});
