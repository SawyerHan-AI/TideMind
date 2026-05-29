// ============================================================
// Apple Notes 批量处理队列
//
// 模式同 logseq/queue.ts：批量 + 并发 + digest + supersede
// ============================================================

import type Database from 'better-sqlite3';
import { createLogger } from '../../utils/logger.js';
import { SqliteRepository } from '../../db/sqlite-repository.js';
import { digest } from '../../tools/digest.js';
import { supersedeNodeWithLinks } from '../../db/node-lifecycle.js';
import { getOrCreateTagNode } from '../shared/property-promote.js';
import { createLink } from '../../db/links.js';
import { coreDataToISO } from './database.js';
import { decodeNoteData, buildCleanTextWithMap, extractHeadingPositions, mapHeadingOffsets } from './protobuf.js';
import { getNoteState, setNoteState, computeContentHash, isNoteChanged } from './sync-state.js';
import { segmentNote } from './segmenter.js';
import type { AppleNote, AppleTag, AttachmentText, ImportProgress, QueueConfig } from './types.js';

const log = createLogger('apple-notes-queue');

// ======== 进度追踪 ========

const DEFAULT_PROGRESS: ImportProgress = {
  phase: 'idle',
  totalNotes: 0,
  processedNotes: 0,
  skippedNotes: 0,
  failedNotes: 0,
  currentNote: null,
  startedAt: null,
};

const progressMap = new Map<string, ImportProgress>();

function getProgress(sourceId?: string): ImportProgress {
  const key = sourceId ?? '__default__';
  if (!progressMap.has(key)) {
    progressMap.set(key, { ...DEFAULT_PROGRESS });
  }
  return progressMap.get(key)!;
}

export function getImportProgress(sourceId?: string): ImportProgress {
  return { ...getProgress(sourceId) };
}

export function resetProgress(sourceId?: string): void {
  const key = sourceId ?? '__default__';
  progressMap.set(key, { ...DEFAULT_PROGRESS });
}

// ======== 批量处理 ========

const DEFAULT_CONFIG: QueueConfig = {
  concurrency: 3,
  batchSize: 10,
  delayBetweenBatches: 1000,
};

/** processNoteQueue 返回的汇总结果 */
export interface QueueResult {
  nodeIdsCreated: string[];  // 本次入库新建的节点 ID（不含 supersede 前的旧节点）
  linksCreated: number;      // 本次入库创建的链接数（含 part_of、文件夹 tag chain 等）
  notesProcessed: number;
  notesSkipped: number;
  notesFailed: number;
}

interface ProcessContext {
  db: Database.Database;
  folderPathMap: Map<number, string>;
  tagsByNote: Map<number, AppleTag[]>;
  attachTextsByNote: Map<number, AttachmentText[]>;
  sourceId: string;
  /** 收集本次处理产生的节点 ID 和链接计数 */
  result: QueueResult;
}

/**
 * 批量处理笔记队列
 *
 * @param shouldStop 可选的中断谓词，在每个 batch / 并发组之间检查，
 *                   返回 true 则立即跳出循环。用于支持 stopAppleNotesSource 的及时中断。
 */
export async function processNoteQueue(
  db: Database.Database,
  notes: AppleNote[],
  folderPathMap: Map<number, string>,
  tagsByNote: Map<number, AppleTag[]>,
  attachTextsByNote: Map<number, AttachmentText[]>,
  sourceId: string,
  config?: Partial<QueueConfig>,
  shouldStop?: () => boolean,
): Promise<QueueResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const progress = getProgress(sourceId);
  progress.phase = 'processing';
  progress.totalNotes = notes.length;
  progress.processedNotes = 0;
  progress.skippedNotes = 0;
  progress.failedNotes = 0;
  progress.startedAt = new Date().toISOString();

  const result: QueueResult = {
    nodeIdsCreated: [],
    linksCreated: 0,
    notesProcessed: 0,
    notesSkipped: 0,
    notesFailed: 0,
  };

  const ctx: ProcessContext = { db, folderPathMap, tagsByNote, attachTextsByNote, sourceId, result };

  let aborted = false;
  outer: for (let i = 0; i < notes.length; i += cfg.batchSize) {
    if (shouldStop?.()) { aborted = true; break outer; }
    const batch = notes.slice(i, i + cfg.batchSize);

    for (let j = 0; j < batch.length; j += cfg.concurrency) {
      if (shouldStop?.()) { aborted = true; break outer; }
      const concurrent = batch.slice(j, j + cfg.concurrency);
      await Promise.all(
        concurrent.map(note => processOneNote(ctx, note)),
      );
    }

    // 批次间延迟
    if (i + cfg.batchSize < notes.length) {
      await new Promise(resolve => setTimeout(resolve, cfg.delayBetweenBatches));
    }
  }

  progress.phase = aborted ? 'idle' : 'done';
  progress.currentNote = null;

  // 同步计数到返回值（progress 的计数供 UI 显示，result 供调用方精确汇总）
  result.notesProcessed = progress.processedNotes;
  result.notesSkipped = progress.skippedNotes;
  result.notesFailed = progress.failedNotes;

  return result;
}

