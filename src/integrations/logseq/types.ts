// ============================================================
// Logseq 集成类型定义
// ============================================================

/** 预处理后的页面 */
export interface PreprocessedPage {
  title: string;
  cleanContent: string;
  metadata: PageMetadata;
  // 原始文件内容（已 CRLF→LF 归一化）。文件型源（Logseq）必填：供调用方在同一
  // snapshot 内算 content_hash，避免 TOCTOU——digest 期间用户编辑文件时，重新读盘
  // 算出的是"新内容"hash，但入库节点是"旧内容"，下一轮 isFileChanged 会误判未变更、
  // 永久跳过这次编辑（对齐 Obsidian）。非文件型源（Notion 从 API 拉取、自算 hash）
  // 无原始文件内容，故声明为可选。
  rawContent?: string;
}

export interface PageMetadata {
  aliases: string[];
  tags: string[];
  pageRefs: string[];
  blockRefAssociations: BlockRefAssociation[];
  properties: Record<string, string>;
  isJournal: boolean;
  filePath: string;
}

export interface BlockRefAssociation {
  refId: string;
  resolvedContent: string;
}

/** 分段结果 */
export interface Segment {
  content: string;
  context: string;
}

/** Block 树节点 */
export interface Block {
  content: string;
  indent: number;
  children: Block[];
}

/** 同步状态记录 */
export interface FileSyncState {
  file_path: string;
  content_hash: string;
  mtime: number;
  size: number;
  last_synced: string;
  node_ids: string[];
  segment_hashes?: string[];  // 与 node_ids 平行，每段的 content hash（Logseq 段级去重）
}

/** 导入进度 */
export interface ImportProgress {
  phase: 'scanning' | 'indexing' | 'processing' | 'done' | 'idle';
  totalFiles: number;
  processedFiles: number;
  skippedFiles: number;
  failedFiles: number;
  currentFile: string | null;
  startedAt: string | null;
}

/** 处理队列配置 */
export interface QueueConfig {
  concurrency: number;
  batchSize: number;
  delayBetweenBatches: number;
}

/** 排除的目录列表 */
export const EXCLUDED_DIRS = [
  'logseq/bak',
  'logseq/.recycle',
  'logseq/version-files',
  'draws',
  'whiteboards',
  'assets',
  '.git',
  '.trash',
  'node_modules',
];

/** Logseq 系统 properties，不携带语义信息 */
export const SYSTEM_PROPERTIES = [
  'id',
  'collapsed',
  'custom-css-class',
  'heading',
  'background-color',
  // PDF 标注相关
  'hl-type',
  'hl-page',
  'hl-stamp',
  'hl-color',
  'ls-type',
  'file-path',
  'file',
  'title',
  // 排序/列表
  'order-list-type',
  'logseq.order-list-type',
  // 页面 UI 配置
  'filters',
  'icon',
  // query 表格配置
  'query-table',
  'query-properties',
  'query-sort-by',
  'query-sort-desc',
  // 时间戳
  'created-at',
  'updated-at',
  // 任务状态相关
  'later',
  'now',
  'waiting',
  'done',
  // 闪卡系统
  'card-last-interval',
  'card-repeats',
  'card-ease-factor',
  'card-next-schedule',
  'card-last-reviewed',
  'card-last-score',
];
