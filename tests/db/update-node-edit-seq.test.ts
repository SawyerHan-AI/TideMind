/**
 * CRITICAL 修复回归(审计):updateNode 的 edit_seq bump 语义 —— 代谢内容改写必须与用户编辑
 * 可区分,否则跨设备并发时本地代谢会静默覆盖用户编辑(丢数据)。
 */

import { describe, it, expect } from 'vitest';
import { setupTestDb, seedNode } from '../helpers/test-db.js';
import { updateNode, getNode } from '../../src/db/nodes.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const editSeq = (db: any, id: string): number => getNode(db, id)!.edit_seq;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ver = (db: any, id: string): number => getNode(db, id)!.version;

describe('updateNode edit_seq bump 语义', () => {
  it('用户编辑内容类字段(content)→ bump edit_seq', () => {
    const db = setupTestDb();
    const n = seedNode(db, { content: 'x' });
    const before = editSeq(db, n.id);
    updateNode(db, n.id, { content: 'user edited' });
    expect(editSeq(db, n.id)).toBe(before + 1);
  });

  it('CRITICAL:代谢改写(skipEditSeqBump)→ 内容改了但 edit_seq 不 bump', () => {
    const db = setupTestDb();
    const n = seedNode(db, { content: 'x' });
    const before = editSeq(db, n.id);
    updateNode(db, n.id, { content: 'metabolized' }, 'reconsolidation', { skipEditSeqBump: true });
    expect(getNode(db, n.id)!.content).toBe('metabolized'); // 内容确实改了
    expect(editSeq(db, n.id)).toBe(before); // 但 edit_seq 不动 → 用户编辑(更高 edit_seq)永远赢
  });

  it('派生字段(heat)变更 → 不 bump edit_seq', () => {
    const db = setupTestDb();
    const n = seedNode(db, { content: 'x' });
    const before = editSeq(db, n.id);
    updateNode(db, n.id, { heat: 0.5 });
    expect(editSeq(db, n.id)).toBe(before);
  });

  it('代谢 skipEditSeqBump 仍 bump version(谱系门控不受影响)', () => {
    const db = setupTestDb();
    const n = seedNode(db, { content: 'x' });
    const before = ver(db, n.id);
    updateNode(db, n.id, { content: 'metabolized' }, 'reconsolidation', { skipEditSeqBump: true });
    expect(ver(db, n.id)).toBe(before + 1); // version 仍 +1(代谢谱系),只 edit_seq 因果版本不动
  });
});
