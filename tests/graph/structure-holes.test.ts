/**
 * structure-holes 计算 + 缓存测试(perf-optimization-2026-05-17 P2-1)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, _param: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

import type Database from 'better-sqlite3';
import { setupTestDb, seedNode } from '../helpers/test-db.js';
import { createLink } from '../../src/db/links.js';
import {
  computeStructureHoles,
  readStructureHolesCache,
  writeStructureHolesCache,
  runStructureHolesPrecompute,
  setStructureHolesRunner,
} from '../../src/graph/structure-holes.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
  // 每个测试前清掉注入的 runner,保证默认走内联计算(隔离 runner 测试副作用)
  setStructureHolesRunner(null);
});

describe('computeStructureHoles', () => {
  it('空图返回空数组', () => {
    expect(computeStructureHoles(db)).toEqual([]);
  });

  it('找出共享 2+ 邻居但无直接链接的节点对', () => {
    // A, B 共享 X, Y 两个邻居,无 A-B 直接链接。
    // 注意:算法是对称的——X 和 Y 也共享 A 和 B 作为邻居,所以也是结构洞。
    // 算法不区分"内容节点"和"中介节点",这是设计上的预期(产品语义由 UI 过滤)。
    const A = seedNode(db, { content: 'A content' });
    const B = seedNode(db, { content: 'B content' });
    const X = seedNode(db, { content: 'X content' });
    const Y = seedNode(db, { content: 'Y content' });

    createLink(db, { from_id: A.id, to_id: X.id, relation: [{ type: 'analogous', confidence: 0.7 }] });
    createLink(db, { from_id: B.id, to_id: X.id, relation: [{ type: 'analogous', confidence: 0.7 }] });
    createLink(db, { from_id: A.id, to_id: Y.id, relation: [{ type: 'analogous', confidence: 0.7 }] });
    createLink(db, { from_id: B.id, to_id: Y.id, relation: [{ type: 'analogous', confidence: 0.7 }] });

    const holes = computeStructureHoles(db);
    // 应包含 (A,B) 共享 {X,Y} 和 (X,Y) 共享 {A,B}
    expect(holes.length).toBe(2);
    for (const h of holes) {
      expect(h.sharedCount).toBe(2);
      expect(h.nodeAPreview).toBeTruthy();
      expect(h.nodeBPreview).toBeTruthy();
    }
  });

  it('已有直接链接的节点对不算结构洞', () => {
    const A = seedNode(db, { content: 'A' });
    const B = seedNode(db, { content: 'B' });
    const X = seedNode(db, { content: 'X' });
    const Y = seedNode(db, { content: 'Y' });

    createLink(db, { from_id: A.id, to_id: X.id, relation: [{ type: 'analogous', confidence: 0.7 }] });
    createLink(db, { from_id: B.id, to_id: X.id, relation: [{ type: 'analogous', confidence: 0.7 }] });
    createLink(db, { from_id: A.id, to_id: Y.id, relation: [{ type: 'analogous', confidence: 0.7 }] });
    createLink(db, { from_id: B.id, to_id: Y.id, relation: [{ type: 'analogous', confidence: 0.7 }] });
    // A-B 直接链接 → (A,B) 不再是结构洞,但 (X,Y) 仍是
    createLink(db, { from_id: A.id, to_id: B.id, relation: [{ type: 'related', confidence: 0.7 }] });

    const holes = computeStructureHoles(db);
    // 仅剩 (X,Y) 共享 {A,B}
    const ids = holes.map(h => [h.nodeA, h.nodeB].sort()).map(p => p.join(','));
    const xy = [X.id, Y.id].sort().join(',');
    expect(ids).toContain(xy);
    const ab = [A.id, B.id].sort().join(',');
    expect(ids).not.toContain(ab);
  });

  it('limit 截断', () => {
    // 3 组独立的 4 节点 cliquoid:每组内 A_i 和 B_i 共享 X_i, Y_i,
    // 不同组之间无邻居重叠。算法对称,每组贡献 2 个结构洞,共 6 个。
    for (let i = 0; i < 3; i++) {
      const a = seedNode(db, { content: `a${i}` });
      const b = seedNode(db, { content: `b${i}` });
      const x = seedNode(db, { content: `x${i}` });
      const y = seedNode(db, { content: `y${i}` });
      createLink(db, { from_id: a.id, to_id: x.id, relation: [{ type: 'analogous', confidence: 0.7 }] });
      createLink(db, { from_id: b.id, to_id: x.id, relation: [{ type: 'analogous', confidence: 0.7 }] });
      createLink(db, { from_id: a.id, to_id: y.id, relation: [{ type: 'analogous', confidence: 0.7 }] });
      createLink(db, { from_id: b.id, to_id: y.id, relation: [{ type: 'analogous', confidence: 0.7 }] });
    }

    expect(computeStructureHoles(db, 3).length).toBe(3);
    expect(computeStructureHoles(db, 100).length).toBe(6);
  });

  it('已归档节点不进入候选对,也不作为共享邻居计数(归档不删 links)', () => {
    // A,B 共享 X,Y → 归档前 (A,B) 与 (X,Y) 都是洞
    const A = seedNode(db, { content: 'A content' });
    const B = seedNode(db, { content: 'B content' });
    const X = seedNode(db, { content: 'X content' });
    const Y = seedNode(db, { content: 'Y content' });
    createLink(db, { from_id: A.id, to_id: X.id, relation: [{ type: 'analogous', confidence: 0.7 }] });
    createLink(db, { from_id: B.id, to_id: X.id, relation: [{ type: 'analogous', confidence: 0.7 }] });
    createLink(db, { from_id: A.id, to_id: Y.id, relation: [{ type: 'analogous', confidence: 0.7 }] });
    createLink(db, { from_id: B.id, to_id: Y.id, relation: [{ type: 'analogous', confidence: 0.7 }] });
    expect(computeStructureHoles(db).length).toBe(2);

    // 模拟 archiveNodeWithVectors:archived=1 + heat=0.02,links 保留
    db.prepare('UPDATE nodes SET archived = 1, heat = 0.02 WHERE id = ?').run(A.id);

    const holes = computeStructureHoles(db);
    // A 不能出现在任何候选对;X,Y 失去共享邻居 A 后只剩 B,不足 2 → 全部消失
    for (const h of holes) {
      expect([h.nodeA, h.nodeB]).not.toContain(A.id);
    }
    expect(holes.length).toBe(0);
  });

  it('is_superseded 节点同样被排除', () => {
    const A = seedNode(db, { content: 'A content' });
    const B = seedNode(db, { content: 'B content' });
    const X = seedNode(db, { content: 'X content' });
    const Y = seedNode(db, { content: 'Y content' });
    createLink(db, { from_id: A.id, to_id: X.id, relation: [{ type: 'analogous', confidence: 0.7 }] });
    createLink(db, { from_id: B.id, to_id: X.id, relation: [{ type: 'analogous', confidence: 0.7 }] });
    createLink(db, { from_id: A.id, to_id: Y.id, relation: [{ type: 'analogous', confidence: 0.7 }] });
    createLink(db, { from_id: B.id, to_id: Y.id, relation: [{ type: 'analogous', confidence: 0.7 }] });

    db.prepare('UPDATE nodes SET is_superseded = 1 WHERE id = ?').run(B.id);

    const holes = computeStructureHoles(db);
    for (const h of holes) {
      expect([h.nodeA, h.nodeB]).not.toContain(B.id);
    }
    expect(holes.length).toBe(0);
  });
});

describe('structure_holes cache 读写', () => {
  it('初始无缓存返回 null', () => {
    expect(readStructureHolesCache(db)).toBeNull();
  });

  it('write+read 往返一致', () => {
    const sample = [
      { nodeA: 'a1', nodeB: 'b1', sharedCount: 3, nodeAPreview: 'aa', nodeBPreview: 'bb' },
    ];
    writeStructureHolesCache(db, sample);
    const cached = readStructureHolesCache(db);
    expect(cached?.holes).toEqual(sample);
    expect(cached?.computedAt).toBeTruthy();
  });

  it('UPSERT 单行 id=1,重复写覆盖', () => {
    writeStructureHolesCache(db, [{ nodeA: 'x', nodeB: 'y', sharedCount: 1, nodeAPreview: '', nodeBPreview: '' }]);
    writeStructureHolesCache(db, [{ nodeA: 'p', nodeB: 'q', sharedCount: 2, nodeAPreview: '', nodeBPreview: '' }]);
    const cached = readStructureHolesCache(db);
    expect(cached?.holes.length).toBe(1);
    expect(cached?.holes[0].nodeA).toBe('p');

    const rowCount = (db.prepare('SELECT COUNT(*) AS cnt FROM structure_holes_cache').get() as { cnt: number }).cnt;
    expect(rowCount).toBe(1);
  });
});

describe('runStructureHolesPrecompute', () => {
  it('计算后写入缓存,可被 read 拿到', async () => {
    const A = seedNode(db, { content: 'A' });
    const B = seedNode(db, { content: 'B' });
    const X = seedNode(db, { content: 'X' });
    const Y = seedNode(db, { content: 'Y' });
    createLink(db, { from_id: A.id, to_id: X.id, relation: [{ type: 'analogous', confidence: 0.7 }] });
    createLink(db, { from_id: B.id, to_id: X.id, relation: [{ type: 'analogous', confidence: 0.7 }] });
    createLink(db, { from_id: A.id, to_id: Y.id, relation: [{ type: 'analogous', confidence: 0.7 }] });
    createLink(db, { from_id: B.id, to_id: Y.id, relation: [{ type: 'analogous', confidence: 0.7 }] });

    await runStructureHolesPrecompute(db);

    const cache = readStructureHolesCache(db);
    expect(cache).not.toBeNull();
    // (A,B) 与 (X,Y) 都算结构洞
    expect(cache!.holes.length).toBe(2);
  });
});

describe('setStructureHolesRunner（v0.2.74 CRITICAL #1 worker 注入）', () => {
  it('注入 runner 后,runStructureHolesPrecompute 用 runner 的结果写缓存(不走内联计算)', async () => {
    // 注入一个返回固定结果的假 runner —— 模拟 worker 算完回传。
    // 如果内联计算被错误地仍然执行,空图会返回 [],下面断言就会失败。
    const injected = [
      { nodeA: 'w1', nodeB: 'w2', sharedCount: 5, nodeAPreview: 'from-worker-a', nodeBPreview: 'from-worker-b' },
    ];
    let called = 0;
    setStructureHolesRunner(async (passedDb) => {
      called++;
      expect(passedDb).toBe(db); // runner 拿到的是主线程 db(用来取 db.name)
      return injected;
    });

    await runStructureHolesPrecompute(db);

    expect(called).toBe(1);
    const cache = readStructureHolesCache(db);
    expect(cache?.holes).toEqual(injected);
  });

  it('runner 抛错时 runStructureHolesPrecompute 不抛(daemon swallow),缓存保持旧值', async () => {
    // 先写一份旧缓存
    const old = [{ nodeA: 'old', nodeB: 'val', sharedCount: 1, nodeAPreview: '', nodeBPreview: '' }];
    writeStructureHolesCache(db, old);

    setStructureHolesRunner(async () => {
      throw new Error('worker spawn failed / timeout');
    });

    // 不应抛出(graceful skip)
    await expect(runStructureHolesPrecompute(db)).resolves.toBeUndefined();
    // 缓存未被覆盖(worker 失败时不写脏数据)
    expect(readStructureHolesCache(db)?.holes).toEqual(old);
  });

  it('setStructureHolesRunner(null) 恢复内联计算', async () => {
    const A = seedNode(db, { content: 'A' });
    const B = seedNode(db, { content: 'B' });
    const X = seedNode(db, { content: 'X' });
    const Y = seedNode(db, { content: 'Y' });
    createLink(db, { from_id: A.id, to_id: X.id, relation: [{ type: 'analogous', confidence: 0.7 }] });
    createLink(db, { from_id: B.id, to_id: X.id, relation: [{ type: 'analogous', confidence: 0.7 }] });
    createLink(db, { from_id: A.id, to_id: Y.id, relation: [{ type: 'analogous', confidence: 0.7 }] });
    createLink(db, { from_id: B.id, to_id: Y.id, relation: [{ type: 'analogous', confidence: 0.7 }] });

    setStructureHolesRunner(async () => [{ nodeA: 'should-not', nodeB: 'be-used', sharedCount: 9, nodeAPreview: '', nodeBPreview: '' }]);
    setStructureHolesRunner(null); // 清掉 → 回内联

    await runStructureHolesPrecompute(db);
    const cache = readStructureHolesCache(db);
    // 内联计算真实图 → 2 个结构洞,而不是上面那条假数据
    expect(cache!.holes.length).toBe(2);
    expect(cache!.holes.some(h => h.nodeA === 'should-not')).toBe(false);
  });
});
