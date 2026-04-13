/**
 * metabolism/link-discover.ts 单元测试
 *
 * 用 testDb 测试共同邻居策略；向量邻居策略需要 sqlite-vec，用 mock。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock strategy loader
vi.mock('../../src/strategy/loader.js', () => ({
  getParam: vi.fn((_strategy: string, param: string, fallback: number) => {
    const overrides: Record<string, number> = {
      min_shared_neighbors: 2,
      max_shared_candidates: 20,
      vector_similarity_threshold: 0.55,
      vector_max_checks: 5,
      max_active_nodes: 50,
    };
    return overrides[param] ?? fallback;
  }),
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

vi.mock('../../src/utils/logger.js', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

// mock vec 相关：isVecLoaded 返回 false，不走向量邻居路径
vi.mock('../../src/db/connection.js', async () => {
  const actual = await vi.importActual('../../src/db/connection.js') as any;
  return {
    ...actual,
    isVecLoaded: () => false,
  };
});

// mock log
vi.mock('../../src/db/log.js', () => ({
  logTimelineEvent: vi.fn(),
}));

import type Database from 'better-sqlite3';
import { setupTestDb, seedNode, seedLink } from '../helpers/test-db.js';
import { runLinkDiscover } from '../../src/metabolism/link-discover.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
});

describe('runLinkDiscover — 共同邻居策略', () => {
  it('无节点时返回 0', async () => {
    const result = await runLinkDiscover(db);
    expect(result.scanned).toBe(0);
    expect(result.discovered).toBe(0);
  });

  it('共享 2 个邻居的节点对被发现', async () => {
    // 创建节点结构：A→C, A→D, B→C, B→D（A 和 B 共享邻居 C、D）
    const nodeA = seedNode(db, { content: 'Node A', heat: 0.5 });
    const nodeB = seedNode(db, { content: 'Node B', heat: 0.5 });
    const nodeC = seedNode(db, { content: 'Shared C', heat: 0.5 });
    const nodeD = seedNode(db, { content: 'Shared D', heat: 0.5 });

    seedLink(db, nodeA.id, nodeC.id, { status: 'confirmed' });
    seedLink(db, nodeA.id, nodeD.id, { status: 'confirmed' });
    seedLink(db, nodeB.id, nodeC.id, { status: 'confirmed' });
    seedLink(db, nodeB.id, nodeD.id, { status: 'confirmed' });

    const result = await runLinkDiscover(db);
    expect(result.discovered).toBeGreaterThanOrEqual(1);

    // 验证创建了 pending 链接
    const pendingLinks = db.prepare(
      "SELECT * FROM links WHERE status = 'pending'"
    ).all();
    expect(pendingLinks.length).toBeGreaterThanOrEqual(1);
  });

  it('已有直连的节点对不重复发现', async () => {
    const nodeA = seedNode(db, { content: 'A', heat: 0.5 });
    const nodeB = seedNode(db, { content: 'B', heat: 0.5 });
    const nodeC = seedNode(db, { content: 'C', heat: 0.5 });
    const nodeD = seedNode(db, { content: 'D', heat: 0.5 });

    seedLink(db, nodeA.id, nodeC.id, { status: 'confirmed' });
    seedLink(db, nodeA.id, nodeD.id, { status: 'confirmed' });
    seedLink(db, nodeB.id, nodeC.id, { status: 'confirmed' });
    seedLink(db, nodeB.id, nodeD.id, { status: 'confirmed' });
    // A-B, C-D 都已有直连
    seedLink(db, nodeA.id, nodeB.id, { status: 'confirmed' });
    seedLink(db, nodeC.id, nodeD.id, { status: 'confirmed' });

    const result = await runLinkDiscover(db);
    expect(result.discovered).toBe(0);
  });

  it('共享邻居不足 2 个的不发现', async () => {
    const nodeA = seedNode(db, { content: 'A', heat: 0.5 });
    const nodeB = seedNode(db, { content: 'B', heat: 0.5 });
    const nodeC = seedNode(db, { content: 'C', heat: 0.5 });

    // 只共享 1 个邻居
    seedLink(db, nodeA.id, nodeC.id, { status: 'confirmed' });
    seedLink(db, nodeB.id, nodeC.id, { status: 'confirmed' });

    const result = await runLinkDiscover(db);
    expect(result.discovered).toBe(0);
  });

  it('极低 heat 的节点被跳过', async () => {
    const nodeA = seedNode(db, { content: 'A', heat: 0.005 }); // 极低
    const nodeB = seedNode(db, { content: 'B', heat: 0.005 });
    const nodeC = seedNode(db, { content: 'C', heat: 0.005 }); // 也极低
    const nodeD = seedNode(db, { content: 'D', heat: 0.005 });

    seedLink(db, nodeA.id, nodeC.id, { status: 'confirmed' });
    seedLink(db, nodeA.id, nodeD.id, { status: 'confirmed' });
    seedLink(db, nodeB.id, nodeC.id, { status: 'confirmed' });
    seedLink(db, nodeB.id, nodeD.id, { status: 'confirmed' });

    const result = await runLinkDiscover(db);
    // 所有节点的 heat < 0.01，被过滤
    expect(result.discovered).toBe(0);
  });
});
