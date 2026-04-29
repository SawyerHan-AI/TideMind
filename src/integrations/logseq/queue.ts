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
  computeFileHash, computeSegmentHash, getFileStat,
} from './sync-state.js';
import { SqliteRepository } from '../../db/sqlite-repository.js';
import { digest } from '../../tools/digest.js';
import { createLink, linkExists } from '../../db/links.js';
import { now } from '../../utils/time.js';
import { promotePropertyValues } from '../shared/property-promote.js';
import { supersedeNodeWithLinks } from '../../db/node-lifecycle.js';
import { SYSTEM_PROPERTIES } from './types.js';
import { computeTimeFactor } from './initial-heat.js';

/**
 * 从 journal 文件路径推断创建日期：`journals/YYYY_MM_DD.md` → `YYYY-MM-DD`。
 * 非 journal 文件返回 null，由调用方决定 fallback。
 */
function inferJournalDate(relPath: string): string | null {
  const m = relPath.match(/^journals\/(\d{4})_(\d{2})_(\d{2})\.md$/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

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
 * @param shouldStop - 可选中断谓词，在 batch / 并发组边界检查
 */
export async function processFileQueue(
  db: Database.Database,
  files: string[],
  graphRoot: string,
  config: Partial<QueueConfig> = {},
  sourceId?: string,
  shouldStop?: () => boolean,
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
  let aborted = false;
  outer: for (let i = 0; i < files.length; i += cfg.batchSize) {
    if (shouldStop?.()) { aborted = true; break outer; }
    const batch = files.slice(i, i + cfg.batchSize);

    // 每个 batch 内，最多 concurrency 个并行
    for (let j = 0; j < batch.length; j += cfg.concurrency) {
      if (shouldStop?.()) { aborted = true; break outer; }
      const concurrent = batch.slice(j, j + cfg.concurrency);
      await Promise.all(
        concurrent.map(file => processOneFile(db, file, graphRoot, sourceId, shouldStop)),
      );
    }

    // batch 间延迟
    if (i + cfg.batchSize < files.length) {
      await delay(cfg.delayBetweenBatches);
    }
  }

  progress.phase = aborted ? 'idle' : 'done';
  progress.currentFile = null;
  log.info(
    `导入完成: ${progress.processedFiles} 处理, ${progress.skippedFiles} 跳过, ${progress.failedFiles} 失败`,
  );
}

/**
 * 处理单个文件
 *
 * Cloud mode 说明：watcher 始终在本地运行（检测文件变化），并通过 digest() 写入本地 SQLite。
 * 在 cloud mode 下，MCP router 会拦截 MCP 调用并路由到云端，但 watcher 直接调用 digest()
 * 不经过 MCP，因此绕过了 router。当前这是可接受的，因为：
 *   1. 本地 digest 创建的节点存储在本地 SQLite
 *   2. 迁移向导会在首次同步时将所有本地数据上传到云端
 *   3. TODO(cloud): 未来 watcher 应改为入队 outbox，直接推送到云端
 */
async function processOneFile(
  db: Database.Database,
  filePath: string,
  graphRoot: string,
  sourceId?: string,
  shouldStop?: () => boolean,
): Promise<boolean> {
  const repo = new SqliteRepository(db);
  const relPath = path.relative(graphRoot, filePath).replace(/\\/g, '/');
  const progress = getProgress(sourceId);
  progress.currentFile = relPath;

  try {
    if (shouldStop?.()) return false;

    // 检查同步状态
    const syncState = getFileState(db, relPath, sourceId);
    if (!isFileChanged(filePath, syncState)) {
      progress.skippedFiles++;
      return false;
    }

    if (shouldStop?.()) return false;

    // 预处理
    const preprocessed = preprocessFile(filePath, graphRoot);
    if (!preprocessed) {
      // 空文件/短文件也记录 sync state，避免每次重启重复检查
      markFileAsProcessed(db, filePath, relPath, sourceId);
      progress.skippedFiles++;
      return false;
    }

    // 分段 + 过滤空段
    const segments = segmentContent(
      preprocessed.cleanContent,
      preprocessed.title,
      preprocessed.metadata.isJournal,
    ).filter(s => s.content.trim().length > 0);

    if (segments.length === 0) {
      markFileAsProcessed(db, filePath, relPath, sourceId);
      progress.skippedFiles++;
      return false;
    }

    // 旧版本状态
    const oldNodeIds = syncState?.node_ids ?? [];
    const oldHashes = syncState?.segment_hashes ?? [];

    // 预计算公共上下文参数（所有段共享）
    const propEntries = Object.entries(preprocessed.metadata.properties);
    const propsStr = propEntries.length > 0
      ? propEntries.slice(0, 10).map(([k, v]) => `${k}: ${v}`).join(', ')
      : '';
    // 注意：combinedTags 的定义在下面的循环体内，每段独立构建。
    // 此处不预计算 combinedTags，避免与循环内同名 const 造成语义混淆。

    // 逐段比对 + 增量 digest
    const allNodeIds: string[] = [];
    const allHashes: string[] = [];

    for (let i = 0; i < segments.length; i++) {
      if (shouldStop?.()) return false;

      const segment = segments[i];
      const newHash = computeSegmentHash(segment.content);
      allHashes.push(newHash);

      // 段内容未变且有对应旧节点 → 保留原节点 ID
      if (i < oldHashes.length && oldHashes[i] === newHash && i < oldNodeIds.length) {
        allNodeIds.push(oldNodeIds[i]);
        continue;
      }

      // 段内容变化或新增段 → digest 新节点
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

      // 时间戳和热度推断（与 initialization.ts 保持一致）：
      // journal 文件直接从文件名拿日期；非 journal 文件不传，让 digest() 走 now() + qualityHeat。
      // 不这样做的话，watcher 路径创建的节点 created 全部是 now()，heat 没做年龄衰减，
      // recall 按 created DESC 排序时会把它们错误地顶到最前面。
      // 详见 docs/design/incident-recovery-2026-04-23-icloud-dataless.md §5.2
      const inferredDate = inferJournalDate(relPath);
      const inferredCreated = inferredDate ? `${inferredDate}T00:00:00.000Z` : undefined;
      const inferredInitialHeat = inferredDate
        ? computeTimeFactor({ date: inferredDate, source: 'journal_name' }, now())
        : undefined;

      const result = await digest(repo, {
        content: segment.content,
        // 日记页子节点不设 title——日期标题对多个 segment 都一样，不如让 annotate 生成有意义的标题
        title: preprocessed.metadata.isJournal ? undefined : preprocessed.title,
        source: {
          tool: 'logseq',
          files: [relPath],
        },
        context: contextParts,
        tags: combinedTags.length > 0 ? combinedTags : undefined,
        async: false,
        // 身份由 FileSyncState.node_ids + segment hash 负责，走 supersede 链
        // 跳过 landing 的向量归并，避免不同段落之间因相似度误并
        skipDedupMerge: true,
        // journal 文件：传推断的 created + 年龄衰减 heat；pages 文件：不传，保留默认行为
        created: inferredCreated,
        initialHeat: inferredInitialHeat,
      });

      if (shouldStop?.()) return false;

      if (result.created_nodes && result.created_nodes.length > 0) {
        const newNodeId = result.created_nodes[0].id;
        allNodeIds.push(newNodeId);

        // 有对应旧节点 → supersede
        if (i < oldNodeIds.length) {
          supersedeNodeWithLinks(db, oldNodeIds[i], newNodeId);
        }
      }
    }

    if (allNodeIds.length === 0) {
      log.warn(`文件 digest 未产生新节点,保留旧同步状态: ${relPath}`);
      progress.skippedFiles++;
      return false;
    }

    // 多余旧段：supersede 到最后一个新节点，迁移链接、保留 updates 链
    if (shouldStop?.()) return false;
    // （段数减少场景：把多余旧段的链接归并到最后一个新段上，而不是直接 DELETE 丢失关联）
    if (oldNodeIds.length > segments.length && allNodeIds.length > 0) {
      const targetNewId = allNodeIds[allNodeIds.length - 1];
      for (let i = segments.length; i < oldNodeIds.length; i++) {
        supersedeNodeWithLinks(db, oldNodeIds[i], targetNewId);
      }
    }

    // 多段 part_of 关系串联（与 initialization.ts 一致）
    if (shouldStop?.()) return false;
    if (allNodeIds.length > 1) {
      for (let i = 1; i < allNodeIds.length; i++) {
        if (!linkExists(db, allNodeIds[i], allNodeIds[i - 1])) {
          createLink(db, {
            from_id: allNodeIds[i],
            to_id: allNodeIds[i - 1],
            relation: [{ type: 'part_of', confidence: 0.95 }],
            strength: 0.9,
            note: `页面分段 ${i + 1}/${allNodeIds.length}: ${preprocessed.title}`,
            auto: true,
            status: 'confirmed',
          });
        }
      }
    }

    // 属性值提升为 tag 节点
    if (shouldStop?.()) return false;
    if (Object.keys(preprocessed.metadata.properties).length > 0) {
      await promotePropertyValues(
        db, preprocessed.metadata.properties, allNodeIds,
        'logseq', SYSTEM_PROPERTIES,
      );
    }

    // 更新同步状态
    if (shouldStop?.()) return false;

    const fileStat = getFileStat(filePath);
    const contentHash = computeFileHash(filePath);
    // 文件在 preprocess 与 hash 之间发生变化（例如被 iCloud 驱逐）时跳过 state 写入，
    // 让下一轮同步根据当时的真实状态决定，而不是留个无效 hash
    if (contentHash !== null) {
      const fileState: FileSyncState = {
        file_path: relPath,
        content_hash: contentHash,
        mtime: fileStat?.mtime ?? 0,
        size: fileStat?.size ?? 0,
        last_synced: now(),
        node_ids: allNodeIds,
        segment_hashes: allHashes,
      };
      setFileState(db, fileState, sourceId);
    }

    // 更新 block 索引（按 graphRoot 隔离）
    updateBlockIndexForFile(filePath, graphRoot);

    progress.processedFiles++;
    return true;
  } catch (err) {
    log.error(`文件处理失败 (${relPath}):`, (err as Error).message);
    progress.failedFiles++;
    return false;
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
  shouldStop?: () => boolean,
): Promise<boolean> {
  return processOneFile(db, filePath, graphRoot, sourceId, shouldStop);
}

// --- 工具 ---

/**
 * 对空文件/短文件/无内容段的文件也写入 sync state，
 * 避免每次重启因 !syncState 而重复判定为"新文件"。
 */
function markFileAsProcessed(
  db: Database.Database,
  filePath: string,
  relPath: string,
  sourceId?: string,
): void {
  const fileStat = getFileStat(filePath);
  const contentHash = computeFileHash(filePath);
  if (contentHash === null) return; // dataless / missing — 不写入空 hash
  const fileState: FileSyncState = {
    file_path: relPath,
    content_hash: contentHash,
    mtime: fileStat?.mtime ?? 0,
    size: fileStat?.size ?? 0,
    last_synced: now(),
    node_ids: [],
    segment_hashes: [],
  };
  setFileState(db, fileState, sourceId);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export { resetProgress };
