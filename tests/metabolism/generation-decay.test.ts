/**
 * M8.5 客户端 generation 驱动重算测试。
 */

import { describe, it, expect } from 'vitest';
import { setupTestDb, seedNode } from '../helpers/test-db.js';
import { recomputeToGeneration, getLocalGeneration } from '../../src/metabolism/generation-decay.js';
import { runSynapticScaling } from '../../src/metabolism/synaptic.js';
import { unarchiveNodeRecordOnly } from '../../src/db/node-lifecycle.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function nodeRow(db: any, id: string): { heat: number; decay_gen: number; maturity_score: number } {
  return db.prepare('SELECT heat, decay_gen, maturity_score FROM nodes WHERE id = ?').get(id);
}

describe('M8.5 recomputeToGeneration', () => {
  // 预设本地 generation 到 g(绕过"首次采纳锚定"分支,测稳态 delta 衰减)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const seedLocalGen = (db: any, g: number) => db.prepare("INSERT OR REPLACE INTO metadata (key,value) VALUES ('cloud.decay_generation', ?)").run(String(g));

  it('CRITICAL:首次采纳(localG=0)→ 锚定 decay_gen=G、不衰减 heat(防存量升级暴跌)', () => {
    const db = setupTestDb();
    const n = seedNode(db, { content: 'x' });
    db.prepare('UPDATE nodes SET heat=1.0, connectivity=0, decay_gen=0 WHERE id=?').run(n.id);
    const count = recomputeToGeneration(db, 30); // 部署 skew:云端 G 已涨到 30
    expect(count).toBe(0); // 首次只锚定,不衰减
    const row = nodeRow(db, n.id);
    expect(row.heat).toBe(1.0); // heat 保持旧态,不被 0.95^30 砸向下限
    expect(row.decay_gen).toBe(30); // 锚定到当前 G
    expect(getLocalGeneration(db)).toBe(30);
  });

  it('首次锚定后,后续 recompute 按 delta 衰减', () => {
    const db = setupTestDb();
    const n = seedNode(db, { content: 'x' });
    db.prepare('UPDATE nodes SET heat=1.0, connectivity=0, decay_gen=0 WHERE id=?').run(n.id);
    recomputeToGeneration(db, 3); // 首次锚定 decay_gen=3, localG=3
    const count = recomputeToGeneration(db, 4); // localG=3<4, gen=4-3=1
    expect(count).toBe(1);
    expect(nodeRow(db, n.id).heat).toBeCloseTo(0.95, 6);
    expect(nodeRow(db, n.id).decay_gen).toBe(4);
  });

  it('稳态:衰减到 G(gen 代)+ 设 decay_gen + 本地 generation', () => {
    const db = setupTestDb();
    const n = seedNode(db, { content: 'x' });
    db.prepare('UPDATE nodes SET heat=1.0, connectivity=0, decay_gen=2 WHERE id=?').run(n.id);
    seedLocalGen(db, 2); // 预设已采纳 localG=2
    const count = recomputeToGeneration(db, 5); // gen=5-2=3, conn=0 → 0.95^3
    expect(count).toBe(1);
    expect(nodeRow(db, n.id).heat).toBeCloseTo(Math.pow(0.95, 3), 6);
    expect(nodeRow(db, n.id).decay_gen).toBe(5);
    expect(getLocalGeneration(db)).toBe(5);
  });

  it('G <= 本地 generation 幂等不动', () => {
    const db = setupTestDb();
    const n = seedNode(db, { content: 'x' });
    db.prepare('UPDATE nodes SET heat=1.0, connectivity=0, decay_gen=5 WHERE id=?').run(n.id);
    seedLocalGen(db, 5);
    const before = nodeRow(db, n.id).heat;
    const count = recomputeToGeneration(db, 5); // 同 G
    expect(count).toBe(0);
    expect(nodeRow(db, n.id).heat).toBe(before);
  });

  it('已锚定到 ≥G 的节点 gen=0 不重复衰减(混合 decay_gen)', () => {
    const db = setupTestDb();
    const n = seedNode(db, { content: 'x' });
    db.prepare('UPDATE nodes SET heat=1.0, connectivity=0, decay_gen=7 WHERE id=?').run(n.id);
    seedLocalGen(db, 5); // localG=5<7
    recomputeToGeneration(db, 7); // 节点 gen=7-7=0 跳过
    expect(nodeRow(db, n.id).heat).toBe(1.0);
  });

  it('archived 节点不参与(首次锚定也不锚)', () => {
    const db = setupTestDb();
    const n = seedNode(db, { content: 'x' });
    db.prepare('UPDATE nodes SET heat=1.0, connectivity=0, decay_gen=0, archived=1 WHERE id=?').run(n.id);
    recomputeToGeneration(db, 3);
    expect(nodeRow(db, n.id).heat).toBe(1.0);
  });

  it('connectivity 加权:高 conn 衰减更慢(稳态)', () => {
    const db = setupTestDb();
    const a = seedNode(db, { content: 'a' });
    const b = seedNode(db, { content: 'b' });
    db.prepare('UPDATE nodes SET heat=1.0, connectivity=0, decay_gen=5 WHERE id=?').run(a.id);
    db.prepare('UPDATE nodes SET heat=1.0, connectivity=1, decay_gen=5 WHERE id=?').run(b.id);
    seedLocalGen(db, 5);
    recomputeToGeneration(db, 6); // gen=1
    expect(nodeRow(db, a.id).heat).toBeCloseTo(0.95, 6); // conn=0
    expect(nodeRow(db, b.id).heat).toBeCloseTo(0.99, 6); // conn=1
  });
});

