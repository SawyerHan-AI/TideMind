/**
 * SqliteRepository wrapper 单元测试
 *
 * 验证 SqliteRepository 正确地委托给底层 db 函数，
 * 并确保 transaction、rawDb 等聚合功能正常工作。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mock strategy loader ----
vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, _param: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

import type Database from 'better-sqlite3';
import { setupTestDb } from '../helpers/test-db.js';
import { SqliteRepository } from '../../src/db/sqlite-repository.js';

let db: Database.Database;
let repo: InstanceType<typeof SqliteRepository>;

beforeEach(() => {
  db = setupTestDb();
  repo = new SqliteRepository(db);
});

// ===== Nodes =====

describe('SqliteRepository - nodes', () => {
  it('should create and retrieve a node', () => {
    const node = repo.nodes.createNode({ type: 'fact', content: 'test content' });
    expect(node.id).toBeTruthy();
    expect(node.content).toBe('test content');
    expect(node.type).toBe('fact');

    const fetched = repo.nodes.getNode(node.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.content).toBe('test content');
  });

  it('should update a node', () => {
    const node = repo.nodes.createNode({ type: 'fact', content: 'original' });
    const updated = repo.nodes.updateNode(node.id, { content: 'modified' });
    expect(updated).toBe(true);

    const fetched = repo.nodes.getNode(node.id);
    expect(fetched!.content).toBe('modified');
  });

  it('should list nodes with filter', () => {
    repo.nodes.createNode({ type: 'fact', content: 'fact node' });
    repo.nodes.createNode({ type: 'idea', content: 'idea node' });
    repo.nodes.createNode({ type: 'fact', content: 'another fact' });

    const facts = repo.nodes.listNodes({ type: 'fact' });
    expect(facts.length).toBe(2);
    expect(facts.every(n => n.type === 'fact')).toBe(true);

    const all = repo.nodes.listNodes();
    expect(all.length).toBe(3);
  });

  it('keeps active, archived, and superseded node visibility distinct', () => {
    const active = repo.nodes.createNode({ type: 'fact', content: 'active' });
    const archived = repo.nodes.createNode({ type: 'fact', content: 'archived' });
    const superseded = repo.nodes.createNode({ type: 'fact', content: 'superseded' });

    repo.nodes.updateNode(archived.id, { archived: 1 });
    db.prepare('UPDATE nodes SET is_superseded = 1 WHERE id = ?').run(superseded.id);

    expect(repo.nodes.listNodes({ archived: false }).map(n => n.id)).toEqual([active.id]);
    expect(repo.nodes.listNodes({ archived: true }).map(n => n.id)).toEqual([archived.id]);
    expect(repo.nodes.getNodeCount(false)).toBe(1);
    expect(repo.nodes.getNodeCount(true)).toBe(1);
    expect(repo.nodes.getNodeCount()).toBe(3);
  });

  it('should archive a node', () => {
    const node = repo.nodes.createNode({ type: 'fact', content: 'to archive' });
    repo.nodes.archiveNode(node.id);

    const fetched = repo.nodes.getNode(node.id);
    // archiveNode sets heat to 0.02 via cooldown
    expect(fetched!.heat).toBe(0.02);
  });

  it('should return null for nonexistent node', () => {
    const fetched = repo.nodes.getNode('nonexistent-id');
    expect(fetched).toBeFalsy();
  });

  it('should get node count', () => {
    expect(repo.nodes.getNodeCount()).toBe(0);
    repo.nodes.createNode({ type: 'fact', content: 'one' });
    repo.nodes.createNode({ type: 'idea', content: 'two' });
    expect(repo.nodes.getNodeCount()).toBe(2);
  });

  it('should get nodes by ids', () => {
    const n1 = repo.nodes.createNode({ type: 'fact', content: 'first' });
    const n2 = repo.nodes.createNode({ type: 'idea', content: 'second' });
    repo.nodes.createNode({ type: 'fact', content: 'third' });

    const map = repo.nodes.getNodesByIds([n1.id, n2.id]);
    expect(map.size).toBe(2);
    expect(map.get(n1.id)!.content).toBe('first');
    expect(map.get(n2.id)!.content).toBe('second');
  });

  it('should bump heat', () => {
    // createNode 默认 heat=1.0 已是上限,bump 到 1.0 仍是 1.0。
    // 用小 delta 测试 bump 触达上限的行为(钳位在 [0,1])。
    const node = repo.nodes.createNode({ type: 'fact', content: 'heatable', heat: 0.3 });
    const originalHeat = node.heat;
    repo.nodes.bumpHeat(node.id, 0.4);

    const fetched = repo.nodes.getNode(node.id);
    expect(fetched!.heat).toBeGreaterThan(originalHeat);
  });
});

// ===== Links =====

describe('SqliteRepository - links', () => {
  it('should create and retrieve links for a node', () => {
    const n1 = repo.nodes.createNode({ type: 'fact', content: 'node 1' });
    const n2 = repo.nodes.createNode({ type: 'fact', content: 'node 2' });

    const link = repo.links.createLink({
      from_id: n1.id,
      to_id: n2.id,
      relation: [{ type: 'supports', confidence: 0.8 }],
    });
    expect(link).not.toBeNull();
    expect(link!.from_id).toBe(n1.id);
    expect(link!.to_id).toBe(n2.id);

    const links = repo.links.getLinksForNode(n1.id);
    expect(links.length).toBe(1);
    expect(links[0].id).toBe(link!.id);
  });

  it('hides rejected links by default and exposes them only when requested', () => {
    const n1 = repo.nodes.createNode({ type: 'fact', content: 'node 1' });
    const n2 = repo.nodes.createNode({ type: 'fact', content: 'node 2' });
    const rejected = repo.links.createLink({
      from_id: n1.id,
      to_id: n2.id,
      relation: [{ type: 'supports', confidence: 0.8 }],
      status: 'rejected_by_user',
    });

    expect(rejected).not.toBeNull();
    expect(repo.links.getLinksFrom(n1.id)).toEqual([]);
    expect(repo.links.getLinksTo(n2.id)).toEqual([]);
    expect(repo.links.getLinksForNode(n1.id)).toEqual([]);
    expect(repo.links.getLinksForNode(n1.id, { includeRejected: true }).map(l => l.id)).toEqual([rejected!.id]);
  });

  it('should delete a link', () => {
    const n1 = repo.nodes.createNode({ type: 'fact', content: 'a' });
    const n2 = repo.nodes.createNode({ type: 'fact', content: 'b' });
    const link = repo.links.createLink({
      from_id: n1.id,
      to_id: n2.id,
      relation: [{ type: 'supports', confidence: 0.9 }],
    });

    repo.links.deleteLink(link!.id);
    const links = repo.links.getLinksForNode(n1.id);
    expect(links.length).toBe(0);
  });

  it('should check link existence', () => {
    const n1 = repo.nodes.createNode({ type: 'fact', content: 'x' });
    const n2 = repo.nodes.createNode({ type: 'fact', content: 'y' });

    expect(repo.links.linkExists(n1.id, n2.id)).toBe(false);
    repo.links.createLink({
      from_id: n1.id,
      to_id: n2.id,
      relation: [{ type: 'supports', confidence: 0.7 }],
    });
    expect(repo.links.linkExists(n1.id, n2.id)).toBe(true);
  });

  it('should get link count', () => {
    const n1 = repo.nodes.createNode({ type: 'fact', content: 'p' });
    const n2 = repo.nodes.createNode({ type: 'fact', content: 'q' });
    const n3 = repo.nodes.createNode({ type: 'fact', content: 'r' });

    expect(repo.links.getLinkCount()).toBe(0);
    repo.links.createLink({ from_id: n1.id, to_id: n2.id, relation: [{ type: 'supports', confidence: 0.8 }] });
    repo.links.createLink({ from_id: n2.id, to_id: n3.id, relation: [{ type: 'supports', confidence: 0.8 }] });
    expect(repo.links.getLinkCount()).toBe(2);
  });
});

// ===== Log =====

describe('SqliteRepository - log', () => {
  it('should log operation and retrieve recall count', () => {
    expect(repo.log.getRecallCount()).toBe(0);

    repo.log.logOperation({ operation: 'recall', input_summary: 'test query' });
    repo.log.logOperation({ operation: 'recall', input_summary: 'another query' });
    repo.log.logOperation({ operation: 'digest', input_summary: 'digest op' });

    expect(repo.log.getRecallCount()).toBe(2);
  });

  it('should return recent operations', () => {
    repo.log.logOperation({ operation: 'prepare', tool: 'cursor' });
    repo.log.logOperation({ operation: 'recall', input_summary: 'search' });

    const recent = repo.log.getRecentOperations(10);
    expect(recent.length).toBe(2);
  });
});

// ===== Transaction =====

describe('SqliteRepository - transaction', () => {
  it('should commit changes in a successful transaction', () => {
    repo.transaction(() => {
      repo.nodes.createNode({ type: 'fact', content: 'txn node 1' });
      repo.nodes.createNode({ type: 'fact', content: 'txn node 2' });
    });

    expect(repo.nodes.getNodeCount()).toBe(2);
  });

  it('should rollback on error', () => {
    try {
      repo.transaction(() => {
        repo.nodes.createNode({ type: 'fact', content: 'will rollback' });
        throw new Error('intentional failure');
      });
    } catch {
      // expected
    }

    expect(repo.nodes.getNodeCount()).toBe(0);
  });
});

// ===== rawDb =====

describe('SqliteRepository - rawDb', () => {
  it('should return the underlying database instance', () => {
    expect(repo.rawDb).toBe(db);
  });

  it('should allow direct SQL queries via rawDb', () => {
    repo.nodes.createNode({ type: 'fact', content: 'raw query test' });
    const row = repo.rawDb.prepare('SELECT COUNT(*) as cnt FROM nodes').get() as { cnt: number };
    expect(row.cnt).toBe(1);
  });
});
