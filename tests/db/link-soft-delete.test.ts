/**
 * M10:link 软删(deleteLink)+ 查询排除 deleted 的回归。
 *
 * 删除从 hard-delete 改为软删(deleted=1 + bump updated/edit_seq),靠同步层 LWW 跨设备传播,
 * 杜绝 reconcile manifest diff 把已删 link 当 onlyLocal/onlyServer 复活;所有读查询排除 deleted=1。
 */

import { describe, it, expect } from 'vitest';
import { setupTestDb, seedNode } from '../helpers/test-db.js';
import {
  createLink, deleteLink, getLinksForNode, getLinksForNodes,
  getLinkCount, linkExists, getPendingLinks,
} from '../../src/db/links.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rawLink(db: any, id: string) {
  return db.prepare('SELECT deleted, edit_seq, updated FROM links WHERE id = ?').get(id) as
    { deleted: number; edit_seq: number; updated: string };
}

describe('M10 deleteLink 软删', () => {
  it('deleteLink 标记 deleted=1 + bump edit_seq + bump updated(行仍在表里)', () => {
    const db = setupTestDb();
    const a = seedNode(db, { content: 'A' });
    const b = seedNode(db, { content: 'B' });
    const link = createLink(db, { from_id: a.id, to_id: b.id, relation: [{ type: 'supports', confidence: 0.9 }] })!;
    const before = rawLink(db, link.id);

    deleteLink(db, link.id);

    const after = rawLink(db, link.id);
    expect(after.deleted).toBe(1);                    // 软删:行还在,标志置 1
    expect(after.edit_seq).toBe(before.edit_seq + 1); // bump edit_seq → 经 LWW 传播删除
    expect(after.updated >= before.updated).toBe(true);
    // 物理行仍存在(不是 hard-delete)
    const cnt = db.prepare('SELECT COUNT(*) AS c FROM links WHERE id = ?').get(link.id) as { c: number };
    expect(cnt.c).toBe(1);
  });

  it('软删后 getLinksForNode / getLinksForNodes / getLinkCount / linkExists 全部排除', () => {
    const db = setupTestDb();
    const a = seedNode(db, { content: 'A' });
    const b = seedNode(db, { content: 'B' });
    const link = createLink(db, { from_id: a.id, to_id: b.id, relation: [{ type: 'supports', confidence: 0.9 }] })!;

    expect(getLinksForNode(db, a.id).length).toBe(1);
    expect(getLinksForNodes(db, [a.id, b.id]).length).toBe(1);
    expect(getLinkCount(db)).toBe(1);
    expect(linkExists(db, a.id, b.id)).toBe(true);
    expect(linkExists(db, a.id, b.id, 'from_to')).toBe(true);

    deleteLink(db, link.id);

    expect(getLinksForNode(db, a.id).length).toBe(0);
    expect(getLinksForNodes(db, [a.id, b.id]).length).toBe(0);
    expect(getLinkCount(db)).toBe(0);
    expect(linkExists(db, a.id, b.id)).toBe(false);
    expect(linkExists(db, a.id, b.id, 'from_to')).toBe(false);
  });

  it('软删 pending link 后 getPendingLinks 排除', () => {
    const db = setupTestDb();
    const a = seedNode(db, { content: 'A' });
    const b = seedNode(db, { content: 'B' });
    const link = createLink(db, {
      from_id: a.id, to_id: b.id, relation: [{ type: 'related', confidence: 0.5 }], status: 'pending',
    })!;
    expect(getPendingLinks(db).some(l => l.id === link.id)).toBe(true);

    deleteLink(db, link.id);
    expect(getPendingLinks(db).some(l => l.id === link.id)).toBe(false);
  });

  it('linkExists 软删后允许重建同一对节点的链接(去重不被 tombstone 阻塞)', () => {
    const db = setupTestDb();
    const a = seedNode(db, { content: 'A' });
    const b = seedNode(db, { content: 'B' });
    const link = createLink(db, { from_id: a.id, to_id: b.id, relation: [{ type: 'supports', confidence: 0.9 }] })!;
    deleteLink(db, link.id);
    // 软删后 linkExists=false → 上游 dedup 守卫放行重建,新建成功
    expect(linkExists(db, a.id, b.id)).toBe(false);
    const recreated = createLink(db, { from_id: a.id, to_id: b.id, relation: [{ type: 'supports', confidence: 0.9 }] });
    expect(recreated).not.toBeNull();
    expect(getLinksForNode(db, a.id).length).toBe(1); // 只看到新建的那条(旧的 deleted=1 不计)
  });
});