/**
 * 处理单条笔记
 */
async function processOneNote(
  ctx: ProcessContext,
  note: AppleNote,
): Promise<void> {
  const { db, folderPathMap, tagsByNote, attachTextsByNote, sourceId, result } = ctx;
  const repo = new SqliteRepository(db);
  const progress = getProgress(sourceId);
  progress.currentNote = note.title ?? note.uuid;

  try {
    // 1. 解码 protobuf
    if (!note.zdata) {
      progress.skippedNotes++;
      return;
    }

    const decoded = decodeNoteData(note.zdata);
    if (!decoded) {
      progress.skippedNotes++;
      return;
    }

    // 2. 构建纯文本（同时拿到原始 noteText → cleanText 的偏移映射）
    const attachTexts = attachTextsByNote.get(note.zpk) ?? [];
    const { cleanText, offsetMap } = buildCleanTextWithMap(decoded, attachTexts);

    if (cleanText.length < 10) {
      progress.skippedNotes++;
      return;
    }

    // 3. 变更检测（复用 sync-state.ts 的 isNoteChanged，避免重复实现）
    const contentHash = computeContentHash(cleanText);
    const syncState = getNoteState(db, note.uuid, sourceId);

    if (!isNoteChanged(note.modificationDate, contentHash, syncState)) {
      progress.skippedNotes++;
      return;
    }

    // 4. 分段
    //    标题 offset 是相对原始 noteText 的，必须经 offsetMap 转换到 cleanText
    //    坐标系后再传给 segmentNote，否则清单/附件较多的长笔记会切错位置。
    const rawHeadingPositions = extractHeadingPositions(decoded);
    const headingPositions = mapHeadingOffsets(rawHeadingPositions, offsetMap);
    const title = note.title ?? '无标题笔记';
    const segments = segmentNote(cleanText, title, headingPositions);

    if (segments.length === 0) {
      progress.skippedNotes++;
      return;
    }

    // 5. 收集元数据
    const noteTags = (tagsByNote.get(note.zpk) ?? []).map(t => t.displayText);
    const folderPath = note.folderZpk ? folderPathMap.get(note.folderZpk) ?? null : null;
    const folderTags = folderPath ? folderPath.split('/') : [];
    const allTags = [...new Set([...noteTags, ...folderTags])];

    // 构建 context 字符串
    const contextParts = [
      `Apple Notes: ${title}`,
      folderPath ? `文件夹: ${folderPath}` : '',
      allTags.length > 0 ? `标签: ${allTags.join(', ')}` : '',
    ].filter(Boolean).join(' | ');

    // 6. Digest 每个 segment
    const oldNodeIds = syncState?.node_ids ?? [];
    const newNodeIds: string[] = [];

    for (const segment of segments) {
      const digestResult = await digest(repo, {
        content: segment.content,
        title,
        source: { tool: 'apple-notes', files: [note.uuid] },
        context: contextParts,
        tags: allTags.length > 0 ? allTags : undefined,
        async: false,
        created: coreDataToISO(note.creationDate),
        // 身份由 note.uuid + segment hash 负责
        skipDedupMerge: true,
      });

      if (digestResult.status === 'processed' && digestResult.created_nodes) {
        for (const n of digestResult.created_nodes) {
          newNodeIds.push(n.id);
          result.nodeIdsCreated.push(n.id);
        }
      }
    }

    if (newNodeIds.length === 0) {
      progress.skippedNotes++;
      return;
    }

    // 7. Version supersede
    if (oldNodeIds.length > 0) {
      const minLen = Math.min(oldNodeIds.length, newNodeIds.length);
      for (let k = 0; k < minLen; k++) {
        supersedeNodeWithLinks(db, oldNodeIds[k], newNodeIds[k]);
      }
      // 多余的旧节点也走 supersedeNode，迁移到最后一个新节点
      // 不能仅 UPDATE nodes SET is_superseded=1——那样 incoming/outgoing links 会残留指向幽灵节点，
      // 让共享链接（手工建立的跨笔记引用等）永远悬挂。
      if (oldNodeIds.length > minLen && newNodeIds.length > 0) {
        const target = newNodeIds[newNodeIds.length - 1];
        for (let k = minLen; k < oldNodeIds.length; k++) {
          supersedeNodeWithLinks(db, oldNodeIds[k], target);
        }
      }
    }

    // 8. 多段 part_of 链接
    if (newNodeIds.length > 1) {
      for (let k = 1; k < newNodeIds.length; k++) {
        const link = createLink(db, {
          from_id: newNodeIds[k],
          to_id: newNodeIds[k - 1],
          relation: [{ type: 'part_of', confidence: 0.95 }],
          strength: 0.9,
          note: `笔记分段 ${k + 1}/${newNodeIds.length}: ${title}`,
          auto: true,
          status: 'confirmed',
        });
        if (link) result.linksCreated++;
      }
    }

    // 9. 文件夹 tag chain
    if (folderPath) {
      const folderLinks = await createFolderTagChain(db, folderPath, newNodeIds);
      result.linksCreated += folderLinks;
    }

    // 10. 更新同步状态
    setNoteState(db, {
      note_uuid: note.uuid,
      modification_date: note.modificationDate,
      content_hash: contentHash,
      last_synced: new Date().toISOString(),
      node_ids: newNodeIds,
      source_id: sourceId,
    });

    progress.processedNotes++;
  } catch (err) {
    log.error(`处理笔记失败 ${note.uuid}:`, (err as Error).message);
    progress.failedNotes++;
  }
}

