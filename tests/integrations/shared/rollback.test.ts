/**
 * rollback.ts 单元测试
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
import { setupTestDb, seedNode, seedLink } from '../../helpers/test-db.js';
import { ensureSyncSchema } from '../../../src/integrations/logseq/sync-state.js';
import { ensureSyncSchema as ensureObsidianSyncSchema } from '../../../src/integrations/obsidian/sync-state.js';
import { createNoteSource } from '../../../src/integrations/shared/note-sources.js';
import { rollbackNoteSource } from '../../../src/integrations/shared/rollback.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
  ensureSyncSchema(db);
  ensureObsidianSyncSchema(db);
});

/** 在 sync 表中插入文件记录 */
function insertSyncRecord(
  table: 'logseq_sync' | 'obsidian_sync',
  filePath: string,
  sourceId: string,
  nodeIds: string[],
): void {
  db.prepare(`
    INSERT INTO ${table} (file_path, content_hash, mtime, size, last_synced, node_ids, source_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(filePath, 'hash', 100, 50, '2024-01-01', JSON.stringify(nodeIds), sourceId);
}

// ===== 基本回退 =====

describe('rollbackNoteSource 基本回退', () => {
  it('回退删除节点、sync state 和 note_sources 记录', () => {
    const src = createNoteSource(db, { name: 'S', toolType: 'logseq', path: '/p' });
    const node1 = seedNode(db);
    const node2 = seedNode(db);

    insertSyncRecord('logseq_sync', '/a.md', src.id, [node1.id, node2.id]);

    // 在 metadata 中插入 full_scan 标记
    db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)').run(
      `logseq_full_scan_completed_${src.id}`,
      '1',
    );

    rollbackNoteSource(db, src.id, 'logseq');

    // 节点被删除
    const nodeCount = (db.prepare('SELECT COUNT(*) as cnt FROM nodes WHERE id IN (?, ?)').get(node1.id, node2.id) as { cnt: number }).cnt;
    expect(nodeCount).toBe(0);

    // sync state 被删除
    const syncCount = (db.prepare('SELECT COUNT(*) as cnt FROM logseq_sync WHERE source_id = ?').get(src.id) as { cnt: number }).cnt;
    expect(syncCount).toBe(0);

    // note_sources 记录被删除
    const nsCount = (db.prepare('SELECT COUNT(*) as cnt FROM note_sources WHERE id = ?').get(src.id) as { cnt: number }).cnt;
    expect(nsCount).toBe(0);

    // metadata full_scan 标记被清理
    const metaCount = (db.prepare('SELECT COUNT(*) as cnt FROM metadata WHERE key = ?').get(`logseq_full_scan_completed_${src.id}`) as { cnt: number }).cnt;
    expect(metaCount).toBe(0);
  });
});

// ===== 无节点数据时回退 =====

describe('rollbackNoteSource 无节点数据', () => {
  it('无同步记录时仅清理 note_sources 和 metadata', () => {
    const src = createNoteSource(db, { name: 'S', toolType: 'logseq', path: '/p' });

    db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)').run(
      `logseq_full_scan_completed_${src.id}`,
      '1',
    );

    rollbackNoteSource(db, src.id, 'logseq');

    const nsCount = (db.prepare('SELECT COUNT(*) as cnt FROM note_sources WHERE id = ?').get(src.id) as { cnt: number }).cnt;
    expect(nsCount).toBe(0);

    const metaCount = (db.prepare('SELECT COUNT(*) as cnt FROM metadata WHERE key = ?').get(`logseq_full_scan_completed_${src.id}`) as { cnt: number }).cnt;
    expect(metaCount).toBe(0);
  });

  it('sync 记录存在但 node_ids 为 null 时走无节点路径', () => {
    const src = createNoteSource(db, { name: 'S', toolType: 'logseq', path: '/p' });

    // node_ids 为 null
    db.prepare(`
      INSERT INTO logseq_sync (file_path, content_hash, mtime, size, last_synced, node_ids, source_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('/a.md', 'h', 100, 50, '2024-01-01', null, src.id);

    rollbackNoteSource(db, src.id, 'logseq');

    const syncCount = (db.prepare('SELECT COUNT(*) as cnt FROM logseq_sync WHERE source_id = ?').get(src.id) as { cnt: number }).cnt;
    expect(syncCount).toBe(0);

    const nsCount = (db.prepare('SELECT COUNT(*) as cnt FROM note_sources WHERE id = ?').get(src.id) as { cnt: number }).cnt;
    expect(nsCount).toBe(0);
  });
});

