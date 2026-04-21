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

export interface RecallInput {
  query?: string;
  node_id?: string;
  index_ref?: string;
  source_file?: string;
  from_node?: string;
  context?: string;
  intent?: Intent;
  relation?: string;
  depth?: number;
  scope?: string;
  type?: string;
  created_after?: string;
  created_before?: string;
  include_surprise?: boolean;
  limit?: number;
  mode?: RecallMode;
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
}

export interface RecallNodeLink {
  to_id: string;
  to_title: string | null;
  to_type: NodeType;
  relation: LinkRelation[];
  strength: number;
  note?: string;
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
}

export interface RecallOutput {
  nodes: RecallNode[] | RecallIndexItem[];
  mode: RecallMode;
  summary?: string;
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
  cloud?: {
    enabled: boolean;
    sync_enabled: boolean;
    /** 本地/云代谢互斥: true 时本地 scheduler 停跑,服务端代谢接管 */
    metabolism_enabled?: boolean;
    server_url: string;
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