// ======== 文件夹 Tag Chain ========

/**
 * 创建文件夹层级标签链（复用 Obsidian 的 createFolderTagChain 模式）
 *
 * 路径 "工作/项目A" → 创建 tag 节点 "工作" 和 "项目A"
 * → "项目A" --part_of-→ "工作"
 * → content node --tagged-→ "项目A"
 */
async function createFolderTagChain(
  db: Database.Database,
  folderPath: string,
  nodeIds: string[],
): Promise<number> {
  let linksCreated = 0;
  const parts = folderPath.split('/').filter(Boolean);
  if (parts.length === 0) return 0;

  // 跳过根文件夹 "Notes"（Apple Notes 默认文件夹）
  const meaningfulParts = parts.filter(p => p !== 'Notes');
  if (meaningfulParts.length === 0) return 0;

  let prevTagId: string | null = null;

  for (const part of meaningfulParts) {
    const tagId = await getOrCreateTagNode(db, part);

    if (prevTagId && tagId !== prevTagId) {
      // 子文件夹 → 父文件夹 part_of 关系
      const link = createLink(db, {
        from_id: tagId,
        to_id: prevTagId,
        relation: [{ type: 'part_of', confidence: 0.9 }],
        strength: 0.8,
        auto: true,
        status: 'confirmed',
      });
      if (link) linksCreated++;
    }
    prevTagId = tagId;
  }

  // 内容节点 → 最内层文件夹 tagged 关系
  if (prevTagId) {
    for (const nodeId of nodeIds) {
      const link = createLink(db, {
        from_id: nodeId,
        to_id: prevTagId,
        relation: [{ type: 'tagged', confidence: 0.7 }],
        strength: 0.6,
        auto: true,
        status: 'confirmed',
      });
      if (link) linksCreated++;
    }
  }

  return linksCreated;
}
