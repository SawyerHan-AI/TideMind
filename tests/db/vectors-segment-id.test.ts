/**
 * nodes_vec segment ID 正确性测试
 *
 * 背景:nodes_vec.id 存 `${nodeId}#${segmentIndex}`,而 digest.ts 和
 * link-discover.ts 历史上用裸 nodeId 去 SELECT/DELETE,完全不命中。
 *  - DELETE 漏:被合并节点的向量永久残留 → "归档幽灵"
 *  - SELECT 漏:link-discover 向量邻居分支从上线起从未工作过
 *
 * v0.2.15 改走 deleteVector / getVectorForNode 辅助函数。
 *
 * 历史(2026-05-19 audit):本文件曾 inline 复刻 insertSegment / deleteVectorByNodeId
 * / getVectorByNodeId 三个函数,完全不 import 真源(参见 docs/design/
 * test-coverage-plan-2026-05-20.md §1.1 #3)。改造为 import 真源的 insertVector /
 * deleteVector / getVectorForNode —— 这三个都不依赖 LLM embedding,可以在测试环境
 * 直接跑。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { insertVector, deleteVector, getVectorForNode } from '../../src/db/vectors.js';

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  // sqlite-vec 扩展在测试环境可能不可用,用普通表验证 ID 规则和
  // node_segments 的映射关系。INSERT OR REPLACE 的列签名跟真表一致即可。
  db.exec(`
    CREATE TABLE nodes_vec (
      id TEXT PRIMARY KEY,
      embedding BLOB
    );
    CREATE TABLE node_segments (
      segment_id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL,
      segment_index INTEGER NOT NULL
    );
    CREATE INDEX idx_node_segments_nodeid ON node_segments(node_id);
  `);
  return db;
}

/** 测试 fixture:多 segment 插入(真源 insertSegmentVectors 依赖 getEmbedding LLM 调用,
 *  这里直接走底层 INSERT 模拟多段写入)。这不是源码逻辑复刻——只是测试场景搭建。 */
function fixtureInsertSegment(db: Database.Database, nodeId: string, idx: number, embeddingBuf: Buffer): void {
  const segmentId = `${nodeId}#${idx}`;
  db.prepare('INSERT INTO nodes_vec (id, embedding) VALUES (?, ?)').run(segmentId, embeddingBuf);
  db.prepare('INSERT INTO node_segments (segment_id, node_id, segment_index) VALUES (?, ?, ?)').run(segmentId, nodeId, idx);
}

describe('nodes_vec segment id helpers (real source)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupDb();
  });

  it('insertVector(真源)在 segment_id = nodeId#0 上插入', () => {
    const emb = new Float32Array([1, 2, 3, 4]);
    insertVector(db, 'node-abc', emb);
    const row = db.prepare('SELECT id FROM nodes_vec').get() as { id: string };
    expect(row.id).toBe('node-abc#0');

    const segMap = db.prepare('SELECT segment_id, node_id, segment_index FROM node_segments').get() as {
      segment_id: string; node_id: string; segment_index: number;
    };
    expect(segMap).toEqual({ segment_id: 'node-abc#0', node_id: 'node-abc', segment_index: 0 });
  });

  it('多段写入时 segmentId 形如 nodeId#index', () => {
    const buf = Buffer.from(new Float32Array([0, 0, 0, 0]).buffer);
    fixtureInsertSegment(db, 'node-abc', 0, buf);
    fixtureInsertSegment(db, 'node-abc', 1, buf);
    fixtureInsertSegment(db, 'node-abc', 2, buf);

    const ids = db.prepare('SELECT id FROM nodes_vec ORDER BY id').all() as Array<{ id: string }>;
    expect(ids).toEqual([
      { id: 'node-abc#0' },
      { id: 'node-abc#1' },
      { id: 'node-abc#2' },
    ]);
  });

  it('裸 nodeId 查 nodes_vec 查不到(核心 bug 根因)', () => {
    const emb = new Float32Array([1, 2, 3, 4]);
    insertVector(db, 'node-xyz', emb);

    const wrong = db.prepare('SELECT embedding FROM nodes_vec WHERE id = ?').get('node-xyz');
    expect(wrong).toBeUndefined();
  });

  it('getVectorForNode(真源,走 ${id}#0)正确命中第一段', () => {
    insertVector(db, 'node-xyz', new Float32Array([1, 2, 3, 4]));

    const got = getVectorForNode(db, 'node-xyz');
    expect(got).not.toBeNull();
    expect(Array.from(got!)).toEqual([1, 2, 3, 4]);
  });

  it('getVectorForNode 不存在的节点返回 null', () => {
    const got = getVectorForNode(db, 'no-such-node');
    expect(got).toBeNull();
  });

  it('deleteVector(真源)清空所有 segments(不会漏)', () => {
    const buf = Buffer.from(new Float32Array([0, 0, 0, 0]).buffer);
    fixtureInsertSegment(db, 'node-abc', 0, buf);
    fixtureInsertSegment(db, 'node-abc', 1, buf);
    fixtureInsertSegment(db, 'node-abc', 2, buf);
    fixtureInsertSegment(db, 'other', 0, buf); // 其他节点不受影响

    deleteVector(db, 'node-abc');

    const remaining = db.prepare('SELECT id FROM nodes_vec').all() as Array<{ id: string }>;
    expect(remaining).toEqual([{ id: 'other#0' }]);

    const segs = db.prepare('SELECT * FROM node_segments WHERE node_id = ?').all('node-abc');
    expect(segs).toEqual([]);
  });

  it('裸 DELETE FROM nodes_vec WHERE id = nodeId 什么也不删(归档幽灵 bug 复现)', () => {
    const buf = Buffer.from(new Float32Array([0, 0, 0, 0]).buffer);
    fixtureInsertSegment(db, 'ghost', 0, buf);
    fixtureInsertSegment(db, 'ghost', 1, buf);

    const r = db.prepare('DELETE FROM nodes_vec WHERE id = ?').run('ghost');
    expect(r.changes).toBe(0);

    const remaining = db.prepare('SELECT COUNT(*) as cnt FROM nodes_vec').get() as { cnt: number };
    expect(remaining.cnt).toBe(2); // 向量残留
  });

  it('deleteVector 对不存在节点是 no-op,不抛错', () => {
    expect(() => deleteVector(db, 'never-existed')).not.toThrow();
  });
});
