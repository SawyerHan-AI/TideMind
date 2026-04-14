// ============================================================
// Notion 集成类型定义
// ============================================================

// 复用共享类型
export type {
  PreprocessedPage,
  PageMetadata,
  Segment,
  ImportProgress,
  QueueConfig,
} from '../logseq/types.js';

/** Notion 同步状态记录 */
export interface NotionSyncState {
  page_id: string;
  content_hash: string;
  last_edited_time: string;
  page_type: 'page' | 'database_page';
  last_synced: string;
  node_ids: string[];
  source_id: string;
}

/** Notion pending relation 记录 */
export interface NotionPendingRelation {
  source_page_id: string;
  target_page_id: string;
  source_node_id: string;
  property_name: string;
  source_id: string;
  created: string;
}

/** Search API 返回的页面摘要 */
export interface NotionPageSummary {
  id: string;
  title: string;
  lastEditedTime: string;
  parentType: 'workspace' | 'page_id' | 'database_id';
  parentId: string | null;
  inTrash: boolean;
  icon: { type: 'emoji'; emoji: string } | null;
  url: string;
}

/** Notion 系统属性（不渲染到正文、不做 promotion） */
export const NOTION_SYSTEM_PROPERTIES = [
  'Created',
  'Created time',
  'Created by',
  'Last edited time',
  'Last edited by',
];

/** 跳过的块类型（不产生文本） */
export const NOTION_SKIPPED_BLOCK_TYPES = new Set([
  'divider',
  'table_of_contents',
  'breadcrumb',
  'image',
  'video',
  'audio',
  'file',
  'pdf',
  'bookmark',
  'embed',
  'link_preview',
  'template',
  'unsupported',
]);
