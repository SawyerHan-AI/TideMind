// ============================================================
// 外脑类型定义
// ============================================================

// --- 节点类型 ---
export type NodeType = 'fact' | 'context' | 'preference' | 'idea' | 'crystal' | 'meta' | 'tag';
export type LinkStatus = 'confirmed' | 'pending' | 'rejected_by_user';
export type RelationType =
  | 'caused_by' | 'continues' | 'updates' | 'supports' | 'contradicts'
  | 'summarizes' | 'part_of' | 'analogous' | 'tagged';

export interface LinkRelation {
  type: RelationType;
  confidence: number;
}
export type Intent = 'factual' | 'exploratory' | 'creative';
export type DigestIntent = 'new' | 'correction' | 'archive';
export type DetailLevel = 'brief' | 'standard' | 'deep';

// --- 派生分类（从维度计算，不存储） ---
export type DerivedCategory = 'record' | 'knowledge' | 'belief' | 'hypothesis' | 'intention';

// --- 数据模型 ---
export interface BrainNode {
  id: string;
  /** @deprecated 双写期间保留，将由维度派生替代 */
  type: NodeType;
  content: string;
  title: string | null;
  // 四维成熟度
  heat: number;
  refinement: number;
  connectivity: number;
  independence: number;
  // 三维内容性质
  specificity: number;
  subjectivity: number;
  actuality: number;
  // 来源追溯
  source_tool: string | null;
  source_session: string | null;
  source_stream: string | null;
  source_timestamp: string | null;
  // 分类
  tags: string | null; // JSON array string
  // 生命周期
  created: string;
  last_reconsolidated: string | null;
  version: number;
  archived: number;
  // 结构角色
  is_keystone: number;
  is_crystal: number;
  is_tag: number;
  is_meta: number;
  is_superseded: number;
  // 汇总
  maturity_score: number;
}

export interface BrainLink {
  id: string;
  from_id: string;
  to_id: string;
  relation: LinkRelation[];
  strength: number;
  note: string | null;
  auto: number;
  status: LinkStatus;
  created: string;
}

export interface NodeVersion {
  id: number;
  node_id: string;
  version: number;
  content: string;
  change_reason: string | null;
  changed_at: string;
}

export interface OperationLogEntry {
  id?: number;
  operation: string;
  input_summary: string | null;
  context: string | null;
  output_node_ids: string | null; // JSON array
  tool: string | null;
  session: string | null;
  agent_id?: string | null;
  created: string;
}

// --- MCP 接口类型 ---

// prepare
export interface PrepareInput {
  tool: string;
  files?: string[];
  hint?: string;
  detail_level?: DetailLevel;
  agent_id?: string;
}

/** @deprecated 被新的 PrepareOutput 结构替代 */
export interface IndexEntry {
  ref: string;
  title: string;
  description: string;
  category: 'tag' | 'topic' | 'pattern' | 'surprise';
}

export interface PrepareProfile {
  text: string;
  structured?: Record<string, unknown>;
  generated_at: string;
}

export interface PrepareKeystone {
  id: string;
  title: string | null;
  type: NodeType;
  link_count: number;
}

export interface PrepareTag {
  id: string;
  title: string;
  link_count: number;
}

export interface PrepareCrystalHighlighted {
  id: string;
  title: string | null;
  snippet: string;
  heat: number;
}

export interface PrepareCrystalOther {
  id: string;
  title: string | null;
}

export interface PrepareRecent {
  id: string;
  title: string | null;
  type: NodeType;
  timestamp: string;
}

export interface PrepareOutput {
  profile: PrepareProfile;
  keystones: PrepareKeystone[];
  tags: PrepareTag[];
  crystals: {
    highlighted: PrepareCrystalHighlighted[];
    others: PrepareCrystalOther[];
  };
  recent: PrepareRecent[];
  guidance?: string;
}

// recall
export type RecallMode = 'index' | 'detail';
export type RecallSort = 'relevance' | 'recent';
export type RecallMatch = 'any' | 'all';

/** time 过滤窗口（preset 和 after/before 可同时传，取交集） */
export interface RecallTimeFilter {
  preset?: 'today' | 'recent_3days' | 'recent_week' | 'recent_month' | 'recent_3months';
  after?: string;   // ISO date
  before?: string;  // ISO date
}

/**
 * brain_recall 输入。
 * 设计 doc: docs/design/brain-recall-redesign-2026-05.md §4.1
 *
 * 字段分四类：
 *   1. 搜索维度：query / match / context
 *   2. 过滤维度：time / tags / type / from_agents
 *   3. 返回控制：sort / limit / mode
 *   4. Override 入口（互斥）：node_id / from_node / vault_file (+ relation, depth)
 *
 * 兼容字段（保留 1-2 版本做 silent 映射）：
 *   - source_file → vault_file
 *   - scope → tags
 *   - index_ref → tags / node_id
 *   - created_after/before → time.after/before
 *
 * 直接砍（handler 检测到返回 hint）：intent / include_surprise
 */
