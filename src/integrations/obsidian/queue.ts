// ============================================================
// Obsidian 处理队列
//
// 限速批量处理文件：preprocess → classify → segment → digest。
// 包含属性值提升为 tag 节点、文件夹 tag 节点链等 Obsidian 特有逻辑。
// ============================================================

import path from 'node:path';
import type Database from 'better-sqlite3';
import type { ImportProgress, QueueConfig, FileSyncState } from './types.js';
import type { ObsidianVaultConfig, ObsidianFileCategory } from './types.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('obsidian');
import { preprocessFile } from './preprocessor.js';
import { segmentContent } from './segmenter.js';
import { parseCanvas } from './canvas-parser.js';
import { readVaultConfig, getExcludedDirs } from './vault-config.js';
import {
  getFileState, setFileState, isFileChanged,
  computeFileHash,
} from './sync-state.js';
import { OBSIDIAN_EXCLUDED_DIRS } from './types.js';
import { digest } from '../../tools/digest.js';
import { updateNode, getNode } from '../../db/nodes.js';
import { createLink, linkExists } from '../../db/links.js';
import { supersedeNode } from '../shared/version.js';
import { now } from '../../utils/time.js';
import { promotePropertyValues as promoteProps, getOrCreateTagNode } from '../shared/property-promote.js';
import { OBSIDIAN_SYSTEM_PROPERTIES } from './types.js';
import fs from 'node:fs';

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

export function resetProgress(sourceId?: string): void {
  const key = sourceId ?? DEFAULT_SOURCE;
  progressMap.set(key, { ...DEFAULT_PROGRESS });
}

// --- 核心处理 ---

/**
 * 批量处理文件列表
 *
 * @param db - 数据库
 * @param files - 待处理的文件绝对路径列表
 * @param vaultRoot - Obsidian vault 根目录
 * @param config - 队列配置
 * @param sourceId - 笔记源 ID（多实例支持）
 */
