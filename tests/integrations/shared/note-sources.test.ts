/**
 * note-sources.ts 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
import { ensureSyncSchema } from '../../../src/integrations/logseq/sync-state.js';
import { ensureSyncSchema as ensureObsidianSyncSchema } from '../../../src/integrations/obsidian/sync-state.js';
import {
  listNoteSources,
  getNoteSource,
  createNoteSource,
  updateNoteSource,
  markInitialized,
  updateLastSynced,
  archiveNoteSource,
  unarchiveNoteSource,
  deleteNoteSource,
  getNoteSourceStats,
} from '../../../src/integrations/shared/note-sources.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
  ensureSyncSchema(db);
  ensureObsidianSyncSchema(db);
});

// ===== createNoteSource / getNoteSource =====

describe('createNoteSource / getNoteSource', () => {
  it('创建笔记源并获取', () => {
    const src = createNoteSource(db, {
      name: 'My Logseq',
      toolType: 'logseq',
      path: '/home/user/logseq',
    });

    expect(src.id).toMatch(/^ns_/);
    expect(src.name).toBe('My Logseq');
    expect(src.tool_type).toBe('logseq');
    expect(src.path).toBe('/home/user/logseq');
    expect(src.poll_interval).toBe(60);
    expect(src.archived).toBe(0);
    expect(src.initialized).toBe(0);
    expect(src.last_synced).toBeNull();

    const got = getNoteSource(db, src.id);
    expect(got).not.toBeNull();
    expect(got!.name).toBe('My Logseq');
  });

  it('自定义 pollInterval', () => {
    const src = createNoteSource(db, {
      name: 'Fast',
      toolType: 'obsidian',
      path: '/vault',
      pollInterval: 10,
    });
    expect(src.poll_interval).toBe(10);
  });

  it('不存在的 id 返回 null', () => {
    expect(getNoteSource(db, 'ns_nonexistent')).toBeNull();
  });
});

// ===== listNoteSources =====

describe('listNoteSources', () => {
  it('空表返回空数组', () => {
    expect(listNoteSources(db)).toEqual([]);
  });

  it('返回创建的笔记源', () => {
    createNoteSource(db, { name: 'A', toolType: 'logseq', path: '/a' });
    createNoteSource(db, { name: 'B', toolType: 'obsidian', path: '/b' });

    const list = listNoteSources(db);
    expect(list).toHaveLength(2);
  });

  it('默认不包含已归档的笔记源', () => {
    const src = createNoteSource(db, { name: 'Archived', toolType: 'logseq', path: '/x' });
    archiveNoteSource(db, src.id);

    createNoteSource(db, { name: 'Active', toolType: 'logseq', path: '/y' });

    const list = listNoteSources(db);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Active');
  });

  it('includeArchived = true 时包含已归档的笔记源', () => {
    const src = createNoteSource(db, { name: 'Archived', toolType: 'logseq', path: '/x' });
    archiveNoteSource(db, src.id);
    createNoteSource(db, { name: 'Active', toolType: 'logseq', path: '/y' });

    const list = listNoteSources(db, true);
    expect(list).toHaveLength(2);
  });

  it('includeArchived 列表中归档排在后面', () => {
    const archived = createNoteSource(db, { name: 'Archived', toolType: 'logseq', path: '/x' });
    archiveNoteSource(db, archived.id);
    createNoteSource(db, { name: 'Active', toolType: 'logseq', path: '/y' });

    const list = listNoteSources(db, true);
    // archived ASC: 未归档(0)在前，已归档(1)在后
    expect(list[0].archived).toBe(0);
    expect(list[1].archived).toBe(1);
  });
});

// ===== updateNoteSource =====

describe('updateNoteSource', () => {
  it('更新 name', () => {
    const src = createNoteSource(db, { name: 'Old', toolType: 'logseq', path: '/p' });
    updateNoteSource(db, src.id, { name: 'New' });

    const got = getNoteSource(db, src.id);
    expect(got!.name).toBe('New');
  });

  it('更新 path', () => {
    const src = createNoteSource(db, { name: 'S', toolType: 'logseq', path: '/old' });
    updateNoteSource(db, src.id, { path: '/new' });

    const got = getNoteSource(db, src.id);
    expect(got!.path).toBe('/new');
  });

  it('更新 pollInterval', () => {
    const src = createNoteSource(db, { name: 'S', toolType: 'logseq', path: '/p' });
    updateNoteSource(db, src.id, { pollInterval: 120 });

    const got = getNoteSource(db, src.id);
    expect(got!.poll_interval).toBe(120);
  });

  it('同时更新多个字段', () => {
    const src = createNoteSource(db, { name: 'S', toolType: 'logseq', path: '/p' });
    updateNoteSource(db, src.id, { name: 'X', path: '/x', pollInterval: 5 });

    const got = getNoteSource(db, src.id);
    expect(got!.name).toBe('X');
    expect(got!.path).toBe('/x');
    expect(got!.poll_interval).toBe(5);
  });

  it('空 updates 不报错', () => {
    const src = createNoteSource(db, { name: 'S', toolType: 'logseq', path: '/p' });
    expect(() => updateNoteSource(db, src.id, {})).not.toThrow();
    // 值不变
    expect(getNoteSource(db, src.id)!.name).toBe('S');
  });
});

// ===== markInitialized / updateLastSynced =====

describe('markInitialized / updateLastSynced', () => {
  it('markInitialized 将 initialized 设为 1', () => {
    const src = createNoteSource(db, { name: 'S', toolType: 'logseq', path: '/p' });
    expect(getNoteSource(db, src.id)!.initialized).toBe(0);

    markInitialized(db, src.id);
    expect(getNoteSource(db, src.id)!.initialized).toBe(1);
  });

  it('updateLastSynced 更新 last_synced 时间', () => {
    const src = createNoteSource(db, { name: 'S', toolType: 'logseq', path: '/p' });
    expect(getNoteSource(db, src.id)!.last_synced).toBeNull();

    updateLastSynced(db, src.id);
    const got = getNoteSource(db, src.id);
    expect(got!.last_synced).not.toBeNull();
    // 应该是一个 ISO 时间字符串
    expect(new Date(got!.last_synced!).getTime()).toBeGreaterThan(0);
  });
});

// ===== archiveNoteSource / unarchiveNoteSource =====

describe('archiveNoteSource / unarchiveNoteSource', () => {
  it('归档后 archived = 1', () => {
    const src = createNoteSource(db, { name: 'S', toolType: 'logseq', path: '/p' });
    archiveNoteSource(db, src.id);
    expect(getNoteSource(db, src.id)!.archived).toBe(1);
  });

  it('取消归档后 archived = 0', () => {
    const src = createNoteSource(db, { name: 'S', toolType: 'logseq', path: '/p' });
    archiveNoteSource(db, src.id);
    unarchiveNoteSource(db, src.id);
    expect(getNoteSource(db, src.id)!.archived).toBe(0);
  });
});

// ===== deleteNoteSource =====

describe('deleteNoteSource', () => {
  it('删除后 getNoteSource 返回 null', () => {
    const src = createNoteSource(db, { name: 'S', toolType: 'logseq', path: '/p' });
    deleteNoteSource(db, src.id);
    expect(getNoteSource(db, src.id)).toBeNull();
  });

  it('删除后不出现在列表中', () => {
    const src = createNoteSource(db, { name: 'S', toolType: 'logseq', path: '/p' });
    deleteNoteSource(db, src.id);
    expect(listNoteSources(db)).toHaveLength(0);
  });
});

// ===== getNoteSourceStats =====

describe('getNoteSourceStats', () => {
  it('不存在的笔记源返回默认值', () => {
    const stats = getNoteSourceStats(db, 'ns_nonexistent');
    expect(stats).toEqual({ fileCount: 0, nodeCount: 0, lastSynced: null });
  });

  it('笔记源无同步数据时返回 0', () => {
    const src = createNoteSource(db, { name: 'S', toolType: 'logseq', path: '/p' });
    const stats = getNoteSourceStats(db, src.id);
    expect(stats.fileCount).toBe(0);
    expect(stats.nodeCount).toBe(0);
    expect(stats.lastSynced).toBeNull();
  });

  it('统计 logseq 类型的文件数和节点数', () => {
    const src = createNoteSource(db, { name: 'S', toolType: 'logseq', path: '/p' });

    // 插入同步记录
    db.prepare(`
      INSERT INTO logseq_sync (file_path, content_hash, mtime, size, last_synced, node_ids, source_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('/a.md', 'h1', 100, 50, '2024-01-01', JSON.stringify(['n1', 'n2']), src.id);

    db.prepare(`
      INSERT INTO logseq_sync (file_path, content_hash, mtime, size, last_synced, node_ids, source_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('/b.md', 'h2', 200, 80, '2024-01-02', JSON.stringify(['n3']), src.id);

    const stats = getNoteSourceStats(db, src.id);
    expect(stats.fileCount).toBe(2);
    expect(stats.nodeCount).toBe(3);
  });

  it('统计 obsidian 类型的文件数和节点数', () => {
    const src = createNoteSource(db, { name: 'S', toolType: 'obsidian', path: '/vault' });

    db.prepare(`
      INSERT INTO obsidian_sync (file_path, content_hash, mtime, size, last_synced, node_ids, source_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('/note.md', 'h1', 100, 50, '2024-01-01', JSON.stringify(['n1', 'n2', 'n3']), src.id);

    const stats = getNoteSourceStats(db, src.id);
    expect(stats.fileCount).toBe(1);
    expect(stats.nodeCount).toBe(3);
  });

  it('node_ids 为 null 时不计入节点数', () => {
    const src = createNoteSource(db, { name: 'S', toolType: 'logseq', path: '/p' });

    db.prepare(`
      INSERT INTO logseq_sync (file_path, content_hash, mtime, size, last_synced, node_ids, source_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('/empty.md', 'h1', 100, 50, '2024-01-01', null, src.id);

    const stats = getNoteSourceStats(db, src.id);
    expect(stats.fileCount).toBe(1);
    expect(stats.nodeCount).toBe(0);
  });

  it('lastSynced 反映笔记源的 last_synced', () => {
    const src = createNoteSource(db, { name: 'S', toolType: 'logseq', path: '/p' });
    updateLastSynced(db, src.id);

    const stats = getNoteSourceStats(db, src.id);
    expect(stats.lastSynced).not.toBeNull();
  });

  it('忽略不属于该笔记源的同步记录', () => {
    const src1 = createNoteSource(db, { name: 'S1', toolType: 'logseq', path: '/p1' });
    const src2 = createNoteSource(db, { name: 'S2', toolType: 'logseq', path: '/p2' });

    db.prepare(`
      INSERT INTO logseq_sync (file_path, content_hash, mtime, size, last_synced, node_ids, source_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('/a.md', 'h1', 100, 50, '2024-01-01', JSON.stringify(['n1']), src1.id);

    db.prepare(`
      INSERT INTO logseq_sync (file_path, content_hash, mtime, size, last_synced, node_ids, source_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('/b.md', 'h2', 200, 80, '2024-01-01', JSON.stringify(['n2', 'n3']), src2.id);

    const stats1 = getNoteSourceStats(db, src1.id);
    expect(stats1.fileCount).toBe(1);
    expect(stats1.nodeCount).toBe(1);

    const stats2 = getNoteSourceStats(db, src2.id);
    expect(stats2.fileCount).toBe(1);
    expect(stats2.nodeCount).toBe(2);
  });
});

// ===== 初始化状态机相关测试 =====

describe('初始化状态分层', () => {
  it('新建的笔记源 initialized = 0', () => {
    const src = createNoteSource(db, { name: 'New', toolType: 'logseq', path: '/p' });
    expect(src.initialized).toBe(0);
  });

  it('markInitialized 后可以区分已初始化和未初始化的源', () => {
    const s1 = createNoteSource(db, { name: 'Done', toolType: 'logseq', path: '/a' });
    const s2 = createNoteSource(db, { name: 'Partial', toolType: 'obsidian', path: '/b' });
    markInitialized(db, s1.id);

    const all = listNoteSources(db, true);
    const initialized = all.filter(s => s.initialized);
    const uninitialized = all.filter(s => !s.initialized);

    expect(initialized).toHaveLength(1);
    expect(initialized[0].name).toBe('Done');
    expect(uninitialized).toHaveLength(1);
    expect(uninitialized[0].name).toBe('Partial');
  });

  it('startAllNoteSources 的 SQL 只选 initialized=1 且 archived=0', () => {
    // 模拟 startAllNoteSources 的查询逻辑
    const s1 = createNoteSource(db, { name: 'Ready', toolType: 'logseq', path: '/a' });
    const s2 = createNoteSource(db, { name: 'Partial', toolType: 'logseq', path: '/b' });
    const s3 = createNoteSource(db, { name: 'Archived', toolType: 'logseq', path: '/c' });
    markInitialized(db, s1.id);
    markInitialized(db, s3.id);
    archiveNoteSource(db, s3.id);

    const startable = db.prepare(
      'SELECT * FROM note_sources WHERE archived = 0 AND initialized = 1',
    ).all() as Array<{ id: string; name: string }>;

    expect(startable).toHaveLength(1);
    expect(startable[0].name).toBe('Ready');
  });

  it('未初始化的源有部分 sync 数据时仍能获取 stats', () => {
    const src = createNoteSource(db, { name: 'Partial', toolType: 'logseq', path: '/p' });
    // 不调 markInitialized —— 模拟中断
    db.prepare(`
      INSERT INTO logseq_sync (file_path, content_hash, mtime, size, last_synced, node_ids, source_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('/file1.md', 'h1', 100, 50, '2024-01-01', JSON.stringify(['n1', 'n2']), src.id);
    db.prepare(`
      INSERT INTO logseq_sync (file_path, content_hash, mtime, size, last_synced, node_ids, source_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('/file2.md', 'h2', 200, 80, '2024-01-02', JSON.stringify(['n3']), src.id);

    expect(src.initialized).toBe(0);
    const stats = getNoteSourceStats(db, src.id);
    expect(stats.fileCount).toBe(2);
    expect(stats.nodeCount).toBe(3);
  });

  it('对 obsidian 类型的未初始化源同样能获取 stats', () => {
    const src = createNoteSource(db, { name: 'Partial Obs', toolType: 'obsidian', path: '/vault' });
    db.prepare(`
      INSERT INTO obsidian_sync (file_path, content_hash, mtime, size, last_synced, node_ids, source_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('/note.md', 'h1', 100, 50, '2024-01-01', JSON.stringify(['n1']), src.id);

    expect(src.initialized).toBe(0);
    const stats = getNoteSourceStats(db, src.id);
    expect(stats.fileCount).toBe(1);
    expect(stats.nodeCount).toBe(1);
  });
});
