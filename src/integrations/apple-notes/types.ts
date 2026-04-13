// ============================================================
// Apple Notes 集成类型定义
// ============================================================

import os from 'node:os';

/** Core Data epoch 偏移量：2001-01-01 到 1970-01-01 的秒数 */
export const CORE_DATA_EPOCH_OFFSET = 978307200;

/** NoteStore.sqlite 默认路径 */
export const DEFAULT_DB_PATH = `${os.homedir()}/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite`;

/** 分段最大字符数（与 Logseq/Obsidian 一致） */
export const MAX_SEGMENT_CHARS = 3000;

/** 默认轮询间隔（秒） */
export const DEFAULT_POLL_INTERVAL = 60;

// ======== 数据库实体 ========

/** Apple Notes 账户 */
export interface AppleAccount {
  zpk: number;
  name: string;
  uuid: string;
  /** CloudKit 用户记录名（仅 iCloud 账户有值） */
  userRecordName: string | null;
}

/** Apple Notes 文件夹 */
export interface AppleFolder {
  zpk: number;
  title: string;
  uuid: string;
  parentZpk: number | null;
  ownerZpk: number;
  /** 是否为智能文件夹 */
  isSmart: boolean;
}

/** Apple Notes 笔记（原始数据库记录） */
export interface AppleNote {
  zpk: number;
  uuid: string;
  title: string | null;
  snippet: string | null;
  folderZpk: number | null;
  accountZpk: number | null;
  creationDate: number;       // Core Data epoch
  modificationDate: number;   // Core Data epoch
  isPasswordProtected: boolean;
  markedForDeletion: boolean;
  /** ZICNOTEDATA.ZDATA 原始 blob */
  zdata: Buffer | null;
}

/** 笔记标签（iOS 15+） */
export interface AppleTag {
  displayText: string;
  noteZpk: number;
}

/** 附件文本（OCR/手写/音频转录） */
export interface AttachmentText {
  uuid: string;
  typeUti: string;
  ocrSummary: string | null;
  additionalIndexableText: string | null;
}

// ======== Schema 版本 ========

/** 数据库 schema 版本配置 */
export interface SchemaVersion {
  /** macOS 版本标识（如 '13', '14', '15', '26'） */
  version: string;
  /** 笔记所属账户的外键列名 */
  accountFK: string;
  /** 创建时间列名 */
  creationDateCol: string;
  /** 修改时间列名 */
  modificationDateCol: string;
  /** 是否支持 hashtags（macOS 12+） */
  hasHashtags: boolean;
  /** 是否支持智能文件夹（macOS 12+） */
  hasSmartFolders: boolean;
}

// ======== 处理后的数据 ========

/** 处理后的笔记（用于 digest） */
export interface ProcessedNote {
  uuid: string;
  title: string;
  cleanText: string;
  folderPath: string | null;
  tags: string[];
  creationDate: string;       // ISO 8601
  modificationDate: string;   // ISO 8601
}

/** 分段结果 */
export interface Segment {
  content: string;
  context: string;
}

// ======== 同步状态 ========

/** 笔记同步状态记录 */
export interface NoteSyncState {
  note_uuid: string;
  modification_date: number;  // Core Data epoch
  content_hash: string;
  last_synced: string;
  node_ids: string[];
  source_id: string;
}

/** 导入进度 */
export interface ImportProgress {
  phase: 'scanning' | 'processing' | 'done' | 'idle';
  totalNotes: number;
  processedNotes: number;
  skippedNotes: number;
  failedNotes: number;
  currentNote: string | null;
  startedAt: string | null;
}

/** 处理队列配置 */
export interface QueueConfig {
  concurrency: number;
  batchSize: number;
  delayBetweenBatches: number;
}

/** 附件 UTI 类型常量 */
export const ATTACHMENT_UTIS = {
  HASHTAG: 'com.apple.notes.inlinetextattachment.hashtag',
  MENTION: 'com.apple.notes.inlinetextattachment.mention',
  LINK: 'com.apple.notes.inlinetextattachment.link',
  TABLE: 'com.apple.notes.table',
  DRAWING: 'com.apple.drawing.2',
  GALLERY: 'com.apple.notes.gallery',
  AUDIO: 'com.apple.m4a-audio',
} as const;

/** ParagraphStyle.style_type 常量 */
export const PARAGRAPH_STYLES = {
  TITLE: 0,
  HEADING: 1,
  SUBHEADING: 2,
  MONOSPACED: 4,
  DOT_LIST: 100,
  DASH_LIST: 101,
  NUMBERED_LIST: 102,
  CHECKLIST: 103,
} as const;