describe('M8.5 daily synaptic gating(云同步用户跳过,避免双重衰减)', () => {
  it('云同步活跃(cloud_last_synced_version 存在)→ skip,decayed=0、heat 不变', () => {
    const db = setupTestDb();
    const n = seedNode(db, { content: 'x' });
    db.prepare('UPDATE nodes SET heat=1.0 WHERE id=?').run(n.id);
    db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('cloud_last_synced_version', '100')").run();
    const r = runSynapticScaling(db);
    expect(r.decayed).toBe(0);
    expect((db.prepare('SELECT heat FROM nodes WHERE id=?').get(n.id) as { heat: number }).heat).toBe(1.0);
  });

  it('纯本地(无 cloud_last_synced_version)→ 正常 wall-clock 衰减', () => {
    const db = setupTestDb();
    const n = seedNode(db, { content: 'x' });
    db.prepare('UPDATE nodes SET heat=1.0, connectivity=0 WHERE id=?').run(n.id);
    const r = runSynapticScaling(db);
    expect(r.decayed).toBeGreaterThan(0);
    expect((db.prepare('SELECT heat FROM nodes WHERE id=?').get(n.id) as { heat: number }).heat).toBeLessThan(1.0);
  });
});

describe('M8 unarchive 重锚 decay_gen(审计 HIGH:防恢复 heat 暴跌)', () => {
  it('unarchive 把 decay_gen 重锚到本地 generation(不停在归档时的旧值)', () => {
    const db = setupTestDb();
    const n = seedNode(db, { content: 'x' });
    db.prepare('UPDATE nodes SET archived=1, decay_gen=2 WHERE id=?').run(n.id);
    db.prepare("INSERT OR REPLACE INTO metadata (key,value) VALUES ('cloud.decay_generation','10')").run();
    const ok = unarchiveNodeRecordOnly(db, n.id);
    expect(ok).toBe(true);
    const row = db.prepare('SELECT archived, decay_gen, heat FROM nodes WHERE id=?').get(n.id) as { archived: number; decay_gen: number; heat: number };
    expect(row.archived).toBe(0);
    expect(row.decay_gen).toBe(10); // 重锚到当前 G;否则停在 2 → 下次 recompute gen=G-2 巨大 → heat 暴跌
    expect(row.heat).toBe(0.5);
  });
});
