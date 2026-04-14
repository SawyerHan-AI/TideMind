import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { setupTestDb } from '../../helpers/test-db.js';
import {
  getPageState,
  updatePageState,
  getAllPageStates,
  removePageState,
  getPageCount,
  addPendingRelation,
  getPendingRelationsForTarget,
  removePendingRelation,
  removePendingRelationsForSource,
  hasCompletedFullScan,
  markFullScanCompleted,
} from '../../../src/integrations/notion/sync-state.js';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
  // 创建 notion_sync 和 notion_pending_relations 表
  db.exec(`
    CREATE TABLE IF NOT EXISTS notion_sync (
      page_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      last_edited_time TEXT NOT NULL,
      page_type TEXT NOT NULL DEFAULT 'page',
      last_synced TEXT NOT NULL,
      node_ids TEXT,
      source_id TEXT DEFAULT '',
      PRIMARY KEY (page_id, source_id)
    );
    CREATE TABLE IF NOT EXISTS notion_pending_relations (
      source_page_id TEXT NOT NULL,
      target_page_id TEXT NOT NULL,
      source_node_id TEXT NOT NULL,
      property_name TEXT NOT NULL,
      source_id TEXT NOT NULL DEFAULT '',
      created TEXT NOT NULL,
      PRIMARY KEY (source_page_id, target_page_id, property_name, source_id)
    );
    CREATE INDEX IF NOT EXISTS idx_notion_pending_target
      ON notion_pending_relations(target_page_id, source_id);
  `);
});

// ── Page Sync State ──────────────────────────────────────────

describe('Page Sync State', () => {
  it('getPageState 返回 null（无记录）', () => {
    expect(getPageState(db, 'nonexistent', 'src1')).toBeNull();
  });

  it('updatePageState + getPageState 往返', () => {
    updatePageState(db, 'page-1', 'hash123', '2024-01-01T00:00:00.000Z', 'page', ['node-a', 'node-b'], 'src1');
    const state = getPageState(db, 'page-1', 'src1');
    expect(state).not.toBeNull();
    expect(state!.page_id).toBe('page-1');
    expect(state!.content_hash).toBe('hash123');
    expect(state!.last_edited_time).toBe('2024-01-01T00:00:00.000Z');
    expect(state!.page_type).toBe('page');
    expect(state!.node_ids).toEqual(['node-a', 'node-b']);
    expect(state!.source_id).toBe('src1');
  });

  it('updatePageState 更新已有记录', () => {
    updatePageState(db, 'page-1', 'hash1', '2024-01-01T00:00:00.000Z', 'page', ['n1'], 'src1');
    updatePageState(db, 'page-1', 'hash2', '2024-02-01T00:00:00.000Z', 'database_page', ['n2', 'n3'], 'src1');
    const state = getPageState(db, 'page-1', 'src1');
    expect(state!.content_hash).toBe('hash2');
    expect(state!.page_type).toBe('database_page');
    expect(state!.node_ids).toEqual(['n2', 'n3']);
  });

  it('不同 sourceId 隔离', () => {
    updatePageState(db, 'page-1', 'hash-a', '2024-01-01T00:00:00.000Z', 'page', ['n-a'], 'src1');
    updatePageState(db, 'page-1', 'hash-b', '2024-01-01T00:00:00.000Z', 'page', ['n-b'], 'src2');
    expect(getPageState(db, 'page-1', 'src1')!.content_hash).toBe('hash-a');
    expect(getPageState(db, 'page-1', 'src2')!.content_hash).toBe('hash-b');
  });

  it('getAllPageStates 返回指定 sourceId 的所有记录', () => {
    updatePageState(db, 'p1', 'h1', '2024-01-01T00:00:00.000Z', 'page', [], 'src1');
    updatePageState(db, 'p2', 'h2', '2024-01-01T00:00:00.000Z', 'page', [], 'src1');
    updatePageState(db, 'p3', 'h3', '2024-01-01T00:00:00.000Z', 'page', [], 'src2');
    const states = getAllPageStates(db, 'src1');
    expect(states.size).toBe(2);
    expect(states.has('p1')).toBe(true);
    expect(states.has('p2')).toBe(true);
    expect(states.has('p3')).toBe(false);
  });

  it('removePageState 删除记录', () => {
    updatePageState(db, 'p1', 'h1', '2024-01-01T00:00:00.000Z', 'page', [], 'src1');
    removePageState(db, 'p1', 'src1');
    expect(getPageState(db, 'p1', 'src1')).toBeNull();
  });

  it('getPageCount 统计', () => {
    updatePageState(db, 'p1', 'h1', '2024-01-01T00:00:00.000Z', 'page', [], 'src1');
    updatePageState(db, 'p2', 'h2', '2024-01-01T00:00:00.000Z', 'page', [], 'src1');
    expect(getPageCount(db, 'src1')).toBe(2);
    expect(getPageCount(db, 'src2')).toBe(0);
  });
});

// ── Pending Relations ────────────────────────────────────────

describe('Pending Relations', () => {
  it('添加 + 查询 pending relation', () => {
    addPendingRelation(db, {
      source_page_id: 'page-a',
      target_page_id: 'page-b',
      source_node_id: 'node-a',
      property_name: '相关文档',
      source_id: 'src1',
    });
    const pending = getPendingRelationsForTarget(db, 'page-b', 'src1');
    expect(pending).toHaveLength(1);
    expect(pending[0].source_page_id).toBe('page-a');
    expect(pending[0].source_node_id).toBe('node-a');
    expect(pending[0].property_name).toBe('相关文档');
  });

  it('查询不存在的 target 返回空', () => {
    const pending = getPendingRelationsForTarget(db, 'nonexistent', 'src1');
    expect(pending).toHaveLength(0);
  });

  it('removePendingRelation 删除指定记录', () => {
    addPendingRelation(db, {
      source_page_id: 'pa', target_page_id: 'pb',
      source_node_id: 'na', property_name: 'rel', source_id: 'src1',
    });
    removePendingRelation(db, 'pa', 'pb', 'src1');
    expect(getPendingRelationsForTarget(db, 'pb', 'src1')).toHaveLength(0);
  });

  it('removePendingRelationsForSource 批量删除', () => {
    addPendingRelation(db, {
      source_page_id: 'pa', target_page_id: 'pb',
      source_node_id: 'na', property_name: 'r1', source_id: 'src1',
    });
    addPendingRelation(db, {
      source_page_id: 'pa', target_page_id: 'pc',
      source_node_id: 'na', property_name: 'r2', source_id: 'src1',
    });
    removePendingRelationsForSource(db, 'pa', 'src1');
    expect(getPendingRelationsForTarget(db, 'pb', 'src1')).toHaveLength(0);
    expect(getPendingRelationsForTarget(db, 'pc', 'src1')).toHaveLength(0);
  });
});

// ── Full Scan State ──────────────────────────────────────────

describe('Full Scan State', () => {
  it('初始状态为未完成', () => {
    expect(hasCompletedFullScan(db, 'src1')).toBe(false);
  });

  it('标记完成后查询返回 true', () => {
    markFullScanCompleted(db, 'src1');
    expect(hasCompletedFullScan(db, 'src1')).toBe(true);
  });

  it('不同 sourceId 隔离', () => {
    markFullScanCompleted(db, 'src1');
    expect(hasCompletedFullScan(db, 'src1')).toBe(true);
    expect(hasCompletedFullScan(db, 'src2')).toBe(false);
  });
});
