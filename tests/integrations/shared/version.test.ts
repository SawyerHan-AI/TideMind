/**
 * supersedeNode 单元测试
 *
 * 验证节点版本替代机制：链接迁移、去重、标记旧节点。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { setupTestDb, seedNode, seedLink } from '../../helpers/test-db.js';
import { getNode } from '../../../src/db/nodes.js';
import { getLinksForNode, getLinksFrom, getLinksTo } from '../../../src/db/links.js';

// mock logger
vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

// 被测模块
import { supersedeNode } from '../../../src/integrations/shared/version.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
});

describe('supersedeNode', () => {
  it('should migrate outgoing links from old node to new node', () => {
    const oldNode = seedNode(db, { content: 'old' });
    const newNode = seedNode(db, { content: 'new' });
    const target = seedNode(db, { content: 'target' });
    seedLink(db, oldNode.id, target.id);

    supersedeNode(db, oldNode.id, newNode.id);

    const newOutLinks = getLinksFrom(db, newNode.id);
    expect(newOutLinks.some(l => l.to_id === target.id)).toBe(true);
  });

  it('should migrate incoming links from old node to new node', () => {
    const oldNode = seedNode(db, { content: 'old' });
    const newNode = seedNode(db, { content: 'new' });
    const source = seedNode(db, { content: 'source' });
    seedLink(db, source.id, oldNode.id);

    supersedeNode(db, oldNode.id, newNode.id);

    const newInLinks = getLinksTo(db, newNode.id);
    expect(newInLinks.some(l => l.from_id === source.id)).toBe(true);
  });

  it('should not duplicate link if new node already links to same target', () => {
    const oldNode = seedNode(db, { content: 'old' });
    const newNode = seedNode(db, { content: 'new' });
    const target = seedNode(db, { content: 'target' });
    seedLink(db, oldNode.id, target.id);
    seedLink(db, newNode.id, target.id); // pre-existing

    supersedeNode(db, oldNode.id, newNode.id);

    const newOutLinks = getLinksFrom(db, newNode.id).filter(l => l.to_id === target.id);
    expect(newOutLinks.length).toBe(1);
  });

  it('should not duplicate link if new node already receives from same source', () => {
    const oldNode = seedNode(db, { content: 'old' });
    const newNode = seedNode(db, { content: 'new' });
    const source = seedNode(db, { content: 'source' });
    seedLink(db, source.id, oldNode.id);
    seedLink(db, source.id, newNode.id); // pre-existing

    supersedeNode(db, oldNode.id, newNode.id);

    const newInLinks = getLinksTo(db, newNode.id).filter(l => l.from_id === source.id);
    expect(newInLinks.length).toBe(1);
  });

  it('should create updates link from old to new', () => {
    const oldNode = seedNode(db, { content: 'old' });
    const newNode = seedNode(db, { content: 'new' });

    supersedeNode(db, oldNode.id, newNode.id);

    const oldLinks = getLinksFrom(db, oldNode.id);
    expect(oldLinks.length).toBe(1);
    expect(oldLinks[0].to_id).toBe(newNode.id);
    expect(oldLinks[0].relation[0].type).toBe('updates');
  });

  it('should mark old node is_superseded=1', () => {
    const oldNode = seedNode(db, { content: 'old' });
    const newNode = seedNode(db, { content: 'new' });

    supersedeNode(db, oldNode.id, newNode.id);

    const updated = getNode(db, oldNode.id)!;
    expect(updated.is_superseded).toBe(1);
  });

  it('should set old node heat to 0.01', () => {
    const oldNode = seedNode(db, { content: 'old', heat: 0.9 });
    const newNode = seedNode(db, { content: 'new' });

    supersedeNode(db, oldNode.id, newNode.id);

    const updated = getNode(db, oldNode.id)!;
    expect(updated.heat).toBeCloseTo(0.01);
  });

  it('should leave old node with only the updates link', () => {
    const oldNode = seedNode(db, { content: 'old' });
    const newNode = seedNode(db, { content: 'new' });
    const a = seedNode(db, { content: 'a' });
    const b = seedNode(db, { content: 'b' });
    seedLink(db, oldNode.id, a.id);
    seedLink(db, b.id, oldNode.id);

    supersedeNode(db, oldNode.id, newNode.id);

    const remaining = getLinksForNode(db, oldNode.id);
    expect(remaining.length).toBe(1);
    expect(remaining[0].from_id).toBe(oldNode.id);
    expect(remaining[0].to_id).toBe(newNode.id);
  });

  it('should handle self-link on old node without error', () => {
    const oldNode = seedNode(db, { content: 'old' });
    const newNode = seedNode(db, { content: 'new' });
    // createLink rejects self-links (returns null), so insert manually
    db.prepare(
      "INSERT INTO links (id, from_id, to_id, relation, strength, auto, status, created) VALUES (?, ?, ?, ?, 0.5, 1, 'confirmed', '2024-01-01T00:00:00Z')",
    ).run('self-link', oldNode.id, oldNode.id, '[{"type":"supports","confidence":0.7}]');

    expect(() => supersedeNode(db, oldNode.id, newNode.id)).not.toThrow();

    const remaining = getLinksForNode(db, oldNode.id);
    expect(remaining.length).toBe(1);
    expect(remaining[0].relation[0].type).toBe('updates');
  });

  it('should migrate multiple links from old to new', () => {
    const oldNode = seedNode(db, { content: 'old' });
    const newNode = seedNode(db, { content: 'new' });
    const targets: string[] = [];
    for (let i = 0; i < 5; i++) {
      const t = seedNode(db, { content: `target-${i}` });
      targets.push(t.id);
      seedLink(db, oldNode.id, t.id);
    }

    supersedeNode(db, oldNode.id, newNode.id);

    const newOutLinks = getLinksFrom(db, newNode.id);
    for (const tid of targets) {
      expect(newOutLinks.some(l => l.to_id === tid)).toBe(true);
    }
  });

  it('should handle both in and out links to same third node', () => {
    const oldNode = seedNode(db, { content: 'old' });
    const newNode = seedNode(db, { content: 'new' });
    const peer = seedNode(db, { content: 'peer' });
    seedLink(db, oldNode.id, peer.id);
    seedLink(db, peer.id, oldNode.id);

    supersedeNode(db, oldNode.id, newNode.id);

    const newOut = getLinksFrom(db, newNode.id).filter(l => l.to_id === peer.id);
    const newIn = getLinksTo(db, newNode.id).filter(l => l.from_id === peer.id);
    expect(newOut.length).toBe(1);
    expect(newIn.length).toBe(1);
  });

  it('should preserve existing links on new node', () => {
    const oldNode = seedNode(db, { content: 'old' });
    const newNode = seedNode(db, { content: 'new' });
    const existing = seedNode(db, { content: 'existing' });
    const migrated = seedNode(db, { content: 'migrated' });
    seedLink(db, newNode.id, existing.id); // pre-existing
    seedLink(db, oldNode.id, migrated.id);

    supersedeNode(db, oldNode.id, newNode.id);

    const newOutLinks = getLinksFrom(db, newNode.id);
    expect(newOutLinks.some(l => l.to_id === existing.id)).toBe(true);
    expect(newOutLinks.some(l => l.to_id === migrated.id)).toBe(true);
  });

  it('should be idempotent when called twice', () => {
    const oldNode = seedNode(db, { content: 'old' });
    const newNode = seedNode(db, { content: 'new' });
    const target = seedNode(db, { content: 'target' });
    seedLink(db, oldNode.id, target.id);

    supersedeNode(db, oldNode.id, newNode.id);
    supersedeNode(db, oldNode.id, newNode.id);

    const oldLinks = getLinksForNode(db, oldNode.id);
    expect(oldLinks.length).toBe(1);
    expect(oldLinks[0].relation[0].type).toBe('updates');

    const updated = getNode(db, oldNode.id)!;
    expect(updated.is_superseded).toBe(1);
    expect(updated.heat).toBeCloseTo(0.01);

    // new node should have target link only once
    const newOutLinks = getLinksFrom(db, newNode.id).filter(l => l.to_id === target.id);
    expect(newOutLinks.length).toBe(1);
  });
});
