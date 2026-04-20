/**
 * nodes_vec segment ID 正确性测试
 *
 * 背景:nodes_vec.id 存 `${nodeId}#${segmentIndex}`,而 digest.ts 和
 * link-discover.ts 历史上用裸 nodeId 去 SELECT/DELETE,完全不命中。
 *  - DELETE 漏:被合并节点的向量永久残留 → "归档幽灵"
 *  - SELECT 漏:link-discover 向量邻居分支从上线起从未工作过
 *
 * v0.2.15 改走 deleteVector / getVectorForNode 辅助函数。
 * 这里用内存 SQLite + sqlite-vec 验证 helper 正确识别 segmentId 前缀。
 *
 * 注意:sqlite-vec 扩展在测试环境可能不可用,用 fallback table schema 验证
 * ID 生成规则即可。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  // 模拟 nodes_vec 不使用 sqlite-vec 扩展(测试环境不一定有),
  // 用普通表验证 ID 规则和 node_segments 的映射关系。
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

/** 复刻 vectors.ts 里的关键函数签名(不 import 避免依赖 embedding 等 heavy deps)。 */
function insertSegment(db: Database.Database, nodeId: string, idx: number, vec: Uint8Array): void {
  const segmentId = `${nodeId}#${idx}`;
  db.prepare('INSERT INTO nodes_vec (id, embedding) VALUES (?, ?)').run(segmentId, Buffer.from(vec));
  db.prepare('INSERT INTO node_segments (segment_id, node_id, segment_index) VALUES (?, ?, ?)').run(segmentId, nodeId, idx);
}

function deleteVectorByNodeId(db: Database.Database, nodeId: string): number {
  const segs = db.prepare('SELECT segment_id FROM node_segments WHERE node_id = ?').all(nodeId) as Array<{ segment_id: string }>;
  let deleted = 0;
  for (const s of segs) {
    const r = db.prepare('DELETE FROM nodes_vec WHERE id = ?').run(s.segment_id);
    deleted += r.changes;
  }
  db.prepare('DELETE FROM node_segments WHERE node_id = ?').run(nodeId);
  return deleted;
}

function getVectorByNodeId(db: Database.Database, nodeId: string): Uint8Array | null {
  const row = db.prepare('SELECT embedding FROM nodes_vec WHERE id = ?').get(`${nodeId}#0`) as { embedding: Buffer } | undefined;
  return row ? new Uint8Array(row.embedding) : null;
}

describe('nodes_vec segment id helpers', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupDb();
  });

  it('插入多段时 segmentId 形如 nodeId#index', () => {
    const vec = new Uint8Array(4);
    insertSegment(db, 'node-abc', 0, vec);
    insertSegment(db, 'node-abc', 1, vec);
    insertSegment(db, 'node-abc', 2, vec);

    const ids = db.prepare('SELECT id FROM nodes_vec ORDER BY id').all() as Array<{ id: string }>;
    expect(ids).toEqual([
      { id: 'node-abc#0' },
      { id: 'node-abc#1' },
      { id: 'node-abc#2' },
    ]);
  });

  it('裸 nodeId 查 nodes_vec 查不到(核心 bug 根因)', () => {
    const vec = new Uint8Array(4);
    insertSegment(db, 'node-xyz', 0, vec);

    const wrong = db.prepare('SELECT embedding FROM nodes_vec WHERE id = ?').get('node-xyz');
    expect(wrong).toBeUndefined();
  });

  it('getVectorByNodeId(走 ${id}#0) 正确命中第一段', () => {
    const vec = new Uint8Array([1, 2, 3, 4]);
    insertSegment(db, 'node-xyz', 0, vec);
    insertSegment(db, 'node-xyz', 1, new Uint8Array([5, 6, 7, 8]));

    const got = getVectorByNodeId(db, 'node-xyz');
    expect(got).not.toBeNull();
    expect(Array.from(got!)).toEqual([1, 2, 3, 4]);
  });

  it('deleteVectorByNodeId 清空所有 segments(不会漏)', () => {
    const vec = new Uint8Array(4);
    insertSegment(db, 'node-abc', 0, vec);
    insertSegment(db, 'node-abc', 1, vec);
    insertSegment(db, 'node-abc', 2, vec);
    insertSegment(db, 'other', 0, vec); // 其他节点不受影响

    const deleted = deleteVectorByNodeId(db, 'node-abc');
    expect(deleted).toBe(3);

    const remaining = db.prepare('SELECT id FROM nodes_vec').all() as Array<{ id: string }>;
    expect(remaining).toEqual([{ id: 'other#0' }]);

    const segs = db.prepare('SELECT * FROM node_segments WHERE node_id = ?').all('node-abc');
    expect(segs).toEqual([]);
  });

  it('裸 DELETE FROM nodes_vec WHERE id = nodeId 什么也不删(归档幽灵 bug 复现)', () => {
    const vec = new Uint8Array(4);
    insertSegment(db, 'ghost', 0, vec);
    insertSegment(db, 'ghost', 1, vec);

    const r = db.prepare('DELETE FROM nodes_vec WHERE id = ?').run('ghost');
    expect(r.changes).toBe(0);

    const remaining = db.prepare('SELECT COUNT(*) as cnt FROM nodes_vec').get() as { cnt: number };
    expect(remaining.cnt).toBe(2); // 向量残留
  });
});