export async function processFileQueue(
  db: Database.Database,
  files: string[],
  vaultRoot: string,
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

    for (let j = 0; j < batch.length; j += cfg.concurrency) {
      const concurrent = batch.slice(j, j + cfg.concurrency);
      await Promise.all(
        concurrent.map(file => processOneFile(db, file, vaultRoot, sourceId)),
      );
    }

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
  vaultRoot: string,
  sourceId?: string,
): Promise<void> {
  const relPath = path.relative(vaultRoot, filePath).replace(/\\/g, '/');
  const progress = getProgress(sourceId);
  progress.currentFile = relPath;

  try {
    // 检查同步状态
    const syncState = getFileState(db, relPath, sourceId);
    if (!isFileChanged(filePath, syncState)) {
      progress.skippedFiles++;
      return;
    }

    // Canvas 文件走单独管线
    if (filePath.endsWith('.canvas')) {
      await processCanvasFile(db, filePath, vaultRoot, relPath, syncState, sourceId);
      progress.processedFiles++;
      return;
    }

    // 预处理
    const preprocessed = preprocessFile(filePath, vaultRoot);
    if (!preprocessed) {
      progress.skippedFiles++;
      return;
    }

    // 判断文件类型（简单启发式，完整分类在 initialization 中做）
    const category = detectCategory(filePath, preprocessed);

    // 分段
    const segments = segmentContent(preprocessed.cleanContent, category);

    if (segments.length === 0 && category !== 'empty_tag' && category !== 'metadata_only') {
      progress.skippedFiles++;
      return;
    }

    // 记录旧版本节点 ID
    const oldNodeIds = syncState?.node_ids ?? [];

    // 空白 / 元数据文件 → tag 节点
    if (segments.length === 0 || category === 'empty_tag' || category === 'metadata_only') {
      const result = await digest(db, {
        title: preprocessed.title,
        content: '',
        source: { tool: 'obsidian', files: [relPath] },
        context: `Obsidian 标签页: ${preprocessed.title}`,
        tags: [preprocessed.title],
        async: false,
      });
      const nodeIds = result.created_nodes?.map(n => n.id) ?? [];
      for (const id of nodeIds) {
        updateNode(db, id, { is_tag: 1 });
      }
      updateSyncState(db, relPath, filePath, nodeIds, sourceId);
      progress.processedFiles++;
      return;
    }

    // 逐段 digest
    const allNodeIds: string[] = [];

    for (const segment of segments) {
      const propEntries = Object.entries(preprocessed.metadata.properties);
      const propsStr = propEntries.length > 0
        ? propEntries.slice(0, 10).map(([k, v]) => `${k}: ${v}`).join(', ')
        : '';

      const contextParts = [
        `Obsidian: ${preprocessed.title}`,
        segment.context !== preprocessed.title ? segment.context : '',
        preprocessed.metadata.tags.length > 0
          ? `标签: ${preprocessed.metadata.tags.join(', ')}`
          : '',
        propsStr ? `属性: ${propsStr}` : '',
        preprocessed.metadata.pageRefs.length > 0
          ? `关联页面: ${preprocessed.metadata.pageRefs.slice(0, 5).join(', ')}`
          : '',
      ].filter(Boolean).join(' | ');

      const combinedTags = [
        ...new Set([
          ...preprocessed.metadata.tags,
          ...preprocessed.metadata.pageRefs,
        ]),
      ];

      const result = await digest(db, {
        content: segment.content,
        title: preprocessed.title,
        source: { tool: 'obsidian', files: [relPath] },
        context: contextParts,
        tags: combinedTags.length > 0 ? combinedTags : undefined,
        async: false,
      });

      if (result.created_nodes) {
        allNodeIds.push(...result.created_nodes.map(n => n.id));
      }
    }

    // 多段 part_of 关系串联
    if (allNodeIds.length > 1) {
      for (let i = 1; i < allNodeIds.length; i++) {
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

    // 版本替代：旧节点链接迁移到新节点，旧节点标记为 superseded
    if (oldNodeIds.length > 0 && allNodeIds.length > 0) {
      const pairs = Math.min(oldNodeIds.length, allNodeIds.length);
      for (let i = 0; i < pairs; i++) {
        supersedeNode(db, oldNodeIds[i], allNodeIds[i]);
      }
      for (let i = pairs; i < oldNodeIds.length; i++) {
        db.prepare('UPDATE nodes SET is_superseded = 1, heat = 0.01 WHERE id = ?').run(oldNodeIds[i]);
        db.prepare('DELETE FROM links WHERE from_id = ? OR to_id = ?').run(oldNodeIds[i], oldNodeIds[i]);
      }
    }

    // 属性值提升为 tag 节点
    await promoteProps(db, preprocessed.metadata.properties, allNodeIds, 'obsidian', OBSIDIAN_SYSTEM_PROPERTIES);

    // 文件夹路径 → tag 节点链
    await createFolderTagChain(db, relPath, allNodeIds);

    // 更新同步状态
    updateSyncState(db, relPath, filePath, allNodeIds, sourceId);

    progress.processedFiles++;
  } catch (err) {
    log.error(`文件处理失败 (${relPath}):`, (err as Error).message);
    progress.failedFiles++;
  }
}

/**
 * 处理 Canvas 文件
 */
async function processCanvasFile(
  db: Database.Database,
  filePath: string,
  vaultRoot: string,
  relPath: string,
  syncState: FileSyncState | null,
  sourceId?: string,
): Promise<void> {
  const parsed = parseCanvas(filePath);
  if (!parsed) return;

  const nodeIds: string[] = [];
  // Canvas node id → brain node id（用于 edge 映射）
  const canvasNodeToBrainNode = new Map<string, string>();

  // Text 节点 → digest
  for (const textNode of parsed.textNodes) {
    if (!textNode.text.trim()) continue;

    const tags = [...textNode.groupLabels];
    const result = await digest(db, {
      content: textNode.text,
      source: { tool: 'obsidian', files: [relPath] },
      context: `Obsidian Canvas: ${path.basename(filePath, '.canvas')}`,
      tags: tags.length > 0 ? tags : undefined,
      async: false,
    });
    if (result.created_nodes?.[0]) {
      const brainNodeId = result.created_nodes[0].id;
      nodeIds.push(...result.created_nodes.map(n => n.id));
      canvasNodeToBrainNode.set(textNode.id, brainNodeId);
    }
  }

  // Link 节点 → digest（含 URL）
  for (const linkNode of parsed.linkNodes) {
    const result = await digest(db, {
      content: `外部链接: ${linkNode.url}`,
      source: { tool: 'obsidian', files: [relPath] },
      context: `Obsidian Canvas: ${path.basename(filePath, '.canvas')} | url: ${linkNode.url}`,
      async: false,
    });
    if (result.created_nodes) {
      nodeIds.push(...result.created_nodes.map(n => n.id));
    }
  }

  // Edge → BrainLink（Canvas 内节点间的连接）
  // 注意：这里只处理 text↔text 的连接，file 节点的连接需要在初始化阶段处理
  for (const edge of parsed.edges) {
    const fromNodeId = canvasNodeToBrainNode.get(edge.fromId);
    const toNodeId = canvasNodeToBrainNode.get(edge.toId);
    if (!fromNodeId || !toNodeId) continue;
    if (fromNodeId === toNodeId) continue;
    if (linkExists(db, fromNodeId, toNodeId)) continue;

    createLink(db, {
      from_id: fromNodeId,
      to_id: toNodeId,
      relation: [{ type: 'tagged', confidence: edge.confidence }],
      strength: 0.9,
      note: edge.label ? `Canvas: ${edge.label}` : 'Canvas 连接',
      auto: true,
      status: 'pending',
    });
  }

  updateSyncState(db, relPath, filePath, nodeIds, sourceId);
}

/**
 * 文件夹路径 → tag 节点链
 *
 * References/Books/xxx.md →
 *   tag "References" ──part_of──→ tag "Books" ──tagged──→ content node
 */
async function createFolderTagChain(
  db: Database.Database,
  relPath: string,
  nodeIds: string[],
): Promise<void> {
  if (nodeIds.length === 0) return;

  const parts = path.dirname(relPath).split('/').filter(p => p !== '.');
  if (parts.length === 0) return;

  // 跳过排除目录
  const excludeSet = new Set(OBSIDIAN_EXCLUDED_DIRS);
  const filteredParts = parts.filter(p => !excludeSet.has(p));
  if (filteredParts.length === 0) return;

  // 创建 tag 节点链
  let prevTagNodeId: string | null = null;

  for (const folderName of filteredParts) {
    try {
      const tagNodeId = await getOrCreateTagNode(db, folderName, 'obsidian');

      // 层级间 part_of 连接
      if (prevTagNodeId && prevTagNodeId !== tagNodeId) {
        if (!linkExists(db, tagNodeId, prevTagNodeId)) {
          createLink(db, {
            from_id: tagNodeId,
            to_id: prevTagNodeId,
            relation: [{ type: 'part_of', confidence: 0.9 }],
            strength: 0.8,
            note: `Obsidian 文件夹层级`,
            auto: true,
            status: 'confirmed',
          });
        }
      }

      prevTagNodeId = tagNodeId;
    } catch (err) {
      log.debug(`文件夹 tag 创建失败 ${folderName}: ${(err as Error).message}`);
    }
  }

  // 最近一级 tag 节点 → 内容节点
  if (prevTagNodeId && prevTagNodeId !== nodeIds[0]) {
    if (!linkExists(db, nodeIds[0], prevTagNodeId)) {
      createLink(db, {
        from_id: nodeIds[0],
        to_id: prevTagNodeId,
        relation: [{ type: 'tagged', confidence: 0.7 }],
        strength: 0.7,
        note: 'Obsidian 文件夹分类',
        auto: true,
        status: 'confirmed',
      });
    }
  }
}

/**
 * 简单文件类型检测（增量同步用，完整分类在初始化阶段）
 */
function detectCategory(filePath: string, preprocessed: { cleanContent: string; metadata: { properties: Record<string, string> } }): ObsidianFileCategory {
  if (filePath.endsWith('.excalidraw.md')) return 'excalidraw';
  if (preprocessed.cleanContent.trim().length === 0) {
    return Object.keys(preprocessed.metadata.properties).length > 0 ? 'metadata_only' : 'empty_tag';
  }
  return 'regular';
}

// --- 工具 ---

function updateSyncState(
  db: Database.Database,
  relPath: string,
  filePath: string,
  nodeIds: string[],
  sourceId?: string,
): void {
  let mtime = 0;
  let size = 0;
  try {
    const stat = fs.statSync(filePath);
    mtime = Math.floor(stat.mtimeMs);
    size = stat.size;
  } catch {}

  setFileState(db, {
    file_path: relPath,
    content_hash: computeFileHash(filePath),
    mtime,
    size,
    last_synced: now(),
    node_ids: nodeIds,
  }, sourceId);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 处理单个文件变更（watcher 调用）
 */
export async function processFileChange(
  db: Database.Database,
  filePath: string,
  vaultRoot: string,
  sourceId?: string,
): Promise<void> {
  await processOneFile(db, filePath, vaultRoot, sourceId);
}
