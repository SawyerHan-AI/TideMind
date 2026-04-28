/**
 * SQLite Repository 实现
 *
 * 将现有的 db 函数包装为 IRepository 接口。
 * 不修改原有函数逻辑，纯委托。
 */

import type Database from 'better-sqlite3';
import type {
  IRepository,
  INodeRepository,
  ILinkRepository,
  IVectorRepository,
  IFtsRepository,
  ILogRepository,
  NodeCreateParams,
  NodeFilter,
  LinkCreateParams,
  LinkQueryOptions,
  OperationLogParams,
  TimelineEventParams,
  StrategyFeedbackParams,
  ParamFeedbackParams,
} from './repository.js';
import type { BrainNode, BrainLink, LinkStatus, LinkRelation, OperationLogEntry } from '../types.js';

import {
  createNode, getNode, getNodesByIds, updateNode,
  listArchivedNodes, listNodes, getNodeCount, bumpHeat,
} from './nodes.js';
import {
  createLink, getLinksFrom, getLinksTo, getLinksForNode, getLinksForNodes,
  updateLinkStatus, updateLinkStrength, updateLinkRelation, deleteLink,
  getPendingLinks, getLinkCount, linkExists,
} from './links.js';
import {
  insertSegmentVectors, insertVector, getVectorForNode,
  searchVectors, hasVectors,
} from './vectors.js';
import {
  archiveNodeWithVectors,
  deleteNodeVectors,
  reArchiveNodeWithVectors,
  unarchiveNodeRecordOnly,
} from './node-lifecycle.js';
import { searchFTS, rebuildFTS } from './fts.js';
import {
  logOperation, getRecallCount, getRecentOperations, logStrategyFeedback,
  logTimelineEvent, logParamFeedback, getParamFeedback, getParamFeedbackByRange,
  getStrategyFeedback,
} from './log.js';

// ── Node ───────────────────────────────────────────────────

class SqliteNodeRepository implements INodeRepository {
  constructor(private db: Database.Database) {}

  createNode(params: NodeCreateParams): BrainNode {
    return createNode(this.db, params);
  }
  getNode(id: string): BrainNode | null {
    return getNode(this.db, id);
  }
  getNodesByIds(ids: string[]): Map<string, BrainNode> {
    return getNodesByIds(this.db, ids);
  }
  updateNode(id: string, patch: Parameters<typeof updateNode>[2], changeReason?: string): boolean {
    return updateNode(this.db, id, patch, changeReason);
  }
  archiveNode(id: string): void {
    archiveNodeWithVectors(this.db, id);
  }
  unarchiveNode(id: string): boolean {
    return unarchiveNodeRecordOnly(this.db, id);
  }
  reArchiveNode(id: string): boolean {
    return reArchiveNodeWithVectors(this.db, id);
  }
  listArchivedNodes(opts?: { limit?: number; offset?: number }): { nodes: BrainNode[]; total: number } {
    return listArchivedNodes(this.db, opts);
  }
  listNodes(filter?: NodeFilter): BrainNode[] {
    return listNodes(this.db, filter);
  }
  getNodeCount(archived?: boolean): number {
    return getNodeCount(this.db, archived);
  }
  bumpHeat(id: string, delta?: number): void {
    bumpHeat(this.db, id, delta);
  }
}

// ── Link ───────────────────────────────────────────────────

class SqliteLinkRepository implements ILinkRepository {
  constructor(private db: Database.Database) {}