// ===== 节点有链接时回退 =====

describe('rollbackNoteSource 带链接回退', () => {
  it('回退时删除相关链接', () => {
    const src = createNoteSource(db, { name: 'S', toolType: 'logseq', path: '/p' });
    const node1 = seedNode(db);
    const node2 = seedNode(db);
    const otherNode = seedNode(db); // 不属于此笔记源

    // 创建链接：node1 -> node2（属于笔记源）
    seedLink(db, node1.id, node2.id);
    // 创建链接：node1 -> otherNode（跨源）
    seedLink(db, node1.id, otherNode.id);
    // 创建链接：otherNode -> node2（跨源，to_id 是笔记源节点）
    seedLink(db, otherNode.id, node2.id);

    insertSyncRecord('logseq_sync', '/a.md', src.id, [node1.id, node2.id]);

    rollbackNoteSource(db, src.id, 'logseq');

    // node1 和 node2 被删除
    const deletedCount = (db.prepare('SELECT COUNT(*) as cnt FROM nodes WHERE id IN (?, ?)').get(node1.id, node2.id) as { cnt: number }).cnt;
    expect(deletedCount).toBe(0);

    // otherNode 保留
    const otherCount = (db.prepare('SELECT COUNT(*) as cnt FROM nodes WHERE id = ?').get(otherNode.id) as { cnt: number }).cnt;
    expect(otherCount).toBe(1);

    // 所有涉及 node1/node2 的链接被删除
    const linkCount = (db.prepare(
      'SELECT COUNT(*) as cnt FROM links WHERE from_id IN (?, ?) OR to_id IN (?, ?)',
    ).get(node1.id, node2.id, node1.id, node2.id) as { cnt: number }).cnt;
    expect(linkCount).toBe(0);

    // otherNode 的自身链接（如果有）不受影响 — 此处仅验证无残留
  });
});

// ===== obsidian 类型回退 =====

describe('rollbackNoteSource obsidian 类型', () => {
  it('obsidian 类型使用 obsidian_sync 表', () => {
    const src = createNoteSource(db, { name: 'S', toolType: 'obsidian', path: '/vault' });
    const node = seedNode(db);

    insertSyncRecord('obsidian_sync', '/note.md', src.id, [node.id]);

    db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)').run(
      `obsidian_full_scan_completed_${src.id}`,
      '1',
    );

    rollbackNoteSource(db, src.id, 'obsidian');

    const nodeCount = (db.prepare('SELECT COUNT(*) as cnt FROM nodes WHERE id = ?').get(node.id) as { cnt: number }).cnt;
    expect(nodeCount).toBe(0);

    const syncCount = (db.prepare('SELECT COUNT(*) as cnt FROM obsidian_sync WHERE source_id = ?').get(src.id) as { cnt: number }).cnt;
    expect(syncCount).toBe(0);

    const nsCount = (db.prepare('SELECT COUNT(*) as cnt FROM note_sources WHERE id = ?').get(src.id) as { cnt: number }).cnt;
    expect(nsCount).toBe(0);

    const metaCount = (db.prepare('SELECT COUNT(*) as cnt FROM metadata WHERE key = ?').get(`obsidian_full_scan_completed_${src.id}`) as { cnt: number }).cnt;
    expect(metaCount).toBe(0);
  });
});

// ===== 批量节点回退 =====