export interface RecallInput {
  // ── 搜索维度 ──
  query?: string;
  match?: RecallMatch;
  context?: string;

  // ── 过滤维度 ──
  time?: RecallTimeFilter;
  tags?: string[];
  type?: string;
  from_agents?: string[];

  // ── 返回控制 ──
  sort?: RecallSort;
  limit?: number;
  mode?: RecallMode;

  // ── Override 入口 ──
  node_id?: string;
  from_node?: string;
  relation?: string;
  depth?: number;
  vault_file?: string;

  // ── 兼容字段（normalizeInput 会映射到新字段）──
  /** @deprecated 用 vault_file */
  source_file?: string;
  /** @deprecated 用 tags */
  scope?: string;
  /** @deprecated 用 tags 或 node_id */
  index_ref?: string;
  /** @deprecated 用 time.after */
  created_after?: string;
  /** @deprecated 用 time.before */
  created_before?: string;

  // ── 直接砍（仍接收以便 handler 返回升级 hint）──
  /** @deprecated since v0.2.77, agent 不应再传 */
  intent?: unknown;
  /** @deprecated since v0.2.77, agent 不应再传 */
  include_surprise?: unknown;

  // ── 内部上下文（不是 agent 传的）──
  agent_id?: string;
  source_tool?: string;
}

/** 索引模式返回的轻量条目 */
export interface RecallIndexItem {
  id: string;
  type: NodeType;
  title: string | null;
  snippet: string;
  tags: string[];
  heat: number;
  created: string;
  // 新版返回字段（设计 doc §7.0）
  matched_on?: string[];
  scores?: RecallScores;
  reason?: string;
}

export interface RecallNodeLink {
  to_id: string;
  to_title: string | null;
  to_type: NodeType;
  relation: LinkRelation[];
  strength: number;
  note?: string;
}

/** 评分维度（设计 doc §7.1） */
export interface RecallScores {
  keyword: number;
  semantic: number;
  heat: number;
  recency: number;
  final: number;
}

export interface RecallNode {
  id: string;
  type: NodeType;
  title: string | null;
  content: string;
  maturity: {
    heat: number;
    refinement: number;
    connectivity: number;
    independence: number;
  };
  links: RecallNodeLink[];
  source_ref?: string;
  tags?: string[];
  /** 人类/LLM 可读的新鲜度提示。undefined 表示记忆足够新鲜。 */
  freshness?: string;
  // 新版返回字段
  created?: string;
  matched_on?: string[];
  scores?: RecallScores;
  reason?: string;
}

/** Recall diagnostics — 永不空返的关键 (设计 doc §7) */
export interface RecallDiagnostics {
  exact_count: number;
  related_count: number;
  fallback_chain?: string;
  vector_unavailable?: boolean;
  embedding_timeout_ms?: number;
  hint?: string;
}

/**
 * 新版返回结构（设计 doc §7）。
 * 永远 exact_matches + related_matches 分段，0 exact 时也带 diagnostics。
 *
 * 兼容旧字段（nodes / mode / summary / surprises）保留 1-2 版本，调用方逐步迁移。
 */
export interface RecallOutput {
  // ── 新版核心字段 ──
  exact_matches?: (RecallNode | RecallIndexItem)[];
  related_matches?: (RecallNode | RecallIndexItem)[];
  diagnostics?: RecallDiagnostics;

  // ── 旧字段（兼容期保留）──
  nodes: RecallNode[] | RecallIndexItem[];
  mode: RecallMode;
  summary?: string;
  /** @deprecated since v0.2.77，被 related_matches 取代 */
  surprises?: Array<{
    insight: string;
    node_a_id: string;
    node_b_id: string;
    confidence: number;
  }>;
}

// digest
export interface DigestSource {
  tool: string;
  session?: string;
  files?: string[];
}

export interface DigestInput {
  content: string;
  title?: string;
  source?: DigestSource;
  context?: string;
  tags?: string[];
  target_node?: string;
  target_link?: { from: string; to: string };
  intent?: DigestIntent;
  async?: boolean;
  agent_id?: string;
  /** 导入场景：覆盖 assessContentQuality 的初始 heat */
  initialHeat?: number;
  /** 导入场景：覆盖 now() 的原始创建时间（ISO 8601） */
  created?: string;
  /**
   * 跳过 landing 的**去重合并**分支（仅建立连接，不执行 merge）。
   *
   * 适用于调用方已持有自己的身份/去重机制的场景：
   * - 外部笔记同步（logseq/obsidian/notion/apple-notes）：身份由 file+segment
   *   hash 或 block UUID 决定，编辑历史走 supersede 链
   * - 属性值提升（property-promote）：已做字符串精确匹配+缓存去重
   *
   * 为 true 时，即使新节点与某个历史节点向量相似度 ≥ 0.92，也不会归并，
   * 仍然作为独立新节点存在。landing 的**链接分支**（confirmed/pending）
   * 正常执行，新节点仍会与历史相关节点建立认知连接。
   *
   * 默认 false：brain_digest 等"无身份源"入口应保留向量归并作为兜底。
   */
  skipDedupMerge?: boolean;
  /**
   * 内部字段：异步 digest 首次写入 stream 后得到的真实锚点引用
   * (`stream/<file>#<anchor>`)。enqueue 时随 input 一起持久化,retry 时复用,
   * 避免 retry 路径用占位的 `retry:<traceId>` 覆盖节点 source_stream、丢失真实锚点。
   * 非 MCP 入口/同步路径不设置。
   */
  _retryStreamRef?: string;
}