  createLink(params: LinkCreateParams): BrainLink | null {
    return createLink(this.db, params);
  }
  getLinksFrom(nodeId: string, options?: { includeRejected?: boolean }): BrainLink[] {
    return getLinksFrom(this.db, nodeId, options);
  }
  getLinksTo(nodeId: string, options?: { includeRejected?: boolean }): BrainLink[] {
    return getLinksTo(this.db, nodeId, options);
  }
  getLinksForNode(nodeId: string, options?: { includeRejected?: boolean }): BrainLink[] {
    return getLinksForNode(this.db, nodeId, options);
  }
  getLinksForNodes(nodeIds: string[], options?: LinkQueryOptions): BrainLink[] {
    return getLinksForNodes(this.db, nodeIds, options);
  }
  updateLinkStatus(id: string, status: LinkStatus): void {
    updateLinkStatus(this.db, id, status);
  }
  updateLinkStrength(id: string, strength: number): void {
    updateLinkStrength(this.db, id, strength);
  }
  updateLinkRelation(id: string, relation: LinkRelation[]): void {
    updateLinkRelation(this.db, id, relation);
  }
  deleteLink(id: string): void {
    deleteLink(this.db, id);
  }
  getPendingLinks(limit?: number): BrainLink[] {
    return getPendingLinks(this.db, limit);
  }
  getLinkCount(): number {
    return getLinkCount(this.db);
  }
  linkExists(fromId: string, toId: string): boolean {
    return linkExists(this.db, fromId, toId);
  }
}

// ── Vector ─────────────────────────────────────────────────

class SqliteVectorRepository implements IVectorRepository {
  constructor(private db: Database.Database) {}

  async insertSegmentVectors(nodeId: string, content: string): Promise<number> {
    return insertSegmentVectors(this.db, nodeId, content);
  }
  insertVector(nodeId: string, embedding: Float32Array): void {
    insertVector(this.db, nodeId, embedding);
  }
  deleteVector(nodeId: string): void {
    deleteNodeVectors(this.db, nodeId);
  }
  getVectorForNode(nodeId: string): Float32Array | null {
    return getVectorForNode(this.db, nodeId);
  }
  searchVectors(queryEmbedding: Float32Array, limit?: number) {
    return searchVectors(this.db, queryEmbedding, limit);
  }
  hasVectors(): boolean {
    return hasVectors(this.db);
  }
}

// ── FTS ────────────────────────────────────────────────────

class SqliteFtsRepository implements IFtsRepository {
  constructor(private db: Database.Database) {}

  search(query: string, limit?: number) {
    return searchFTS(this.db, query, limit);
  }
  rebuild(): void {
    rebuildFTS(this.db);
  }
}

// ── Log ────────────────────────────────────────────────────

class SqliteLogRepository implements ILogRepository {
  constructor(private db: Database.Database) {}

  logOperation(params: OperationLogParams): number {
    return logOperation(this.db, params);
  }
  getRecallCount(): number {
    return getRecallCount(this.db);
  }
  getRecentOperations(limit?: number): OperationLogEntry[] {
    return getRecentOperations(this.db, limit);
  }
  logStrategyFeedback(params: StrategyFeedbackParams): void {
    logStrategyFeedback(this.db, params);
  }
  logTimelineEvent(params: TimelineEventParams): number {
    return logTimelineEvent(this.db, params);
  }
  logParamFeedback(params: ParamFeedbackParams): void {
    logParamFeedback(this.db, params);
  }
  getParamFeedback(strategyName: string, signalType?: string, days?: number) {
    return getParamFeedback(this.db, strategyName, signalType, days);
  }
  getParamFeedbackByRange(strategyName: string, signalType: string | undefined, startDate: string, endDate: string) {
    return getParamFeedbackByRange(this.db, strategyName, signalType, startDate, endDate);
  }
  getStrategyFeedback(strategyName: string, limit?: number) {
    return getStrategyFeedback(this.db, strategyName, limit);
  }
}

// ── Aggregate ──────────────────────────────────────────────

export class SqliteRepository implements IRepository {
  nodes: INodeRepository;
  links: ILinkRepository;
  vectors: IVectorRepository;
  fts: IFtsRepository;
  log: ILogRepository;

  get rawDb(): Database.Database { return this.db; }

  constructor(private db: Database.Database) {
    this.nodes = new SqliteNodeRepository(db);
    this.links = new SqliteLinkRepository(db);
    this.vectors = new SqliteVectorRepository(db);
    this.fts = new SqliteFtsRepository(db);
    this.log = new SqliteLogRepository(db);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
