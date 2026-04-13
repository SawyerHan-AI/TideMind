// ============================================================
// Logseq 处理队列
//
// 限速批量处理文件：preprocess → segment → digest。
// 遵循 vectors.ts reembedAllNodes 的模式。
// ============================================================

import path from 'node:path';
import type Database from 'better-sqlite3';
import type { ImportProgress, QueueConfig, FileSyncState } from './types.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('logseq');
import { preprocessFile, updateBlockIndexForFile } from './preprocessor.js';
import { segmentContent } from './segmenter.js';
import {
  getFileState, setFileState, isFileChanged,
  computeFileHash, getFileStat,
} from './sync-state.js';
import { digest } from '../../tools/digest.js';
import { updateNode } from '../../db/nodes.js';
import { createLink, linkExists } from '../../db/links.js';
import { now } from '../../utils/time.js';
import { promotePropertyValues } from '../shared/property-promote.js';
import { supersedeNode } from '../shared/version.js';
import { SYSTEM_PROPERTIES } from './types.js';

const DEFAULT_CONFIG: QueueConfig = {
  concurrency: 3,
  batchSize: 10,
  delayBetweenBatches: 1000,
};

// --- 进度追踪（多实例 Map） ---

const DEFAULT_PROGRESS: ImportProgress = {
  phase: 'idle',
  totalFiles: 0,
  processedFiles: 0,
  skippedFiles: 0,
  failedFiles: 0,
  currentFile: null,
  startedAt: null,
};

const progressMap = new Map<string, ImportProgress>();
const DEFAULT_SOURCE = '__default__';

function getProgress(sourceId?: string): ImportProgress {
  const key = sourceId ?? DEFAULT_SOURCE;
  if (!progressMap.has(key)) {
    progressMap.set(key, { ...DEFAULT_PROGRESS });
  }
  return progressMap.get(key)!;
}

export function getImportProgress(sourceId?: string): ImportProgress {
  return { ...getProgress(sourceId) };
}

function resetProgress(sourceId?: string): void {
  const key = sourceId ?? DEFAULT_SOURCE;
  progressMap.set(key, { ...DEFAULT_PROGRESS });
}

// --- 核心处理 ---

/**
 * 批量处理文件列表
 *
 * @param db - 数据库
 * @param files - 待处理的文件绝对路径列表
 * @param graphRoot - Logseq graph 根目录
 * @param config - 队列配置
 * @param sourceId - 笔记源 ID（多实例支持）
 */
export async function processFileQueue(
  db: Database.Database,
  files: string[],
  graphRoot: string,
  config: Partial<QueueConfig> = {},
  sourceId?: string,
): Promise<void> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const progress = getProgress(sourceId);

  Object.assign(progress, {
    phase: 'processing',
    totalFiles: files.length,
    processedFiles: 0,
    skippedFiles: 0,
    failedFiles: 0,
    currentFile: null,
    startedAt: new Date().toISOString(),
  });

  // 按 batch 处理
  for (let i = 0; i < files.length; i += cfg.batchSize) {
    const batch = files.slice(i, i + cfg.batchSize);

    // 每个 batch 内，最多 concurrency 个并行
    for (let j = 0; j < batch.length; j += cfg.concurrency) {
      const concurrent = batch.slice(j, j + cfg.concurrency);
      await Promise.all(
        concurrent.map(file => processOneFile(db, file, graphRoot, sourceId)),
      );
    }

    // batch 间延迟
    if (i + cfg.batchSize < files.length) {
      await delay(cfg.delayBetweenBatches);
    }
  }

  progress.phase = 'done';
  progress.currentFile = null;
  log.info(
    `导入完成: ${progress.processedFiles} 处理, ${progress.skippedFiles} 跳过, ${progress.failedFiles} 失败`,
  );
}

/**
 * 处理单个文件
 */
