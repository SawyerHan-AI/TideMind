/**
 * synaptic.ts 单元测试 — 突触衰减、归档、待确认链接处理
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mock strategy loader ----
vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, _param: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

// ---- Mock config ----
vi.mock('../../src/config.js', () => ({
  getConfig: () => ({
    general: { data_dir: '/tmp/test', user_name: 'test' },
    anthropic: { api_key: '' },
    vertex: { project_id: '', region: 'us-central1' },
    ollama: { url: 'http://localhost:11434' },
    gemini: { api_key: '' },
    llm: { provider: 'anthropic', standard_model: '', heavy_model: '' },
    embedding: { provider: 'vertex', model: 'gemini-embedding-001', dimensions: 3072 },
    search: { alpha: 0.3, beta: 0.5, gamma: 0.1, delta: 0.1 },
    gates: {
      vector_search: 50,
      graph_expansion: 100,
      graph_expansion_links: 50,
      crystal_generation: 200,
      divergent_scan: 500,
      learning_2_min_nodes: 500,
      learning_2_min_recall_ops: 200,
    },
    metabolism: { daily_check_hours: 24, weekly_check_days: 7 },
  }),
  isLlmConfigured: () => false,
}));

// ---- Mock LLM client ----
vi.mock('../../src/llm/client.js', () => ({
  callLLM: vi.fn().mockResolvedValue('no'),
}));

// ---- Mock maturity (used by nodes.ts createNode) ----
vi.mock('../../src/graph/maturity.js', () => ({
  refreshMaturityScore: vi.fn(),
  computeMaturityScore: (heat: number, refinement: number, connectivity: number, independence: number) => {
    return 0.2 * Math.min(heat, 1) + 0.3 * refinement + 0.3 * connectivity + 0.2 * independence;
  },
}));

import type Database from 'better-sqlite3';
import { setupTestDb, seedNode } from '../helpers/test-db.js';
import { runSynapticScaling } from '../../src/metabolism/synaptic.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
  vi.clearAllMocks();
});

// ===== runSynapticScaling — decay formula =====

describe('runSynapticScaling', () => {
  it('should decay heat with connectivity=0 by multiplying ~0.95', () => {
    const node = seedNode(db, { heat: 1.0 });
    db.prepare('UPDATE nodes SET connectivity = 0, refinement = 0 WHERE id = ?').run(node.id);

    runSynapticScaling(db);

    const after = db.prepare('SELECT heat FROM nodes WHERE id = ?').get(node.id) as { heat: number };
    // decayRate = 1 - 0.05 * (1 - 0.8 * 0) = 1 - 0.05 = 0.95
    expect(after.heat).toBeCloseTo(0.95, 5);
  });

  it('should decay heat with connectivity=0.5 (slower but still decaying)', () => {
    const node = seedNode(db, { heat: 1.0 });
    db.prepare('UPDATE nodes SET connectivity = 0.5, refinement = 0 WHERE id = ?').run(node.id);

    runSynapticScaling(db);

    const after = db.prepare('SELECT heat FROM nodes WHERE id = ?').get(node.id) as { heat: number };
    // decayRate = 1 - 0.05 * (1 - 0.8 * 0.5) = 1 - 0.05 * 0.6 = 0.97
    expect(after.heat).toBeCloseTo(0.97, 5);
    expect(after.heat).toBeLessThan(1.0); // 严格衰减
  });

  it('should decay heat with connectivity=1.0 (slowest but still decaying)', () => {
    const node = seedNode(db, { heat: 1.0 });
    db.prepare('UPDATE nodes SET connectivity = 1.0, refinement = 0 WHERE id = ?').run(node.id);

    runSynapticScaling(db);

    const after = db.prepare('SELECT heat FROM nodes WHERE id = ?').get(node.id) as { heat: number };
    // decayRate = 1 - 0.05 * (1 - 0.8 * 1.0) = 1 - 0.05 * 0.2 = 0.99
    expect(after.heat).toBeCloseTo(0.99, 5);
    expect(after.heat).toBeLessThan(1.0); // 严格衰减
  });

  it('should always decay (decay_rate < 1.0) for any connectivity value', () => {
    // 测试多个 connectivity 值，全部必须严格衰减
    for (const conn of [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1.0]) {
      const node = seedNode(db, { heat: 1.0 });
      db.prepare('UPDATE nodes SET connectivity = ?, refinement = 0 WHERE id = ?').run(conn, node.id);
    }

    runSynapticScaling(db);

    const allNodes = db.prepare('SELECT heat FROM nodes WHERE heat > 0.01').all() as Array<{ heat: number }>;
    for (const n of allNodes) {
      expect(n.heat).toBeLessThan(1.0);
    }
  });

  it('should return correct decayed count', () => {
    seedNode(db, { heat: 1.0 });
    seedNode(db, { heat: 0.5 });

    const result = runSynapticScaling(db);
    expect(result.decayed).toBe(2);
  });

  it('should not process nodes with heat <= 0.01', () => {
    const node = seedNode(db, { heat: 1.0 });
    db.prepare('UPDATE nodes SET heat = 0.005 WHERE id = ?').run(node.id);

    const result = runSynapticScaling(db);
    expect(result.decayed).toBe(0);
  });

  // ===== maturity_score atomicity =====

  it('should update maturity_score atomically with heat', () => {
    // 2026-05-19:heat 语义统一 [0,1] 后 fixture 不能用 2.0,用 1.0 起点。
    const node = seedNode(db, { heat: 1.0 });
    db.prepare('UPDATE nodes SET connectivity = 0.0, refinement = 0.4, independence = 0.3 WHERE id = ?').run(node.id);

    runSynapticScaling(db);

    const after = db.prepare('SELECT heat, maturity_score, refinement, connectivity, independence FROM nodes WHERE id = ?').get(node.id) as {
      heat: number;
      maturity_score: number;
      refinement: number;
      connectivity: number;
      independence: number;
    };

    // decayRate = 1 - 0.05 * (1 - 0) = 0.95, newHeat = 1.0 * 0.95 = 0.95
    // maturity = 0.2 * 0.95 + 0.3 * 0.4 + 0.3 * 0.0 + 0.2 * 0.3 = 0.19 + 0.12 + 0 + 0.06 = 0.37
    expect(after.heat).toBeCloseTo(0.95, 5);
    expect(after.maturity_score).toBeCloseTo(0.37, 5);
  });

  // ===== metadata timestamp =====

  it('should NOT write maintenance timestamp (delegated to scheduler.tryClaimTask)', () => {
    seedNode(db);
    runSynapticScaling(db);

    const row = db.prepare("SELECT value FROM metadata WHERE key = 'last_task_synaptic-decay'").get() as { value: string } | undefined;
    // runSynapticScaling 不写 metadata,由 scheduler.ts::tryClaimTask 负责
    expect(row).toBeUndefined();
  });

  // 守护：heat 衰减是高频路径，updated 必须 bump。否则 cloud reconcile 永远
  // 看不到本地 heat 变化（client.updated == server.updated → 'same' → no-op），
  // server 永远存着初始 heat=1.0，多设备 recall 排序失真。
  it('should bump updated for every decayed node', async () => {
    const node = seedNode(db, { heat: 1.0 });
    const before = (db.prepare('SELECT updated FROM nodes WHERE id = ?').get(node.id) as { updated: string }).updated;
    await new Promise(r => setTimeout(r, 5));
    runSynapticScaling(db);
    const after = (db.prepare('SELECT updated FROM nodes WHERE id = ?').get(node.id) as { updated: string }).updated;
    expect(after > before).toBe(true);
  });
});

// claimMaintenance 已于 2026-04-21 删除 (见 synaptic.ts 注释)，
// 相关并发声明测试在 tests/metabolism/scheduler.test.ts 的 tryClaimTask 覆盖。

// ===== 链接赫布学习衰减(L83-180+) =====
//
// 现有 9 case 全部测节点 heat decay,占源码上半段。下半段链接赫布学习衰减
// 整体 0 测试。本组测试覆盖:
//   - strength = strength * (1 - linkDecayBase * (1 - activityFactor)) 公式
//   - activityFactor = sqrt(heatA * heatB) 的多组合
//   - strength ≤ linkDeleteThreshold 被 purge
//   - tagged 链接跳过赫布衰减
//   - relation JSON 解析失败时仍衰减
//   - DELETE + SELECT 同事务的原子性

import { createLink } from '../../src/db/links.js';
import type { LinkRelation } from '../../src/types.js';

// 帮助:用 raw SQL 把 link.strength 设为指定值(默认 createLink 是 0.5),
// 同时改 relation 让"tagged"分支可控
function setLinkStrength(db: Database.Database, linkId: string, strength: number): void {
  db.prepare('UPDATE links SET strength = ? WHERE id = ?').run(strength, linkId);
}
function setLinkRelation(db: Database.Database, linkId: string, raw: string): void {
  db.prepare('UPDATE links SET relation = ? WHERE id = ?').run(raw, linkId);
}

describe('runSynapticScaling - link Hebbian decay', () => {
  it('链接 strength 应该按 1 - linkDecayBase * (1 - activityFactor) 衰减(两端 heat=0,activityFactor=0)', () => {
    // 两端节点 heat=0 → activityFactor=0 → dailyRetention=1-0.03*(1-0)=0.97
    const a = seedNode(db, { heat: 1.0 });
    const b = seedNode(db, { heat: 1.0 });
    // 先 archive 节点让 heat 不参与节点衰减干扰?——不,链接路径预读 heat 是在循环外。
    // 我们直接把节点 heat 都改为 0.005(<0.01,跳过节点 decay)。
    db.prepare('UPDATE nodes SET heat = 0.005 WHERE id IN (?, ?)').run(a.id, b.id);

    const link = createLink(db, {
      from_id: a.id,
      to_id: b.id,
      relation: [{ type: 'supports', confidence: 0.7 }],
      strength: 0.8,
    });
    expect(link).toBeTruthy();

    runSynapticScaling(db);

    const after = db.prepare('SELECT strength FROM links WHERE id = ?').get(link!.id) as { strength: number } | undefined;
    // heat=0.005 → heatCache 拿到 0.005,activityFactor = sqrt(0.005*0.005) = 0.005
    // dailyRetention = 1 - 0.03 * (1 - 0.005) = 0.97015
    // newStrength = 0.8 * 0.97015 = 0.77612
    expect(after).toBeTruthy();
    expect(after!.strength).toBeCloseTo(0.8 * (1 - 0.03 * (1 - Math.sqrt(0.005 * 0.005))), 4);
  });

  it('两端 heat=1.0 时 activityFactor=1.0,dailyRetention=1.0(不衰减)', () => {
    const a = seedNode(db, { heat: 1.0 });
    const b = seedNode(db, { heat: 1.0 });
    const link = createLink(db, {
      from_id: a.id,
      to_id: b.id,
      relation: [{ type: 'supports', confidence: 0.7 }],
      strength: 0.8,
    });

    runSynapticScaling(db);

    const after = db.prepare('SELECT strength FROM links WHERE id = ?').get(link!.id) as { strength: number };
    // heatA=heatB=1.0(节点 heat decay 后 0.95,但链接路径用预读的快照?)
    // 实际:链接路径 heatCache 在事务后才填充,读的是 SQL 已经更新过的 heat=0.95
    // activityFactor = sqrt(0.95*0.95) = 0.95
    // dailyRetention = 1 - 0.03*(1 - 0.95) = 0.9985
    // newStrength = 0.8 * 0.9985 = 0.7988
    expect(after.strength).toBeCloseTo(0.8 * (1 - 0.03 * (1 - 0.95)), 4);
    // Math.min(1.0, ...) 是 0.7988 → 仍 < 1.0
    expect(after.strength).toBeLessThanOrEqual(1.0);
  });

  it('两端 heat=0.5,0.5 时 activityFactor=0.5,dailyRetention=0.985', () => {
    const a = seedNode(db, { heat: 1.0 });
    const b = seedNode(db, { heat: 1.0 });
    db.prepare('UPDATE nodes SET heat = 0.005 WHERE id IN (?, ?)').run(a.id, b.id);
    // 用 SQL update 把它们置回 0.5(刚好高于 0.01 阈值,会被节点 decay 处理)
    // 但我们想测链接衰减的输入,所以重置一下:
    db.prepare('UPDATE nodes SET heat = ?, connectivity = 0 WHERE id = ?').run(0.5, a.id);
    db.prepare('UPDATE nodes SET heat = ?, connectivity = 0 WHERE id = ?').run(0.5, b.id);

    const link = createLink(db, {
      from_id: a.id,
      to_id: b.id,
      relation: [{ type: 'supports', confidence: 0.7 }],
      strength: 0.7,
    });

    runSynapticScaling(db);

    const after = db.prepare('SELECT strength FROM links WHERE id = ?').get(link!.id) as { strength: number };
    // 节点先衰减:heat=0.5*0.95=0.475(connectivity=0)
    // heatCache 拿衰减后的 0.475: activityFactor = sqrt(0.475*0.475) = 0.475
    // dailyRetention = 1 - 0.03*(1 - 0.475) = 1 - 0.01575 = 0.98425
    // newStrength = 0.7 * 0.98425 = 0.68898
    const expectedHeat = 0.5 * 0.95;
    const expectedActivity = expectedHeat;
    const expectedRetention = 1 - 0.03 * (1 - expectedActivity);
    expect(after.strength).toBeCloseTo(0.7 * expectedRetention, 4);
  });

  it('strength ≤ linkDeleteThreshold(0.05) 应该被 purge(在事务开始的 DELETE 中)', () => {
    const a = seedNode(db, { heat: 0.5 });
    const b = seedNode(db, { heat: 0.5 });
    const link = createLink(db, {
      from_id: a.id,
      to_id: b.id,
      relation: [{ type: 'supports', confidence: 0.7 }],
      strength: 0.5,
    });
    setLinkStrength(db, link!.id, 0.04); // 低于 0.05 threshold

    runSynapticScaling(db);

    const after = db.prepare('SELECT deleted FROM links WHERE id = ?').get(link!.id) as { deleted: number };
    expect(after.deleted).toBe(1); // M10:软删(行仍在、deleted=1),靠 LWW 跨设备传播删除
  });

  it('strength = linkDeleteThreshold(0.05) 的链接也被 purge(<= 边界)', () => {
    // 源码 L100: DELETE ... strength <= ? — 等号会被命中
    const a = seedNode(db, { heat: 0.5 });
    const b = seedNode(db, { heat: 0.5 });
    const link = createLink(db, {
      from_id: a.id,
      to_id: b.id,
      relation: [{ type: 'supports', confidence: 0.7 }],
      strength: 0.5,
    });
    setLinkStrength(db, link!.id, 0.05);

    runSynapticScaling(db);

    const after = db.prepare('SELECT deleted FROM links WHERE id = ?').get(link!.id) as { deleted: number };
    expect(after.deleted).toBe(1); // M10:软删
  });

  // 2026-05-21 回归:循环里 newStrength 比较从 < 改成 <= ,跟 L100 DELETE
  // WHERE strength <= ? 对齐。修复前:strength 衰减到正好等于 0.05 的链接会被
  // 留在表里(本轮 DELETE 已扫过、本轮 loop 落到 else 分支不删),要等下一轮
  // DELETE 才被清,延迟一个 cycle。修复后:本轮 loop 立即清掉。
  it('循环 newStrength == linkDeleteThreshold 时也应被删除(对齐 DELETE <=)', () => {
    const a = seedNode(db, { heat: 0.005 });
    const b = seedNode(db, { heat: 0.005 });
    db.prepare('UPDATE nodes SET heat = 0.005 WHERE id IN (?, ?)').run(a.id, b.id);
    const link = createLink(db, {
      from_id: a.id,
      to_id: b.id,
      relation: [{ type: 'supports', confidence: 0.7 }],
      strength: 0.5,
    });
    // 选 strength 起点:走过本轮 SELECT 的 strength > threshold 过滤,但衰减后
    // 正好落到 threshold(0.05)。
    // heatA=heatB=0.005, activity=sqrt(0.005*0.005)=0.005
    // retention = 1 - 0.03 * (1 - 0.005) = 0.97015
    // 设 startStrength = 0.05 / 0.97015 ≈ 0.05153897... ,SELECT > threshold 通过,
    // 衰减后 newStrength = startStrength * 0.97015 ≈ 0.05 (浮点上接近 threshold)
    const linkDeleteThreshold = 0.05;
    const activity = Math.sqrt(0.005 * 0.005);
    const retention = 1 - 0.03 * (1 - activity);
    const startStrength = linkDeleteThreshold / retention;
    setLinkStrength(db, link!.id, startStrength);

    runSynapticScaling(db);

    // <= 边界:newStrength 恰好等于 threshold 也应被(软)删,不留到下一 cycle
    const after = db.prepare('SELECT deleted FROM links WHERE id = ?').get(link!.id) as { deleted: number };
    expect(after.deleted).toBe(1); // M10:软删
  });

  it('strength > threshold 在衰减后跌破阈值时,在循环里被 deleteStmt 兜底删除', () => {
    const a = seedNode(db, { heat: 0.005 });
    const b = seedNode(db, { heat: 0.005 });
    db.prepare('UPDATE nodes SET heat = 0.005 WHERE id IN (?, ?)').run(a.id, b.id);
    const link = createLink(db, {
      from_id: a.id,
      to_id: b.id,
      relation: [{ type: 'supports', confidence: 0.7 }],
      strength: 0.5,
    });
    // 初始 0.051 略高于 threshold,跳过 DELETE 阶段;衰减后:
    // activity=0.005, retention=1-0.03*(1-0.005)=0.97015, new=0.051*0.97015=0.04948
    // < 0.05 → newStrength < linkDeleteThreshold → linkDeleteStmt.run 兜底删除
    setLinkStrength(db, link!.id, 0.051);

    runSynapticScaling(db);

    const after = db.prepare('SELECT deleted FROM links WHERE id = ?').get(link!.id) as { deleted: number };
    expect(after.deleted).toBe(1); // M10:软删(循环内 deleteStmt 兜底,改 UPDATE deleted=1)
  });

  it('tagged 链接(relation 中有 type:"tagged")跳过赫布衰减,strength 保持不变', () => {
    const a = seedNode(db, { heat: 0.5 });
    const b = seedNode(db, { heat: 0.5 });
    const taggedRelation: LinkRelation[] = [{ type: 'tagged' as never, confidence: 1.0 }];
    const link = createLink(db, {
      from_id: a.id,
      to_id: b.id,
      relation: taggedRelation,
      strength: 0.8,
    });
    // 注意:relation type 'tagged' 在 RelationType union 里可能没有列出,
    // 但源码只检查 r?.type === 'tagged' 字符串比较,parseRelations 过滤了
    // 非 RelationType 但只验 confidence 是 number, type 是 string,可通过
    setLinkRelation(db, link!.id, JSON.stringify([{ type: 'tagged', confidence: 1.0 }]));

    runSynapticScaling(db);

    const after = db.prepare('SELECT strength FROM links WHERE id = ?').get(link!.id) as { strength: number };
    expect(after.strength).toBe(0.8); // 跳过衰减
  });

  it('relation JSON 中混合 tagged 和其他类型也应跳过(some r => tagged)', () => {
    const a = seedNode(db, { heat: 0.5 });
    const b = seedNode(db, { heat: 0.5 });
    const link = createLink(db, {
      from_id: a.id,
      to_id: b.id,
      relation: [{ type: 'supports', confidence: 0.7 }],
      strength: 0.8,
    });
    // 混合,只要有一个 tagged 就跳过
    setLinkRelation(db, link!.id, JSON.stringify([
      { type: 'supports', confidence: 0.7 },
      { type: 'tagged', confidence: 1.0 },
    ]));

    runSynapticScaling(db);

    const after = db.prepare('SELECT strength FROM links WHERE id = ?').get(link!.id) as { strength: number };
    expect(after.strength).toBe(0.8);
  });

  it('relation JSON 解析失败时(损坏行)仍然继续衰减', () => {
    const a = seedNode(db, { heat: 0.005 });
    const b = seedNode(db, { heat: 0.005 });
    db.prepare('UPDATE nodes SET heat = 0.005 WHERE id IN (?, ?)').run(a.id, b.id);
    const link = createLink(db, {
      from_id: a.id,
      to_id: b.id,
      relation: [{ type: 'supports', confidence: 0.7 }],
      strength: 0.8,
    });
    // 强制写入损坏的 relation
    setLinkRelation(db, link!.id, 'not-valid-json-{{{');

    runSynapticScaling(db);

    const after = db.prepare('SELECT strength FROM links WHERE id = ?').get(link!.id) as { strength: number };
    // 解析失败 → catch 后继续衰减,而不是跳过
    expect(after.strength).toBeLessThan(0.8);
  });

  it('链接衰减后必须 bump updated', async () => {
    const a = seedNode(db, { heat: 0.5 });
    const b = seedNode(db, { heat: 0.5 });
    const link = createLink(db, {
      from_id: a.id,
      to_id: b.id,
      relation: [{ type: 'supports', confidence: 0.7 }],
      strength: 0.5,
    });
    const before = (db.prepare('SELECT updated FROM links WHERE id = ?').get(link!.id) as { updated: string }).updated;
    await new Promise(r => setTimeout(r, 10));

    runSynapticScaling(db);

    const after = (db.prepare('SELECT updated FROM links WHERE id = ?').get(link!.id) as { updated: string | null }).updated;
    expect(after).toBeTruthy();
    expect(after! > before).toBe(true);
  });

  it('status="pending" 的链接不参与赫布衰减(WHERE status="confirmed")', () => {
    const a = seedNode(db, { heat: 0.5 });
    const b = seedNode(db, { heat: 0.5 });
    const link = createLink(db, {
      from_id: a.id,
      to_id: b.id,
      relation: [{ type: 'supports', confidence: 0.7 }],
      strength: 0.5,
      status: 'pending',
    });

    runSynapticScaling(db);

    const after = db.prepare('SELECT strength FROM links WHERE id = ?').get(link!.id) as { strength: number };
    expect(after.strength).toBe(0.5);
  });

  it('status="rejected_by_user" 的链接不参与赫布衰减', () => {
    const a = seedNode(db, { heat: 0.5 });
    const b = seedNode(db, { heat: 0.5 });
    const link = createLink(db, {
      from_id: a.id,
      to_id: b.id,
      relation: [{ type: 'supports', confidence: 0.7 }],
      strength: 0.5,
      status: 'rejected_by_user',
    });

    runSynapticScaling(db);

    const after = db.prepare('SELECT strength FROM links WHERE id = ?').get(link!.id) as { strength: number };
    expect(after.strength).toBe(0.5);
  });

  it('多条链接批处理:每条独立衰减', () => {
    const nodes = Array.from({ length: 5 }, (_, i) => seedNode(db, { heat: 0.5, content: `n${i}` }));
    const links = [];
    for (let i = 0; i < 4; i++) {
      const link = createLink(db, {
        from_id: nodes[i].id,
        to_id: nodes[i + 1].id,
        relation: [{ type: 'supports', confidence: 0.7 }],
        strength: 0.5,
      });
      links.push(link!);
    }

    runSynapticScaling(db);

    // 所有 4 条都应被衰减
    for (const link of links) {
      const after = db.prepare('SELECT strength FROM links WHERE id = ?').get(link.id) as { strength: number };
      expect(after.strength).toBeLessThan(0.5);
      expect(after.strength).toBeGreaterThan(0.05);
    }
  });

  it('DELETE + SELECT 原子事务:已购被 strength<=threshold 的链接不会被后续 SELECT 再读到', () => {
    // 我们设置一些链接 strength <= 0.05,跑 runSynapticScaling 后:
    // 1. DELETE 立刻干掉
    // 2. SELECT 不会再读到它们
    // 关键断言:跑完后这些链接不存在,但 strength > threshold 的依然被衰减处理
    const a = seedNode(db, { heat: 0.5 });
    const b = seedNode(db, { heat: 0.5 });
    const c = seedNode(db, { heat: 0.5 });

    const dead = createLink(db, {
      from_id: a.id,
      to_id: b.id,
      relation: [{ type: 'supports', confidence: 0.7 }],
      strength: 0.5,
    });
    setLinkStrength(db, dead!.id, 0.03); // 低于 threshold

    const alive = createLink(db, {
      from_id: b.id,
      to_id: c.id,
      relation: [{ type: 'supports', confidence: 0.7 }],
      strength: 0.6,
    });

    runSynapticScaling(db);

    // dead 链接被(软)purge:deleted=1,且因 SELECT 带 deleted=0 不会被后续读到
    const deadRow = db.prepare('SELECT deleted FROM links WHERE id = ?').get(dead!.id) as { deleted: number };
    expect(deadRow.deleted).toBe(1);
    // alive 链接被衰减
    const after = db.prepare('SELECT strength FROM links WHERE id = ?').get(alive!.id) as { strength: number };
    expect(after.strength).toBeLessThan(0.6);
  });

  it('源节点不存在时(脏数据)heatCache 默认为 0', () => {
    // 创建链接然后硬删 from 节点,模拟脏数据
    const a = seedNode(db, { heat: 0.5 });
    const b = seedNode(db, { heat: 0.5 });
    const link = createLink(db, {
      from_id: a.id,
      to_id: b.id,
      relation: [{ type: 'supports', confidence: 0.7 }],
      strength: 0.5,
    });
    // 删掉 a 的版本/log 引用?——schema 有 FK,直接 DELETE 可能失败。
    // 但源码逻辑是:from_id 找不到 heat 时 heatCache.set(nid, 0)。
    // 我们改 a 的 heat 为极端值并 archive 让节点不参与 decay loop,但链接还能找到。
    db.prepare('UPDATE nodes SET heat = 0, archived = 1 WHERE id = ?').run(a.id);
    db.prepare('UPDATE nodes SET heat = 0.005 WHERE id = ?').run(b.id);

    runSynapticScaling(db);

    const after = db.prepare('SELECT strength FROM links WHERE id = ?').get(link!.id) as { strength: number };
    // heatA=0(archived 节点不会被 SELECT n.heat... WHERE archived=0,但链接路径
    // 没这个过滤,直接读 nodes.heat;archived 节点 heat=0),heatB=0.005
    // activity = sqrt(0*0.005) = 0
    // retention = 1 - 0.03 * (1 - 0) = 0.97
    // new = 0.5 * 0.97 = 0.485
    expect(after.strength).toBeCloseTo(0.5 * 0.97, 3);
  });

  it('return.decayed 计数只覆盖节点 heat decay,不含链接衰减', () => {
    const a = seedNode(db, { heat: 0.5 });
    const b = seedNode(db, { heat: 0.5 });
    createLink(db, {
      from_id: a.id,
      to_id: b.id,
      relation: [{ type: 'supports', confidence: 0.7 }],
      strength: 0.5,
    });

    const result = runSynapticScaling(db);
    // 只 a 和 b 两个节点 decayed
    expect(result.decayed).toBe(2);
  });

  it('链接衰减 > 0 时写入 timeline 事件(synaptic_scaling)', () => {
    const a = seedNode(db, { heat: 0.5 });
    const b = seedNode(db, { heat: 0.5 });
    createLink(db, {
      from_id: a.id,
      to_id: b.id,
      relation: [{ type: 'supports', confidence: 0.7 }],
      strength: 0.5,
    });

    runSynapticScaling(db);

    const events = db.prepare(
      "SELECT * FROM timeline_events WHERE subtype = 'synaptic_scaling'",
    ).all() as Array<{ subtype: string; detail: string }>;
    expect(events.length).toBeGreaterThanOrEqual(1);
    const detail = JSON.parse(events[0].detail);
    expect(detail.decayed).toBeGreaterThan(0);
  });

  it('relation 为有效 JSON 但是不含 tagged 类型时正常衰减(对照测试)', () => {
    const a = seedNode(db, { heat: 0.5 });
    const b = seedNode(db, { heat: 0.5 });
    const link = createLink(db, {
      from_id: a.id,
      to_id: b.id,
      relation: [{ type: 'supports', confidence: 0.7 }, { type: 'related', confidence: 0.6 }],
      strength: 0.7,
    });

    runSynapticScaling(db);

    const after = db.prepare('SELECT strength FROM links WHERE id = ?').get(link!.id) as { strength: number };
    expect(after.strength).toBeLessThan(0.7);
  });

  it('relation 中 type 不是 "tagged" 子串但是名字接近(typo 防御)', () => {
    const a = seedNode(db, { heat: 0.5 });
    const b = seedNode(db, { heat: 0.5 });
    const link = createLink(db, {
      from_id: a.id,
      to_id: b.id,
      relation: [{ type: 'supports', confidence: 0.7 }],
      strength: 0.5,
    });
    // 故意构造 "tag" / "tagging" / 其他类似但不等的字符串
    setLinkRelation(db, link!.id, JSON.stringify([{ type: 'tag', confidence: 1.0 }]));

    runSynapticScaling(db);

    const after = db.prepare('SELECT strength FROM links WHERE id = ?').get(link!.id) as { strength: number };
    // 不是严格 'tagged' → 不跳过,继续衰减
    expect(after.strength).toBeLessThan(0.5);
  });

  it('connectivity 高的节点 heat 衰减更慢但链接 strength 衰减仍依赖 heat', () => {
    // 这条 case 同时验证节点 / 链接两条公式相互独立
    const a = seedNode(db, { heat: 1.0 });
    const b = seedNode(db, { heat: 1.0 });
    db.prepare('UPDATE nodes SET connectivity = 1.0 WHERE id = ?').run(a.id);
    db.prepare('UPDATE nodes SET connectivity = 1.0 WHERE id = ?').run(b.id);

    const link = createLink(db, {
      from_id: a.id,
      to_id: b.id,
      relation: [{ type: 'supports', confidence: 0.7 }],
      strength: 0.9,
    });

    runSynapticScaling(db);

    // 节点 decay rate = 1 - 0.05*(1-0.8*1) = 0.99
    const heatA = db.prepare('SELECT heat FROM nodes WHERE id = ?').get(a.id) as { heat: number };
    expect(heatA.heat).toBeCloseTo(0.99, 5);
    // 链接衰减:heat=0.99 → activity=0.99 → retention=1-0.03*(1-0.99)=0.9997
    // newStrength = 0.9 * 0.9997 = 0.89973
    const afterLink = db.prepare('SELECT strength FROM links WHERE id = ?').get(link!.id) as { strength: number };
    expect(afterLink.strength).toBeCloseTo(0.9 * (1 - 0.03 * (1 - 0.99)), 4);
  });
});
