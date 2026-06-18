// ============================================================
// Obsidian 集成类型定义
// ============================================================

// 复用 Logseq 侧已定义的通用类型
export type {
  PreprocessedPage,
  PageMetadata,
  BlockRefAssociation,
  Segment,
  Block,
  FileSyncState,
  ImportProgress,
  QueueConfig,
} from '../logseq/types.js';

// --- Obsidian Vault 配置 ---

/** Vault 级配置（从 .obsidian/ 目录读取） */
export interface ObsidianVaultConfig {
  dailyNotes: { folder: string; format: string; template: string } | null;
  attachmentFolder: string;
  templateFolder: string;
  useMarkdownLinks: boolean;
}

/** 文件分类类型 */
export type ObsidianFileCategory =
  | 'daily_note'
  | 'regular'
  | 'readwise'
  | 'chatgpt_export'
  | 'excalidraw'
  | 'index_page'
  | 'metadata_only'
  | 'canvas'
  | 'template'
  | 'attachment'
  | 'empty_tag';

/** 分类后的文件信息 */
export interface ClassifiedFile {
  relPath: string;
  absPath: string;
  category: ObsidianFileCategory;
  inDegree: number;
}

// --- 排除规则 ---

/** 排除的目录列表 */
export const OBSIDIAN_EXCLUDED_DIRS = ['.obsidian', '.trash', '.git', 'node_modules'];

/** 排除的文件扩展名 */
export const OBSIDIAN_EXCLUDED_EXTENSIONS = ['.base', '.excalidrawlib'];

// --- 系统属性 ---

/** Obsidian 系统 properties，不携带语义信息 */
export const OBSIDIAN_SYSTEM_PROPERTIES = [
  'cssclasses', 'cssclass', 'cssClass',
  'publish', 'permalink',
  'obsidianUIMode',
  'banner', 'banner_icon', 'banner_y', 'banner_x',
  'kanban-plugin', 'database-plugin',
  'linter-yaml-title-alias',
  'hide_cover_in_article',
  'excalidraw-plugin',
  'query-table', 'query-properties', 'query-sort-by', 'query-sort-desc',
];

// --- 插件代码块 ---

/** 需要整块移除的插件代码块类型 */
export const PLUGIN_CODE_BLOCKS = [
  'dataview', 'dataviewjs',
  'tasks',
  'tracker',
  'ccard',
  'query', 'query2table',
  'twig',
  'table-of-contents',
  'req',
];

// --- 日期字段优先级 ---

/** frontmatter 日期字段匹配优先级（用于推断页面日期） */
export const DATE_FIELD_PRIORITY = [
  'date', 'created', 'creation_date', 'date created',
  'modified', 'modification_date', 'date modified',
  'last', 'published', 'updated',
];

// --- Checkbox 映射 ---

// --- Canvas 类型 ---

/** Canvas JSON 文件的原始数据结构 */
export interface CanvasData {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export interface CanvasNodeBase {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
}

export interface CanvasTextNode extends CanvasNodeBase {
  type: 'text';
  text: string;
}

export interface CanvasFileNode extends CanvasNodeBase {
  type: 'file';
  file: string;
  subpath?: string;
}

export interface CanvasLinkNode extends CanvasNodeBase {
  type: 'link';
  url: string;
}

export interface CanvasGroupNode extends CanvasNodeBase {
  type: 'group';
  label?: string;
}

export type CanvasNode = CanvasTextNode | CanvasFileNode | CanvasLinkNode | CanvasGroupNode;

export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: 'top' | 'right' | 'bottom' | 'left';
  toSide?: 'top' | 'right' | 'bottom' | 'left';
  fromEnd?: 'none' | 'arrow';
  toEnd?: 'none' | 'arrow';
  label?: string;
  color?: string;
}

/** Canvas 解析结果 */
export interface CanvasParseResult {
  textNodes: Array<{ id: string; text: string; color?: string; groupLabels: string[] }>;
  fileRefs: Array<{ id: string; file: string; subpath?: string }>;
  linkNodes: Array<{ id: string; url: string }>;
  edges: Array<{ fromId: string; toId: string; label?: string; confidence: number }>;
  // parse 时刻读到的原始文件内容。避免 TOCTOU：调用方据此算 content_hash,
  // 不再 digest 后二次重读盘(重读会拿到 digest 期间用户的新编辑导致编辑丢失)。
  rawContent: string;
}

// --- Checkbox 映射 ---

/** Obsidian 扩展 checkbox 状态映射 */
export const CHECKBOX_MAP: Record<string, string> = {
  'x': '[已完成]',
  ' ': '[待办]',
  '>': '[推迟]',
  'o': '[进行中]',
  '/': '[半完成]',
  '-': '[取消]',
  '?': '[待确认]',
  '!': '[重要]',
};

// --- 字段名归一化 ---

/** frontmatter 字段名别名映射（统一为规范名称） */
export const FIELD_NAME_ALIASES: Record<string, string> = {
  'tag': 'tags',
  'Tag': 'tags',
  'Tags': 'tags',
  'alias': 'aliases',
  'Alias': 'aliases',
  'Aliases': 'aliases',
  'cssclass': 'cssclasses',
  'cssClass': 'cssclasses',
  'CSSclass': 'cssclasses',
};
