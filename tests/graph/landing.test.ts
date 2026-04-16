/**
 * landing.ts 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mocks ----
vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, _param: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

vi.mock('../../src/db/vectors.js', () => ({
  searchVectors: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/llm/link-judge.js', () => ({
  inferLinkType: vi.fn().mockReturnValue({ type: 'supports', confidence: 0.7 }),
  refineLinkTypeAsync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/graph/maturity.js', () => ({
  updateConnectivity: vi.fn(),
  computeMaturityScore: vi.fn().mockReturnValue(0.5),
  refreshMaturityScore: vi.fn(),
}));

import type Database from 'better-sqlite3';
import { setupTestDb, seedNode, seedLink } from '../helpers/test-db.js';
import { findLandingConnections } from '../../src/graph/landing.js';
import { searchVectors } from '../../src/db/vectors.js';
import { l2DistanceToSimilarity } from '../../src/utils/similarity.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
  vi.mocked(searchVectors).mockReturnValue([]);
});

// ===== 基本行为 =====

describe('findLandingConnections', () => {
  it('should return action=new with no links when no neighbors found', () => {
    const node = seedNode(db, { content: 'isolated node' });
    const result = findLandingConnections(db, node.id, new Float32Array(3072));

    expect(result.action).toBe('new');
    expect(result.confirmedLinks).toHaveLength(0);
    expect(result.pendingLinks).toHaveLength(0);
  });

  it('should filter out self from candidates (self-loop prevention)', () => {
    const node = seedNode(db, { content: 'self node' });

    // searchVectors returns self with distance 0
    vi.mocked(searchVectors).mockReturnValue([
      { id: node.id, distance: 0 },
    ]);

    const result = findLandingConnections(db, node.id, new Float32Array(3072));
    expect(result.action).toBe('new');
    expect(result.confirmedLinks).toHaveLength(0);
    expect(result.pendingLinks).toHaveLength(0);
  });

  it('should return action=merge when top candidate similarity >= dedup threshold (0.92)', () => {
    const node = seedNode(db, { content: 'new node' });
    const existing = seedNode(db, { content: 'existing similar' });

    // similarity = 1 - d^2/2; for sim=0.95, d^2 = 0.1, d = sqrt(0.1) ≈ 0.316
    const d = Math.sqrt(2 * (1 - 0.95));
    vi.mocked(searchVectors).mockReturnValue([
      { id: existing.id, distance: d },
    ]);

    const result = findLandingConnections(db, node.id, new Float32Array(3072));
    expect(result.action).toBe('merge');
    expect(result.mergeTarget).toBe(existing.id);
    expect(result.confirmedLinks).toHaveLength(0);
  });

  it('should create confirmed links for candidates above landing threshold (0.80)', () => {
    const node = seedNode(db, { content: 'source node' });
    const target = seedNode(db, { content: 'target node' });

    // fact type: adjustedLandingThreshold = 0.85
    // Use similarity = 0.88 to be safely above threshold (avoid floating point edge case)
    const d = Math.sqrt(2 * (1 - 0.88));
    vi.mocked(searchVectors).mockReturnValue([
      { id: target.id, distance: d },
    ]);

    const result = findLandingConnections(db, node.id, new Float32Array(3072));
    expect(result.action).toBe('new');
    expect(result.confirmedLinks).toHaveLength(1);
    expect(result.confirmedLinks[0].from_id).toBe(node.id);
    expect(result.confirmedLinks[0].to_id).toBe(target.id);
    expect(result.confirmedLinks[0].status).toBe('confirmed');
  });

  it('should create pending links for candidates between pending and landing thresholds', () => {
    const node = seedNode(db, { content: 'source node' });
    const target = seedNode(db, { content: 'target node' });

    // similarity = 0.70 → between pending (0.60) and landing (0.80)
    const d = Math.sqrt(2 * (1 - 0.70));
    vi.mocked(searchVectors).mockReturnValue([
      { id: target.id, distance: d },
    ]);

    const result = findLandingConnections(db, node.id, new Float32Array(3072));
    expect(result.action).toBe('new');
    expect(result.confirmedLinks).toHaveLength(0);
    expect(result.pendingLinks).toHaveLength(1);
    expect(result.pendingLinks[0].status).toBe('pending');
  });

  it('should skip candidates below pending threshold', () => {
    const node = seedNode(db, { content: 'source' });
    const target = seedNode(db, { content: 'far away target' });

    // similarity = 0.40 → below pending threshold (0.60)
    const d = Math.sqrt(2 * (1 - 0.40));
    vi.mocked(searchVectors).mockReturnValue([
      { id: target.id, distance: d },
    ]);

    const result = findLandingConnections(db, node.id, new Float32Array(3072));
    expect(result.confirmedLinks).toHaveLength(0);
    expect(result.pendingLinks).toHaveLength(0);
  });

  // ===== 类型阈值调整 =====

  it('should apply stricter thresholds (+0.05) for high-actuality nodes', () => {
    // actuality > 0.8 → landingThreshold += 0.05 (0.80 → 0.85)
    const node = seedNode(db, { content: 'certain fact', actuality: 0.9 });
    const target = seedNode(db, { content: 'target' });

    // similarity = 0.82 → above default landing (0.80) but below adjusted (0.85)
    const d = Math.sqrt(2 * (1 - 0.82));
    vi.mocked(searchVectors).mockReturnValue([
      { id: target.id, distance: d },
    ]);

    const result = findLandingConnections(db, node.id, new Float32Array(3072));
    // 0.82 < 0.85 adjusted threshold → pending, not confirmed
    expect(result.confirmedLinks).toHaveLength(0);
    expect(result.pendingLinks).toHaveLength(1);
  });

  it('should apply looser thresholds (-0.05) for low-actuality nodes', () => {
    // actuality < 0.3 → landingThreshold -= 0.05 (0.80 → 0.75)
    const node = seedNode(db, { content: 'speculative idea', actuality: 0.1 });
    const target = seedNode(db, { content: 'target' });

    // similarity = 0.77 → below default landing (0.80) but above adjusted (0.75)
    const d = Math.sqrt(2 * (1 - 0.77));
    vi.mocked(searchVectors).mockReturnValue([
      { id: target.id, distance: d },
    ]);

    const result = findLandingConnections(db, node.id, new Float32Array(3072));
    expect(result.confirmedLinks).toHaveLength(1);
  });

  it('should lower pending threshold for low-actuality (-0.05 → 0.55)', () => {
    // actuality < 0.3 → pendingThreshold -= 0.05 (0.60 → 0.55)
    const node = seedNode(db, { content: 'speculation', actuality: 0.1 });
    const target = seedNode(db, { content: 'target' });

    // similarity = 0.57 → between adjusted pending (0.55) and adjusted landing (0.75)
    const d = Math.sqrt(2 * (1 - 0.57));
    vi.mocked(searchVectors).mockReturnValue([
      { id: target.id, distance: d },
    ]);

    const result = findLandingConnections(db, node.id, new Float32Array(3072));
    expect(result.pendingLinks).toHaveLength(1);
  });

  // ===== topK 限制 =====

  it('should limit confirmed links to topK (default 2)', () => {
    const node = seedNode(db, { content: 'source' });
    const t1 = seedNode(db, { content: 'target 1' });
    const t2 = seedNode(db, { content: 'target 2' });
    const t3 = seedNode(db, { content: 'target 3' });

    const d = Math.sqrt(2 * (1 - 0.88));
    vi.mocked(searchVectors).mockReturnValue([
      { id: t1.id, distance: d },
      { id: t2.id, distance: d },
      { id: t3.id, distance: d },
    ]);

    const result = findLandingConnections(db, node.id, new Float32Array(3072));
    // topK=2, so max 2 confirmed, the 3rd becomes pending
    expect(result.confirmedLinks).toHaveLength(2);
    expect(result.pendingLinks).toHaveLength(1);
  });

  // ===== createLink returning null =====

  it('should handle null from createLink gracefully (self-loop in links table)', () => {
    // createLink returns null for self-loops; but landing filters self from candidates.
    // Test with existing link: link already exists so linkExists returns true → skip
    const node = seedNode(db, { content: 'source' });
    const target = seedNode(db, { content: 'target' });

    // Pre-create a link
    seedLink(db, node.id, target.id, { relation: 'supports' });

    const d = Math.sqrt(2 * (1 - 0.88));
    vi.mocked(searchVectors).mockReturnValue([
      { id: target.id, distance: d },
    ]);

    const result = findLandingConnections(db, node.id, new Float32Array(3072));
    // Link already exists, so no new link created
    expect(result.confirmedLinks).toHaveLength(0);
  });

  it('should return empty result if source node does not exist', () => {
    const d = Math.sqrt(2 * (1 - 0.85));
    const target = seedNode(db, { content: 'target' });
    vi.mocked(searchVectors).mockReturnValue([
      { id: target.id, distance: d },
    ]);

    // Use a nonexistent node id
    const result = findLandingConnections(db, 'nonexistent-id', new Float32Array(3072));
    expect(result.action).toBe('new');
    expect(result.confirmedLinks).toHaveLength(0);
    expect(result.pendingLinks).toHaveLength(0);
  });

  // ===== pending links upper bound (pendingTopK = topK * 3) =====

  it('should limit pending links to pendingTopK (topK * 3 = 6)', () => {
    const node = seedNode(db, { content: 'source' });
    const targets: ReturnType<typeof seedNode>[] = [];
    for (let i = 0; i < 10; i++) {
      targets.push(seedNode(db, { content: `target ${i}` }));
    }

    // All candidates at similarity 0.70: between pending (0.60) and landing (0.80)
    const d = Math.sqrt(2 * (1 - 0.70));
    vi.mocked(searchVectors).mockReturnValue(
      targets.map(t => ({ id: t.id, distance: d })),
    );

    const result = findLandingConnections(db, node.id, new Float32Array(3072));
    // topK=2, pendingTopK=6, so max 6 pending links
    expect(result.pendingLinks.length).toBeLessThanOrEqual(6);
    expect(result.confirmedLinks).toHaveLength(0);
  });

  it('should return empty result for empty embedding', () => {
    const node = seedNode(db, { content: 'node with empty embedding' });
    const result = findLandingConnections(db, node.id, new Float32Array(0));
    expect(result.action).toBe('new');
    expect(result.confirmedLinks).toHaveLength(0);
    expect(result.pendingLinks).toHaveLength(0);
  });

  it('should call updateConnectivity for confirmed links but not pending', async () => {
    const { updateConnectivity } = await import('../../src/graph/maturity.js');
    vi.mocked(updateConnectivity).mockClear();

    const node = seedNode(db, { content: 'source' });
    const t1 = seedNode(db, { content: 'target 1' });
    const t2 = seedNode(db, { content: 'pending target' });

    // t1 above landing threshold, t2 in pending range
    const dConfirmed = Math.sqrt(2 * (1 - 0.88));
    const dPending = Math.sqrt(2 * (1 - 0.70));
    vi.mocked(searchVectors).mockReturnValue([
      { id: t1.id, distance: dConfirmed },
      { id: t2.id, distance: dPending },
    ]);

    const result = findLandingConnections(db, node.id, new Float32Array(3072));
    expect(result.confirmedLinks).toHaveLength(1);
    expect(result.pendingLinks).toHaveLength(1);

    // updateConnectivity should be called for source node + confirmed target, NOT for pending
    expect(updateConnectivity).toHaveBeenCalledWith(db, node.id);
    expect(updateConnectivity).toHaveBeenCalledWith(db, t1.id);
    // Total calls = 1 (source) + 1 (confirmed target) = 2
    expect(updateConnectivity).toHaveBeenCalledTimes(2);
  });
});