export interface DigestOutput {
  status: 'accepted' | 'processed' | 'rejected';
  trace_id?: string;
  reject_reason?: string;
  created_nodes?: Array<{ id: string; content: string; type: NodeType }>;
  updated_nodes?: Array<{ id: string; content: string; version: number }>;
  created_links?: Array<{ from_id: string; to_id: string; relation: string }>;
  archived_nodes?: string[];
}

// --- 搜索 ---
export interface SearchResult {
  node: BrainNode;
  score: number;
  source: 'bm25' | 'vector' | 'hybrid';
}

export interface HybridWeights {
  alpha: number; // BM25
  beta: number;  // vector
  gamma: number; // heat
  delta: number; // maturity
}

// --- 配置 ---
export interface AppConfig {
  general: {
    data_dir: string;
    user_name: string;
  };
  // 服务连接
  anthropic: {
    api_key: string;
  };
  vertex: {
    project_id: string;
    region: string;
  };
  ollama: {
    url: string;
  };
  gemini: {
    api_key: string;
  };
  // 功能用途
  llm: {
    provider: 'anthropic' | 'vertex' | 'gemini' | 'ollama' | 'openai-compatible';  // 默认 provider（向后兼容）
    light_provider?: 'anthropic' | 'vertex' | 'gemini' | 'ollama' | 'openai-compatible';
    standard_provider?: 'anthropic' | 'vertex' | 'gemini' | 'ollama' | 'openai-compatible';
    heavy_provider?: 'anthropic' | 'vertex' | 'gemini' | 'ollama' | 'openai-compatible';
    // 新：按 connection_id 引用（优先于 provider）
    light_connection?: string;
    standard_connection?: string;
    heavy_connection?: string;
    light_model: string;
    standard_model: string;
    heavy_model: string;
    /** 是否对 Claude 路径开启 prompt caching(默认 true) */
    prompt_cache_enabled?: boolean;
  };
  embedding: {
    provider: 'vertex' | 'gemini' | 'ollama';
    connection?: string;  // connection_id（优先于 provider）
    model: string;
    dimensions: number;
  };
  search: HybridWeights;
  gates: {
    vector_search: number;
    graph_expansion: number;
    graph_expansion_links: number;
    crystal_generation: number;
    divergent_scan: number;
    learning_2_min_nodes: number;
    learning_2_min_recall_ops: number;
  };
  metabolism: {
    annotate_interval_minutes: number;
    daily_check_hours: number;
    weekly_check_days: number;
  };
  /**
   * digest.interactive_mode：
   *   - "silent"（默认）：digest 遇到模糊决策（比如 correction 但 target_node 不存在）时，
   *     按启发式自动处理（保持既有硬拒/兜底行为），不打扰用户
   *   - "ask"：在客户端支持 MCP elicitation 的前提下，弹对话框让用户选归类/纠正目标
   */
  digest?: {
    interactive_mode: 'silent' | 'ask';
  };
  cloud?: {
    enabled: boolean;
    sync_enabled: boolean;
    /** 本地/云代谢互斥: true 时本地 scheduler 停跑,服务端代谢接管 */
    metabolism_enabled?: boolean;
    server_url: string;
  };
  update?: {
    /** 'stable'(默认) | 'beta'(Beta 频道,收 prerelease) */
    channel: 'stable' | 'beta';
  };
  sources?: {
    logseq?: {
      path: string;
      watch: boolean;
      poll_interval: number;
      import_concurrency?: number;
      import_batch_size?: number;
      excluded_dirs?: string[];
    };
    obsidian?: {
      path: string;
      watch: boolean;
      import_concurrency?: number;
      import_batch_size?: number;
    };
  };
}

// --- 门控 ---
export interface GateStatus {
  node_count: number;
  link_count: number;
  recall_count: number;
  features: {
    basic_digest: boolean;
    bm25_search: boolean;
    vector_search: boolean;
    graph_expansion: boolean;
    crystal_generation: boolean;
    divergent_scan: boolean;
  };
}

// --- LLM 提取结果 ---
export interface ExtractedNode {
  type: NodeType;
  content: string;
  tags?: string[];
  initial_heat?: number;
  initial_refinement?: number;
  initial_independence?: number;
}
