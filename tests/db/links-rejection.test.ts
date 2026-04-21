/**
 * 标签纠错反馈循环 — links 查询 helper 单测
 * 覆盖 getRejectedTagIdsForNode / getRejectedTagNamesForNode / getRecentRejectedNodesAcrossTags
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_s: string, _p: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

import type Database from 'better-sqlite3';
import { setupTestDb, seedNode, seedLink } from '../helpers/test-db.js';
import {
  getRejectedTagIdsForNode,
  getRejectedTagNamesForNode,
  getRecentRejectedNodesAcrossTags,
  getLinksForNode,
  getLinksFrom,
  getLinksTo,
  updateLinkStatus,
} from '../../src/db/links.js';
import { createNode } from '../../src/db/nodes.js';

// 标签节点：type='fact' + is_tag=1（DB 的 type CHECK 不含 'tag'，is_tag 是单独 flag）
function seedTagNode(db: Database.Database, title: string, content: string = '') {
  return createNode(db, { type: 'fact', title, content, is_tag: 1, heat: 1.0 });
}

describe('标签纠错 — DB helper', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupTestDb();
  });

  describe('getRejectedTagIdsForNode', () => {
    it('空节点返回空', () => {
      const n = seedNode(db, { content: 'mem' });
      expect(getRejectedTagIdsForNode(db, n.id)).toEqual([]);
    });

    it('只返回 status=rejected_by_user 的 tagged 链接对端', () => {
      const n = seedNode(db, { content: 'mem' });
      const tagA = seedTagNode(db, 'tagA');
      const tagB = seedTagNode(db, 'tagB');
      const tagC = seedTagNode(db, 'tagC');
      // A: confirmed → 不应出现
      seedLink(db, n.id, tagA.id, { relation: [{ type: 'tagged', confidence: 0.9 }], status: 'confirmed' });
      // B: rejected → 应出现
      const linkB = seedLink(db, n.id, tagB.id, { relation: [{ type: 'tagged', confidence: 0.9 }], status: 'confirmed' });
      updateLinkStatus(db, linkB!.id, 'rejected_by_user');
      // C: rejected 但不是 tagged 关系 → 不应出现
      const linkC = seedLink(db, n.id, tagC.id, { relation: [{ type: 'supports', confidence: 0.5 }], status: 'confirmed' });
      updateLinkStatus(db, linkC!.id, 'rejected_by_user');

      expect(getRejectedTagIdsForNode(db, n.id)).toEqual([tagB.id]);
    });
  });

  describe('getRejectedTagNamesForNode', () => {
    it('返回 tag 节点 title（优先）或 content', () => {
      const n = seedNode(db, { content: 'mem' });
      const tagTitled = seedTagNode(db, 'architecture', '');
      const tagContent = createNode(db, { type: 'fact', title: undefined, content: 'project-x', is_tag: 1, heat: 1.0 });
      const linkA = seedLink(db, n.id, tagTitled.id, { relation: [{ type: 'tagged', confidence: 0.9 }] });
      const linkB = seedLink(db, n.id, tagContent.id, { relation: [{ type: 'tagged', confidence: 0.9 }] });
      updateLinkStatus(db, linkA!.id, 'rejected_by_user');
      updateLinkStatus(db, linkB!.id, 'rejected_by_user');

      const names = getRejectedTagNamesForNode(db, n.id).sort();
      expect(names).toEqual(['architecture', 'project-x']);
    });

    it('过滤空名', () => {
      const n = seedNode(db, { content: 'mem' });
      const emptyTag = createNode(db, { type: 'fact', title: undefined, content: '', is_tag: 1, heat: 1.0 });
      const link = seedLink(db, n.id, emptyTag.id, { relation: [{ type: 'tagged', confidence: 0.9 }] });
      updateLinkStatus(db, link!.id, 'rejected_by_user');

      expect(getRejectedTagNamesForNode(db, n.id)).toEqual([]);
    });
  });

  describe('getLinksForNode / getLinksFrom / getLinksTo — 默认排除 rejected', () => {
    it('默认不返回 rejected_by_user 链接（三个 getter 一致）', () => {
      const n = seedNode(db, { content: 'mem' });
      const tag = seedTagNode(db, 'X');
      const other = seedNode(db, { content: 'peer' });
      // 两条链接：n→tag (rejected)、n→other (confirmed)
      const linkReject = seedLink(db, n.id, tag.id, { relation: [{ type: 'tagged', confidence: 0.9 }] });
      const linkKeep = seedLink(db, n.id, other.id, { relation: [{ type: 'supports', confidence: 0.8 }] });
      updateLinkStatus(db, linkReject!.id, 'rejected_by_user');

      expect(getLinksForNode(db, n.id).map(l => l.id)).toEqual([linkKeep!.id]);
      expect(getLinksFrom(db, n.id).map(l => l.id)).toEqual([linkKeep!.id]);
      expect(getLinksTo(db, tag.id)).toEqual([]);
    });

    it('includeRejected:true 时返回所有 status 的链接', () => {
      const n = seedNode(db, { content: 'mem' });
      const tag = seedTagNode(db, 'X');
      const link = seedLink(db, n.id, tag.id, { relation: [{ type: 'tagged', confidence: 0.9 }] });
      updateLinkStatus(db, link!.id, 'rejected_by_user');

      const all = getLinksForNode(db, n.id, { includeRejected: true });
      expect(all.map(l => l.id)).toEqual([link!.id]);
      expect(all[0].status).toBe('rejected_by_user');
    });
  });

  describe('getRecentRejectedNodesAcrossTags', () => {
    it('返回跨标签的最新 N 条 rejected 样本（按 created DESC）', () => {
      const n1 = seedNode(db, { content: 'memory one content' });
      const n2 = seedNode(db, { content: 'memory two content' });
      const n3 = seedNode(db, { content: 'memory three content' });
      const tagX = seedTagNode(db, 'X');
      const tagY = seedTagNode(db, 'Y');

      const l1 = seedLink(db, n1.id, tagX.id, { relation: [{ type: 'tagged', confidence: 0.9 }] });
      const l2 = seedLink(db, n2.id, tagY.id, { relation: [{ type: 'tagged', confidence: 0.9 }] });
      const l3 = seedLink(db, n3.id, tagX.id, { relation: [{ type: 'tagged', confidence: 0.9 }] });
      updateLinkStatus(db, l1!.id, 'rejected_by_user');
      updateLinkStatus(db, l2!.id, 'rejected_by_user');
      updateLinkStatus(db, l3!.id, 'rejected_by_user');

      const samples = getRecentRejectedNodesAcrossTags(db, 10);
      expect(samples.length).toBe(3);
      // 每条都含必要字段
      for (const s of samples) {
        expect(s.tag_name).toMatch(/^[XY]$/);
        expect(typeof s.node_content).toBe('string');
      }
    });

    it('limit 参数生效', () => {
      const n1 = seedNode(db, { content: 'a' });
      const n2 = seedNode(db, { content: 'b' });
      const tag = seedTagNode(db, 'T');
      const l1 = seedLink(db, n1.id, tag.id, { relation: [{ type: 'tagged', confidence: 0.9 }] });
      const l2 = seedLink(db, n2.id, tag.id, { relation: [{ type: 'tagged', confidence: 0.9 }] });
      updateLinkStatus(db, l1!.id, 'rejected_by_user');
      updateLinkStatus(db, l2!.id, 'rejected_by_user');

      expect(getRecentRejectedNodesAcrossTags(db, 1).length).toBe(1);
    });

    it('仅返回 rejected_by_user 且 relation 含 tagged 的链接', () => {
      const n = seedNode(db, { content: 'mem' });
      const tagA = seedTagNode(db, 'A');
      const tagB = seedTagNode(db, 'B');
      // A: confirmed tagged → 不应出现
      seedLink(db, n.id, tagA.id, { relation: [{ type: 'tagged', confidence: 0.9 }], status: 'confirmed' });
      // B: rejected 但是 supports 关系 → 不应出现
      const linkB = seedLink(db, n.id, tagB.id, { relation: [{ type: 'supports', confidence: 0.9 }], status: 'confirmed' });
      updateLinkStatus(db, linkB!.id, 'rejected_by_user');

      expect(getRecentRejectedNodesAcrossTags(db, 10)).toEqual([]);
    });
  });
});