describe('rollbackNoteSource 批量节点', () => {
  it('超过 500 个节点分批删除', () => {
    const src = createNoteSource(db, { name: 'S', toolType: 'logseq', path: '/p' });

    // 创建 600 个节点
    const nodeIds: string[] = [];
    const insertNode = db.prepare(
      'INSERT INTO nodes (id, type, content, heat, refinement, connectivity, independence, specificity, subjectivity, actuality, version, archived, is_keystone, is_crystal, is_tag, is_meta, maturity_score, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );

    const now = new Date().toISOString();
    for (let i = 0; i < 600; i++) {
      const id = `batch-node-${i}`;
      nodeIds.push(id);
      insertNode.run(id, 'fact', `content ${i}`, 1, 0, 0, 0, 0.5, 0.5, 0.5, 1, 0, 0, 0, 0, 0, 0.2, now);
    }

    // 分散到多个文件记录中
    const chunk1 = nodeIds.slice(0, 300);
    const chunk2 = nodeIds.slice(300, 600);
    insertSyncRecord('logseq_sync', '/batch1.md', src.id, chunk1);
    insertSyncRecord('logseq_sync', '/batch2.md', src.id, chunk2);

    rollbackNoteSource(db, src.id, 'logseq');

    // 所有节点应被删除
    const remaining = (db.prepare('SELECT COUNT(*) as cnt FROM nodes WHERE id LIKE ?').get('batch-node-%') as { cnt: number }).cnt;
    expect(remaining).toBe(0);

    // sync state 和 note_sources 也被清理
    const syncCount = (db.prepare('SELECT COUNT(*) as cnt FROM logseq_sync WHERE source_id = ?').get(src.id) as { cnt: number }).cnt;
    expect(syncCount).toBe(0);

    const nsCount = (db.prepare('SELECT COUNT(*) as cnt FROM note_sources WHERE id = ?').get(src.id) as { cnt: number }).cnt;
    expect(nsCount).toBe(0);
  });

  it('超过 500 个节点的链接也被正确删除', () => {
    const src = createNoteSource(db, { name: 'S', toolType: 'logseq', path: '/p' });

    const nodeIds: string[] = [];
    const insertNode = db.prepare(
      'INSERT INTO nodes (id, type, content, heat, refinement, connectivity, independence, specificity, subjectivity, actuality, version, archived, is_keystone, is_crystal, is_tag, is_meta, maturity_score, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insertLink = db.prepare(
      'INSERT INTO links (id, from_id, to_id, relation, strength, auto, status, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );

    const now = new Date().toISOString();
    for (let i = 0; i < 510; i++) {
      const id = `ln-${i}`;
      nodeIds.push(id);
      insertNode.run(id, 'fact', `content ${i}`, 1, 0, 0, 0, 0.5, 0.5, 0.5, 1, 0, 0, 0, 0, 0, 0.2, now);
    }

    // 给部分节点创建链接（跨 batch 边界）
    insertLink.run('link-499-500', 'ln-499', 'ln-500', '[]', 0.5, 1, 'confirmed', now);
    insertLink.run('link-0-509', 'ln-0', 'ln-509', '[]', 0.5, 1, 'confirmed', now);

    insertSyncRecord('logseq_sync', '/all.md', src.id, nodeIds);

    rollbackNoteSource(db, src.id, 'logseq');

    const linkCount = (db.prepare('SELECT COUNT(*) as cnt FROM links WHERE id IN (?, ?)').get('link-499-500', 'link-0-509') as { cnt: number }).cnt;
    expect(linkCount).toBe(0);
  });
});

// ===== 多文件记录回退 =====

describe('rollbackNoteSource 多文件记录', () => {
  it('多个 sync 记录的节点全部回退', () => {
    const src = createNoteSource(db, { name: 'S', toolType: 'logseq', path: '/p' });
    const n1 = seedNode(db);
    const n2 = seedNode(db);
    const n3 = seedNode(db);

    insertSyncRecord('logseq_sync', '/file1.md', src.id, [n1.id]);
    insertSyncRecord('logseq_sync', '/file2.md', src.id, [n2.id, n3.id]);

    rollbackNoteSource(db, src.id, 'logseq');

    const remaining = (db.prepare(
      'SELECT COUNT(*) as cnt FROM nodes WHERE id IN (?, ?, ?)',
    ).get(n1.id, n2.id, n3.id) as { cnt: number }).cnt;
    expect(remaining).toBe(0);
  });
});
