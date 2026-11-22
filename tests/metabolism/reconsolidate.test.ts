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
import { perceptualReadOnRecall, planReconsolidateItems, runReconsolidateFollowup } from '../../src/metabolism/reconsolidate.js';
import { enqueueRecallFollowup } from '../../src/db/recall-followups.js';
import { detectConflictSignals } from '../../src/metabolism/conflict-heuristics.js';
import { isVecLoaded } from '../../src/db/connection.js';
import { linkExists } from '../../src/db/links.js';
import type { BrainNode } from '../../src/types.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
  vi.mocked(isVecLoaded).mockReturnValue(true);
});

// ===== 感知读 (shallow reconsolidate) =====

describe('perceptualReadOnRecall - shallow/perceptual read', () => {
  it('should not create links when nodes.length < minNodes (3)', () => {
    const nodes = [
      seedNode(db, { content: 'node 1' }),
      seedNode(db, { content: 'node 2' }),
    ];

    perceptualReadOnRecall(db, nodes);

    expect(linkExists(db, nodes[0].id, nodes[1].id)).toBe(false);
  });

  it('should create pending links between unlinked nodes when density < 0.3', () => {
    const nodes = [
      seedNode(db, { content: 'node A' }),
      seedNode(db, { content: 'node B' }),
      seedNode(db, { content: 'node C' }),
    ];

    perceptualReadOnRecall(db, nodes);

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

    perceptualReadOnRecall(db, nodes);

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

    perceptualReadOnRecall(db, nodes);

    // Density is 0.33 >= 0.3, so no new pending links should be created
    expect(linkExists(db, nodes[0].id, nodes[2].id)).toBe(hadAC);
    expect(linkExists(db, nodes[1].id, nodes[2].id)).toBe(hadBC);
  });

  it('should skip meta+meta node pairs', () => {
    const metaA = seedNode(db, { type: 'meta', content: 'meta A' });
    const metaB = seedNode(db, { type: 'meta', content: 'meta B' });
    const fact = seedNode(db, { content: 'fact node' });

    perceptualReadOnRecall(db, [metaA, metaB, fact]);

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

    perceptualReadOnRecall(db, nodes);

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

    perceptualReadOnRecall(db, nodes);

    // The existing A-B link should not cause errors
    // Check that the link count for A-B is still 1
    const links = db.prepare(
      'SELECT COUNT(*) as cnt FROM links WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)',
    ).get(nodes[0].id, nodes[1].id, nodes[1].id, nodes[0].id) as { cnt: number };
    expect(links.cnt).toBe(1);
  });
});

// ===== 深度读：由队列条目驱动 =====

function row(nodeIds: string[], handled: string[] = [], context: string | null = null) {
  return { id: 'row', kind: 'reconsolidate' as const, nodeIds, query: null, context, handled, attempts: 0, updated: '' };
}
const planItems = (...args: Parameters<typeof planReconsolidateItems>) => planReconsolidateItems(...args).items;
function ageNode(id: string, days = 10) {
  const past = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('UPDATE nodes SET created = ? WHERE id = ?').run(past, id);
}

describe('planReconsolidateItems - deep reconsolidate', () => {
  it('plans a deep read for old version-1 nodes only', () => {
    const old = seedNode(db, { content: 'old node' });
    const revised = seedNode(db, { content: 'revised node' });
    const fresh = seedNode(db, { content: 'fresh node' });
    ageNode(old.id); ageNode(revised.id);
    db.prepare('UPDATE nodes SET version = 2 WHERE id = ?').run(revised.id);
    const items = planItems(db, row([old.id, revised.id, fresh.id]));
    expect(items.map(i => i.key)).toEqual([`deep:${old.id}`]);
  });

  it('respects the per-row deep limit across runs and never repeats a handled item', () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) { const n = seedNode(db, { content: `old node ${i}` }); ageNode(n.id); ids.push(n.id); }
    expect(planItems(db, row(ids))).toHaveLength(3);
    const second = planItems(db, row(ids, [`deep:${ids[0]}`, `deep:${ids[1]}`]));
    expect(second.map(i => i.key)).toEqual([`deep:${ids[2]}`]);
    expect(planItems(db, row(ids, ids.slice(0, 3).map(id => `deep:${id}`)))).toHaveLength(0);
  });

  it('skips archived or missing nodes', () => {
    const node = seedNode(db, { content: 'archived' });
    ageNode(node.id);
    db.prepare('UPDATE nodes SET archived = 1 WHERE id = ?').run(node.id);
    expect(planItems(db, row([node.id, 'missing']))).toHaveLength(0);
  });

  it('plans conflict-driven deep reads within their own budget', () => {
    const a = seedNode(db, { content: 'a' });
    const b = seedNode(db, { content: 'b' });
    vi.mocked(detectConflictSignals).mockReturnValueOnce([
      { type: 'context_mismatch', nodeA: a.id, confidence: 0.8 },
      { type: 'context_mismatch', nodeA: b.id, confidence: 0.8 },
      { type: 'context_mismatch', nodeA: a.id, confidence: 0.9 },
    ] as any);
    const items = planItems(db, row([a.id, b.id], [], 'ctx'));
    expect(items.map(i => i.key)).toEqual([`conflict:${a.id}`, `conflict:${b.id}`]);
  });

  it('without an LLM the queued deep read applies the non-model fallback and is removed', async () => {
    const node = seedNode(db, { content: 'fallback', refinement: 0.5 });
    ageNode(node.id);
    enqueueRecallFollowup(db, { kind: 'reconsolidate', nodeIds: [node.id] });
    await runReconsolidateFollowup(db);
    const after = db.prepare('SELECT refinement, last_reconsolidated FROM nodes WHERE id = ?').get(node.id) as any;
    expect(after.refinement).toBeCloseTo(0.6, 5);
    expect(after.last_reconsolidated).toBeTruthy();
    expect(db.prepare('SELECT count(*) AS n FROM recall_followups').get()).toEqual({ n: 0 });
  });
});

// ===== quality gate for perceptual read =====

describe('perceptualReadOnRecall - search score quality gate', () => {
  it('should skip perceptual read when avgSearchScore is below 0.3', () => {
    const nodes = [
      seedNode(db, { content: 'node A' }),
      seedNode(db, { content: 'node B' }),
      seedNode(db, { content: 'node C' }),
    ];

    // Pass very low search score
    perceptualReadOnRecall(db, nodes, 0.1);

    // With avgSearchScore=0.1 < 0.3, perceptual read should be skipped
    expect(linkExists(db, nodes[0].id, nodes[1].id)).toBe(false);
    expect(linkExists(db, nodes[0].id, nodes[2].id)).toBe(false);
    expect(linkExists(db, nodes[1].id, nodes[2].id)).toBe(false);
  });

  it('should allow perceptual read when avgSearchScore is undefined', () => {
    const nodes = [
      seedNode(db, { content: 'node X' }),
      seedNode(db, { content: 'node Y' }),
      seedNode(db, { content: 'node Z' }),
    ];

    // No avgSearchScore → passQualityGate = true
    perceptualReadOnRecall(db, nodes);

    // Should create some pending links (density = 0)
    let linkCount = 0;
    if (linkExists(db, nodes[0].id, nodes[1].id)) linkCount++;
    if (linkExists(db, nodes[0].id, nodes[2].id)) linkCount++;
    if (linkExists(db, nodes[1].id, nodes[2].id)) linkCount++;
    expect(linkCount).toBeGreaterThan(0);
  });
});
