/**
 * Repository 接口定义
 *
 * 将数据库操作抽象为接口，使 tools 层和 search 层与具体数据库实现解耦。
 * SQLite 实现在 sqlite-repository.ts，PostgreSQL 实现在 pro/cloud-server/。
 */

import type {
  BrainNode,
  BrainLink,
  NodeType,
  LinkStatus,
  LinkRelation,
} from '../types.js';

// ── Node Repository ────────────────────────────────────────

export interface NodeCreateParams {
  type?: NodeType;
  content: string;
  title?: string;
  source_tool?: string;
  source_session?: string;
  source_stream?: string;
  source_timestamp?: string;
  tags?: string[];
  heat?: number;
  refinement?: number;
  independence?: number;
  specificity?: number;
  subjectivity?: number;
  actuality?: number;
  is_crystal?: number;
  is_tag?: number;
  is_meta?: number;
  created?: string;
}

export interface NodeFilter {
  type?: NodeType;
  archived?: boolean;
  /**
   * 按结构角色过滤。在上层(如 buildTags / buildCrystals)把"heat DESC
   * 取 N 然后 JS 过滤"的错误算法替换为"SQL 层直接过滤后再排序",避免
   * 非 tag / 非 crystal 的高 heat 节点挤掉目标。
   */
  is_tag?: boolean;
  is_crystal?: boolean;
  createdAfter?: string;
  createdBefore?: string;
  limit?: number;
  offset?: number;
  orderBy?: string;
}

export interface INodeRepository {
  createNode(params: NodeCreateParams): BrainNode;
  getNode(id: string): BrainNode | null;
  getNodesByIds(ids: string[]): Map<string, BrainNode>;
  updateNode(
    id: string,
    patch: Partial<Pick<BrainNode,
      'content' | 'title' | 'type' | 'heat' | 'refinement' | 'connectivity' |
      'independence' | 'specificity' | 'subjectivity' | 'actuality' | 'tags' |
      'archived' | 'is_keystone' | 'is_crystal' | 'is_tag' | 'is_meta' |
      'maturity_score' | 'last_reconsolidated'
    >>,
    changeReason?: string,
  ): boolean;
  archiveNode(id: string): void;
  unarchiveNode(id: string): boolean;
  reArchiveNode(id: string): boolean;
  listArchivedNodes(opts?: { limit?: number; offset?: number }): { nodes: BrainNode[]; total: number };
  listNodes(filter?: NodeFilter): BrainNode[];
  getNodeCount(archived?: boolean): number;
  bumpHeat(id: string, delta?: number): void;
}

// ── Link Repository ────────────────────────────────────────

export interface LinkCreateParams {
  from_id: string;
  to_id: string;
  relation: LinkRelation[];
  strength?: number;
  note?: string;
  auto?: boolean;
  status?: LinkStatus;
}

export interface LinkQueryOptions {
  minStrength?: number;
  statusFilter?: string;
}

export interface ILinkRepository {
  createLink(params: LinkCreateParams): BrainLink | null;
  /** 默认排除 status='rejected_by_user'；传 includeRejected:true 可读全部 */
  getLinksFrom(nodeId: string, options?: { includeRejected?: boolean }): BrainLink[];
  getLinksTo(nodeId: string, options?: { includeRejected?: boolean }): BrainLink[];
  getLinksForNode(nodeId: string, options?: { includeRejected?: boolean }): BrainLink[];
  getLinksForNodes(nodeIds: string[], options?: LinkQueryOptions): BrainLink[];
  updateLinkStatus(id: string, status: LinkStatus): void;
  updateLinkStrength(id: string, strength: number): void;
  updateLinkRelation(id: string, relation: LinkRelation[]): void;
  deleteLink(id: string): void;
  getPendingLinks(limit?: number): BrainLink[];
  getLinkCount(): number;
  linkExists(fromId: string, toId: string): boolean;
}

// ── Vector Repository ──────────────────────────────────────

export interface VectorSearchResult {
  id: string;
  distance: number;
}

export interface IVectorRepository {
  insertSegmentVectors(nodeId: string, content: string): Promise<number>;
  insertVector(nodeId: string, embedding: Float32Array): void;
  deleteVector(nodeId: string): void;
  getVectorForNode(nodeId: string): Float32Array | null;
  searchVectors(queryEmbedding: Float32Array, limit?: number): VectorSearchResult[];
  hasVectors(): boolean;
}

// ── FTS Repository ─────────────────────────────────────────

export interface FtsResult {
  rowid: number;
  id: string;
  content: string;
  rank: number;
}

export interface IFtsRepository {
  /**
   * @param mode 'or' (默认): match=any 语义，OR 召回 + BM25 排序。
   *             'and': match=all 语义，全词必含。
   * 设计 doc: docs/design/brain-recall-redesign-2026-05.md §5.2
   */
  search(query: string, limit?: number, mode?: 'and' | 'or'): FtsResult[];
  rebuild(): void;
}

// ── Log Repository ─────────────────────────────────────────

export interface OperationLogParams {
  operation: string;
  input_summary?: string;
  context?: string;
  output_node_ids?: string[];
  tool?: string;
  session?: string;
  agent_id?: string;
  // v0.2.77 brain_recall 新字段（设计 doc §7.5）
  exact_count?: number;
  related_count?: number;
  fallback_chain?: string;
  vector_unavailable?: boolean;
}

export interface TimelineEventParams {
  type: string;
  subtype: string;
  title: string;
  detail?: Record<string, unknown>;
  node_ids?: string[];
  important?: number;
  actor?: 'user' | 'agent' | 'brain';
}

export interface StrategyFeedbackParams {
  strategy_name: string;
  operation_id?: number;
  node_id?: string;
  was_used?: boolean;
  feedback_signal?: number;
}

export interface ParamFeedbackParams {
  strategy_name: string;
  param_name?: string;
  signal_type: string;
  signal_value: number;
  context?: string;
}

export interface ParamFeedbackEntry {
  id: number;
  param_name: string | null;
  signal_type: string;
  signal_value: number;
  created: string;
}

export interface StrategyFeedbackEntry {
  id: number;
  operation_id: number | null;
  node_id: string | null;
  was_used: number | null;
  feedback_signal: number | null;
  created: string;
}

export interface ILogRepository {
  logOperation(params: OperationLogParams): number;
  getRecallCount(): number;
  getRecentOperations(limit?: number): import('../types.js').OperationLogEntry[];
  logStrategyFeedback(params: StrategyFeedbackParams): void;
  logTimelineEvent(params: TimelineEventParams): number;
  logParamFeedback(params: ParamFeedbackParams): void;
  getParamFeedback(strategyName: string, signalType?: string, days?: number): ParamFeedbackEntry[];
  getParamFeedbackByRange(strategyName: string, signalType: string | undefined, startDate: string, endDate: string): ParamFeedbackEntry[];
  getStrategyFeedback(strategyName: string, limit?: number): StrategyFeedbackEntry[];
}

// ── Aggregate Repository ───────────────────────────────────

export interface IRepository {
  nodes: INodeRepository;
  links: ILinkRepository;
  vectors: IVectorRepository;
  fts: IFtsRepository;
  log: ILogRepository;

  /**
   * 过渡期逃生舱口：获取底层原始数据库连接。
   * 仅用于尚未迁移到 Repository 接口的外部函数调用。
   * 随着迁移推进，使用此属性的地方应逐步减少直至消除。
   */
  readonly rawDb: import('better-sqlite3').Database;

  /** 在事务中执行操作（同步版本，适用于 SQLite） */
  transaction<T>(fn: () => T): T;
}
