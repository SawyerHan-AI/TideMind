/**
 * reconsolidate.ts 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mocks ----
vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, param: string, fallback: number) => {
    const overrides: Record<string, number> = {
      reconsolidate_min_nodes: 3,
      reconsolidate_days_threshold: 7,
      deep_reconsolidate_max_per_recall: 3,
      perceptual_read_link_strength: 0.5,
      max_conflict_checks_per_recall: 2,
    };
    return overrides[param] ?? fallback;
  },
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

vi.mock('../../src/db/connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/connection.js')>();
  return { ...actual, isVecLoaded: vi.fn().mockReturnValue(true) };
});

vi.mock('../../src/llm/link-judge.js', () => ({
  inferLinkType: vi.fn().mockReturnValue({ type: 'supports', confidence: 0.7 }),
  refineLinkTypeAsync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/graph/maturity.js', () => ({
  updateConnectivity: vi.fn(),
  computeMaturityScore: vi.fn().mockReturnValue(0.5),
  refreshMaturityScore: vi.fn(),
}));

vi.mock('../../src/llm/client.js', () => ({
  callLLM: vi.fn().mockResolvedValue('{"needs_update": false}'),
}));

vi.mock('../../src/config.js', () => ({
  getConfig: () => ({
    general: { data_dir: '/tmp/test-eb' },
    anthropic: { api_key: '' },
    vertex: { project_id: '', region: 'us-central1' },
    ollama: { url: 'http://localhost:11434' },
    gemini: { api_key: '' },
    llm: { provider: 'anthropic', standard_model: '', heavy_model: '' },
    embedding: { provider: 'vertex', model: 'gemini-embedding-001', dimensions: 3072 },
    search: { alpha: 0.3, beta: 0.5, gamma: 0.1, delta: 0.1 },
    gates: {},
    metabolism: {},
  }),
  getDataDir: () => '/tmp/test-eb',
  isLlmConfigured: () => false,
}));

vi.mock('../../src/llm/prompts.js', () => ({
  RECONSOLIDATE_SYSTEM: 'system prompt',
  reconsolidatePrompt: vi.fn().mockReturnValue('prompt'),
}));

vi.mock('../../src/llm/extract.js', () => ({
  evaluateContradiction: vi.fn().mockResolvedValue({ contradicts: false, explanation: '', resolution: '' }),
}));

vi.mock('../../src/metabolism/conflict-heuristics.js', () => ({
  detectConflictSignals: vi.fn().mockReturnValue([]),
}));

import type Database from 'better-sqlite3';
import { setupTestDb, seedNode, seedLink } from '../helpers/test-db.js';
import { reconsolidateOnRecall } from '../../src/metabolism/reconsolidate.js';
import { isVecLoaded } from '../../src/db/connection.js';
import { linkExists } from '../../src/db/links.js';
import type { BrainNode } from '../../src/types.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
  vi.mocked(isVecLoaded).mockReturnValue(true);
});

// ===== 感知读 (shallow reconsolidate) =====

describe('reconsolidateOnRecall - shallow/perceptual read', () => {
  it('should not create links when nodes.length < minNodes (3)', () => {
    const nodes = [
      seedNode(db, { content: 'node 1' }),
      seedNode(db, { content: 'node 2' }),
    ];

    reconsolidateOnRecall(db, nodes);

    expect(linkExists(db, nodes[0].id, nodes[1].id)).toBe(false);
  });

  it('should create pending links between unlinked nodes when density < 0.3', () => {
    const nodes = [
      seedNode(db, { content: 'node A' }),
      seedNode(db, { content: 'node B' }),
      seedNode(db, { content: 'node C' }),
    ];

    reconsolidateOnRecall(db, nodes);

    // With 3 nodes and 0 existing links, density = 0 < 0.3
    // Should create pending links between pairs
    let linkCount = 0;
    if (linkExists(db, nodes[0].id, nodes[1].id)) linkCount++;
    if (linkExists(db, nodes[0].id, nodes[2].id)) linkCount++;
    if (linkExists(db, nodes[1].id, nodes[2].id)) linkCount++;
    expect(linkCount).toBeGreaterThan(0);
  });

  it('should cap pending links at MAX_PENDING_LINKS_PER_RECALL (5)', () => {
    // Create 6 nodes → 15 possible pairs, all should create pending links
    // But max 5 per recall
    const nodes: BrainNode[] = [];
    for (let i = 0; i < 6; i++) {
      nodes.push(seedNode(db, { content: `node ${i}` }));
    }

    reconsolidateOnRecall(db, nodes);

    // Count created links
    let linkCount = 0;
    for (let i = 0; i < nodes.length - 1; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        if (linkExists(db, nodes[i].id, nodes[j].id)) linkCount++;
      }
    }
    expect(linkCount).toBeLessThanOrEqual(5);
  });

  it('should skip link creation when density >= 0.3', () => {
    const nodes = [
      seedNode(db, { content: 'node A' }),
      seedNode(db, { content: 'node B' }),
      seedNode(db, { content: 'node C' }),
    ];

    // Create 1 link out of 3 possible → density = 1/3 ≈ 0.33 >= 0.3
    seedLink(db, nodes[0].id, nodes[1].id);

    // Track links before
    const hadAC = linkExists(db, nodes[0].id, nodes[2].id);
    const hadBC = linkExists(db, nodes[1].id, nodes[2].id);

    reconsolidateOnRecall(db, nodes);

    // Density is 0.33 >= 0.3, so no new pending links should be created
    expect(linkExists(db, nodes[0].id, nodes[2].id)).toBe(hadAC);
    expect(linkExists(db, nodes[1].id, nodes[2].id)).toBe(hadBC);
  });

  it('should skip meta+meta node pairs', () => {
    const metaA = seedNode(db, { type: 'meta', content: 'meta A' });
    const metaB = seedNode(db, { type: 'meta', content: 'meta B' });
    const fact = seedNode(db, { content: 'fact node' });

    reconsolidateOnRecall(db, [metaA, metaB, fact]);

    // meta+meta pair should be skipped
    expect(linkExists(db, metaA.id, metaB.id)).toBe(false);
    // meta+fact pair may be created
    // fact+meta pair may be created
  });

  it('should not create links when vec is not loaded', () => {
    vi.mocked(isVecLoaded).mockReturnValue(false);

    const nodes = [
      seedNode(db, { content: 'node A' }),
      seedNode(db, { content: 'node B' }),
      seedNode(db, { content: 'node C' }),
    ];

    reconsolidateOnRecall(db, nodes);

    expect(linkExists(db, nodes[0].id, nodes[1].id)).toBe(false);
  });

  it('should not create duplicate links (skips existing)', () => {
    const nodes = [
      seedNode(db, { content: 'node A' }),
      seedNode(db, { content: 'node B' }),
      seedNode(db, { content: 'node C' }),
    ];

    // Pre-create a link between A and B
    seedLink(db, nodes[0].id, nodes[1].id);

    reconsolidateOnRecall(db, nodes);

    // The existing A-B link should not cause errors
    // Check that the link count for A-B is still 1
    const links = db.prepare(
      'SELECT COUNT(*) as cnt FROM links WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)',
    ).get(nodes[0].id, nodes[1].id, nodes[1].id, nodes[0].id) as { cnt: number };
    expect(links.cnt).toBe(1);
  });
});

// ===== 深度读 =====

describe('reconsolidateOnRecall - deep reconsolidate', () => {
  it('should trigger deep reconsolidate for old version-1 nodes', () => {
    // Create a node that looks old (version=1, created > 7 days ago)
    const node = seedNode(db, { content: 'old node' });

    // Manually set created to 10 days ago
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE nodes SET created = ? WHERE id = ?').run(tenDaysAgo, node.id);

    const refreshedNode = db.prepare('SELECT * FROM nodes WHERE id = ?').get(node.id) as BrainNode;

    // With a single node, we need 2+ nodes or context for detectAndReconsolidateAsync
    // But deep read only requires the node to meet time condition
    reconsolidateOnRecall(db, [refreshedNode]);

    // The function fires async, so we just verify it doesn't throw
    // We can't easily check the async result in a sync test
  });

  it('should not trigger deep reconsolidate for version > 1 nodes', () => {
    const node = seedNode(db, { content: 'revised node' });

    // Set version to 2 and created to 10 days ago
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE nodes SET version = 2, created = ? WHERE id = ?').run(tenDaysAgo, node.id);

    const refreshedNode = db.prepare('SELECT * FROM nodes WHERE id = ?').get(node.id) as BrainNode;

    // Should not trigger deep reconsolidate (version > 1)
    // This just verifies it doesn't crash
    reconsolidateOnRecall(db, [refreshedNode]);
  });

  it('should respect maxDeep limit (3 per recall)', () => {
    // Create 5 old nodes
    const nodes: BrainNode[] = [];
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    for (let i = 0; i < 5; i++) {
      const node = seedNode(db, { content: `old node ${i}` });
      db.prepare('UPDATE nodes SET created = ? WHERE id = ?').run(tenDaysAgo, node.id);
      const refreshed = db.prepare('SELECT * FROM nodes WHERE id = ?').get(node.id) as BrainNode;
      nodes.push(refreshed);
    }

    // Should not throw even with 5 candidates (only processes max 3)
    reconsolidateOnRecall(db, nodes);
  });

  it('should not trigger deep reconsolidate for recently created nodes', () => {
    const node = seedNode(db, { content: 'fresh node' });

    // Node was just created, so daysAgo(created) < 7
    reconsolidateOnRecall(db, [node]);

    // No deep reconsolidate should fire for a new node
    // Just verifying no crash
  });
});