async function processOneFile(
  db: Database.Database,
  filePath: string,
  graphRoot: string,
  sourceId?: string,
): Promise<void> {
  const relPath = path.relative(graphRoot, filePath).replace(/\\/g, '/');
  const progress = getProgress(sourceId);
  progress.currentFile = relPath;

  try {
    // 检查同步状态
    const syncState = getFileState(db, relPath, sourceId);
    if (!isFileChanged(filePath, syncState)) {
      progress.skippedFiles++;
      return;
    }

    // 预处理
    const preprocessed = preprocessFile(filePath, graphRoot);
    if (!preprocessed) {
      progress.skippedFiles++;
      return;
    }

    // 分段
    const segments = segmentContent(
      preprocessed.cleanContent,
      preprocessed.title,
      preprocessed.metadata.isJournal,
    );

    if (segments.length === 0) {
      progress.skippedFiles++;
      return;
    }

    // 记录旧版本节点 ID（用于后续 supersede）
    const oldNodeIds = syncState?.node_ids ?? [];

    // 逐段 digest（同步模式，收集 node IDs）
    const allNodeIds: string[] = [];

    for (const segment of segments) {
      // 自定义属性（如 rating:: 5, source:: url）拼入上下文
      const propEntries = Object.entries(preprocessed.metadata.properties);
      const propsStr = propEntries.length > 0
        ? propEntries.slice(0, 10).map(([k, v]) => `${k}: ${v}`).join(', ')
        : '';

      const contextParts = [
        `Logseq: ${preprocessed.title}`,
        segment.context !== preprocessed.title ? segment.context : '',
        preprocessed.metadata.tags.length > 0
          ? `标签: ${preprocessed.metadata.tags.join(', ')}`
          : '',
        propsStr ? `属性: ${propsStr}` : '',
        preprocessed.metadata.pageRefs.length > 0
          ? `关联页面: ${preprocessed.metadata.pageRefs.slice(0, 5).join(', ')}`
          : '',
      ].filter(Boolean).join(' | ');

      // 合并 tags + pageRefs 作为标签（去重）
      const combinedTags = [
        ...new Set([
          ...preprocessed.metadata.tags,
          ...preprocessed.metadata.pageRefs,
        ]),
      ];
      // PDF 标注文件追加标签
      if (relPath.includes('hls__')) {
        if (!combinedTags.includes('PDF标注')) combinedTags.push('PDF标注');
      }

      const result = await digest(db, {
        content: segment.content,
        title: preprocessed.title,
        source: {
          tool: 'logseq',
          files: [relPath],
        },
        context: contextParts,
        tags: combinedTags.length > 0 ? combinedTags : undefined,
        async: false,
      });

      if (result.created_nodes) {
        allNodeIds.push(...result.created_nodes.map(n => n.id));
      }
    }

    // 版本替代：旧节点链接迁移到新节点，旧节点标记为 superseded
    if (oldNodeIds.length > 0 && allNodeIds.length > 0) {
      const pairs = Math.min(oldNodeIds.length, allNodeIds.length);
      for (let i = 0; i < pairs; i++) {
        supersedeNode(db, oldNodeIds[i], allNodeIds[i]);
      }
      // 多出来的旧节点直接标记 superseded
      for (let i = pairs; i < oldNodeIds.length; i++) {
        db.prepare('UPDATE nodes SET is_superseded = 1, heat = 0.01 WHERE id = ?').run(oldNodeIds[i]);
        db.prepare('DELETE FROM links WHERE from_id = ? OR to_id = ?').run(oldNodeIds[i], oldNodeIds[i]);
      }
    }

    // 属性值提升为 tag 节点
    if (Object.keys(preprocessed.metadata.properties).length > 0) {
      await promotePropertyValues(
        db, preprocessed.metadata.properties, allNodeIds,
        'logseq', SYSTEM_PROPERTIES,
      );
    }

    // 更新同步状态
    const fileStat = getFileStat(filePath);
    const fileState: FileSyncState = {
      file_path: relPath,
      content_hash: computeFileHash(filePath),
      mtime: fileStat?.mtime ?? 0,
      size: fileStat?.size ?? 0,
      last_synced: now(),
      node_ids: allNodeIds,
    };
    setFileState(db, fileState, sourceId);

    // 更新 block 索引
    updateBlockIndexForFile(filePath);

    progress.processedFiles++;
  } catch (err) {
    log.error(`文件处理失败 (${relPath}):`, (err as Error).message);
    progress.failedFiles++;
  }
}

/**
 * 处理单个文件变更（watcher 调用，轻量版）
 */
export async function processFileChange(
  db: Database.Database,
  filePath: string,
  graphRoot: string,
  sourceId?: string,
): Promise<void> {
  await processOneFile(db, filePath, graphRoot, sourceId);
}

// --- 工具 ---

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export { resetProgress };
