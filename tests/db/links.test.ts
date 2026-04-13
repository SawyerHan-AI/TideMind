/**
 * links.ts CRUD 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mock strategy loader（在所有 import 之前） ----
vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, param: string, fallback: number) => {
    const defaults: Record<string, number> = {
      heat_weight: 0.2,
      refinement_weight: 0.3,
      connectivity_weight: 0.3,
      independence_weight: 0.2,
    };
    return defaults[param] ?? fallback;
  },
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

import type Database from 'better-sqlite3';
import { setupTestDb, seedNode, seedLink } from '../helpers/test-db.js';
import {
  createLink,
  getLinksFrom,
  getLinksTo,
  getLinksForNode,
  updateLinkStatus,
  updateLinkStrength,
  deleteLink,
  getPendingLinks,
  getLinkCount,
  linkExists,
} from '../../src/db/links.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
});

// ===== createLink =====

describe('createLink', () => {
  it('should create a link between two nodes', () => {
    const a = seedNode(db, { content: 'node A' });
    const b = seedNode(db, { content: 'node B' });

    const link = createLink(db, {
      from_id: a.id,
      to_id: b.id,
      relation: [{ type: 'supports', confidence: 0.7 }],
    });

    expect(link).not.toBeNull();
    expect(link!.from_id).toBe(a.id);
    expect(link!.to_id).toBe(b.id);
    expect(link!.relation).toEqual([{ type: 'supports', confidence: 0.7 }]);
    expect(link!.strength).toBe(0.5);
    expect(link!.status).toBe('confirmed');
  });

  it('should return null for self-loop', () => {
    const a = seedNode(db);
    const link = createLink(db, {
      from_id: a.id,
      to_id: a.id,
      relation: [{ type: 'supports', confidence: 0.7 }],
    });
    expect(link).toBeNull();
  });

  it('should respect optional parameters', () => {
    const a = seedNode(db);
    const b = seedNode(db);
    const link = createLink(db, {
      from_id: a.id,
      to_id: b.id,
      relation: [{ type: 'analogous', confidence: 0.8 }],
      strength: 0.9,
      note: 'test note',
      auto: false,
      status: 'pending',
    });
    expect(link!.relation).toEqual([{ type: 'analogous', confidence: 0.8 }]);
    expect(link!.strength).toBe(0.9);
    expect(link!.note).toBe('test note');
    expect(link!.auto).toBe(0);
    expect(link!.status).toBe('pending');
  });
});

// ===== getLinks* =====

describe('getLinksFrom / getLinksTo / getLinksForNode', () => {
  it('should return links by direction', () => {
    const a = seedNode(db);
    const b = seedNode(db);
    seedLink(db, a.id, b.id);

    expect(getLinksFrom(db, a.id).length).toBe(1);
    expect(getLinksTo(db, b.id).length).toBe(1);
    expect(getLinksForNode(db, a.id).length).toBe(1);
    expect(getLinksForNode(db, b.id).length).toBe(1);
  });
});

// ===== updateLinkStatus =====

describe('updateLinkStatus', () => {
  it('should update status', () => {
    const a = seedNode(db);
    const b = seedNode(db);
    const link = seedLink(db, a.id, b.id, { status: 'pending' })!;
    updateLinkStatus(db, link.id, 'confirmed');
    const updated = getLinksForNode(db, a.id)[0];
    expect(updated.status).toBe('confirmed');
  });
});

// ===== updateLinkStrength =====

describe('updateLinkStrength', () => {
  it('should update strength', () => {
    const a = seedNode(db);
    const b = seedNode(db);
    const link = seedLink(db, a.id, b.id)!;
    updateLinkStrength(db, link.id, 0.99);
    const updated = getLinksForNode(db, a.id)[0];
    expect(updated.strength).toBe(0.99);
  });
});

// ===== deleteLink =====

describe('deleteLink', () => {
  it('should delete a link', () => {
    const a = seedNode(db);
    const b = seedNode(db);
    const link = seedLink(db, a.id, b.id)!;
    deleteLink(db, link.id);
    expect(getLinksForNode(db, a.id).length).toBe(0);
  });
});

// ===== getPendingLinks =====

describe('getPendingLinks', () => {
  it('should return pending links', () => {
    const a = seedNode(db);
    const b = seedNode(db);
    seedLink(db, a.id, b.id, { status: 'pending' });
    expect(getPendingLinks(db).length).toBe(1);
    expect(getPendingLinks(db)[0].status).toBe('pending');
  });
});

// ===== getLinkCount =====

describe('getLinkCount', () => {
  it('should count confirmed links', () => {
    const a = seedNode(db);
    const b = seedNode(db);
    seedLink(db, a.id, b.id);
    seedLink(db, b.id, a.id, { status: 'pending' });
    expect(getLinkCount(db)).toBe(1);
  });
});

// ===== linkExists =====

describe('linkExists', () => {
  it('should detect bidirectional existence', () => {
    const a = seedNode(db);
    const b = seedNode(db);
    seedLink(db, a.id, b.id);
    expect(linkExists(db, a.id, b.id)).toBe(true);
    expect(linkExists(db, b.id, a.id)).toBe(true); // 反向也应该为 true
  });
});
