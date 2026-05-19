// ============================================================
// Obsidian 处理队列
//
// 限速批量处理文件：preprocess → classify → segment → digest。
// 包含属性值提升为 tag 节点、文件夹 tag 节点链等 Obsidian 特有逻辑。
// ============================================================

import path from 'node:path';
import type Database from 'better-sqlite3';
import type { ImportProgress, QueueConfig, FileSyncState } from './types.js';
import type { ObsidianFileCategory } from './types.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('obsidian');
import { preprocessFile } from './preprocessor.js';
import { segmentContent } from './segmenter.js';
import { SqliteRepository } from '../../db/sqlite-repository.js';
import { parseCanvas } from './canvas-parser.js';
import {
  getFileState, setFileState, isFileChanged,
  computeFileHash, computeContentHash, computeSegmentHash,
} from './sync-state.js';
import { OBSIDIAN_EXCLUDED_DIRS } from './types.js';
import { digest } from '../../tools/digest.js';
import { createLink, linkExists } from '../../db/links.js';
import { supersedeNodeWithLinks, markNodeSupersededRecordOnly } from '../../db/node-lifecycle.js';
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
 * @param shouldStop - 可选中断谓词，在 batch / 并发组边界检查
 */
export async function processFileQueue(
  db: Database.Database,
  files: string[],
  vaultRoot: string,
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

    for (let j = 0; j < batch.length; j += cfg.concurrency) {
      if (shouldStop?.()) { aborted = true; break outer; }
      const concurrent = batch.slice(j, j + cfg.concurrency);
      await Promise.all(
        concurrent.map(file => processOneFile(db, file, vaultRoot, sourceId, shouldStop)),
      );
    }

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
  vaultRoot: string,
  sourceId?: string,
  shouldStop?: () => boolean,
): Promise<boolean> {
  // 返回 boolean = 文件是否产生了实质处理(已变更并已 digest/supersede)。
  // watcher 用这个决定是否写 timeline 事件,与 Logseq 的 S10 修复对齐 —
  // 单纯的 mtime 漂移 / 编辑器格式化未改内容,不应产生 obsidian_file_change 噪声。
  const repo = new SqliteRepository(db);
  const relPath = path.relative(vaultRoot, filePath).replace(/\\/g, '/');
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

    // Canvas 文件走单独管线
    if (filePath.endsWith('.canvas')) {
      await processCanvasFile(db, filePath, vaultRoot, relPath, syncState, sourceId, shouldStop);
      if (shouldStop?.()) return false;
      progress.processedFiles++;
      return true;
    }

    // 预处理
    const preprocessed = preprocessFile(filePath, vaultRoot);
    if (!preprocessed) {
      progress.skippedFiles++;
      return false;
    }

    // 避免 TOCTOU：用预处理时读到的 rawContent 计算 hash
    const contentHash = computeContentHash(preprocessed.rawContent);

    // 判断文件类型（简单启发式，完整分类在 initialization 中做）
    const category = detectCategory(filePath, preprocessed);

    // 分段
    const segments = segmentContent(preprocessed.cleanContent, category);

    if (segments.length === 0 && category !== 'empty_tag' && category !== 'metadata_only') {
      progress.skippedFiles++;
      return false;
    }

    // 记录旧版本节点 ID
    const oldNodeIds = syncState?.node_ids ?? [];

    // 空白 / 元数据文件 → tag 节点
    if (segments.length === 0 || category === 'empty_tag' || category === 'metadata_only') {
      if (shouldStop?.()) return false;
      const result = await digest(repo, {
        content: preprocessed.title,
        source: { tool: 'obsidian', files: [relPath] },
        context: `Obsidian 标签页: ${preprocessed.title}`,
        tags: [preprocessed.title],
        async: false,
        // 身份由 file relPath 负责，不走向量归并
        skipDedupMerge: true,
      });
      if (shouldStop?.()) return false;
      const nodeIds = result.created_nodes?.map(n => n.id) ?? [];
      if (nodeIds.length === 0 && oldNodeIds.length > 0) {
        log.warn(`标签页 digest 未产生新节点,保留旧同步状态: ${relPath}`);
        progress.skippedFiles++;
        return false;
      }
      // 不直接标记 is_tag，由 promoteFrequentTags 按阈值判断
      updateSyncState(db, relPath, filePath, nodeIds, sourceId, contentHash);
      progress.processedFiles++;
      return true;
    }

    // 逐段 digest(段级 dedup,与 Logseq parity):
    // 段内容 hash 未变 → 保留旧 nodeId,跳过 digest;变了或新增段才走 LLM 路径。
    // 显著减少小修改的写放大(原版每次小改都重 digest 整个文件所有段)。
    const oldHashes = syncState?.segment_hashes ?? [];
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

      const result = await digest(repo, {
        content: segment.content,
        title: preprocessed.title,
        source: { tool: 'obsidian', files: [relPath] },
        context: contextParts,
        tags: combinedTags.length > 0 ? combinedTags : undefined,
        async: false,
        // 身份由 relPath + segment 顺序负责，走 supersede 链
        skipDedupMerge: true,
      });

      if (result.created_nodes) {
        allNodeIds.push(...result.created_nodes.map(n => n.id));
      }
    }

    if (allNodeIds.length === 0) {
      // 修复 M18(2026-05-09):文件清空到只剩 frontmatter / 全空时,digest 不
      // 产生节点。原代码直接 return 而不更新 syncState,下次 isFileChanged 因
      // hash 变化又判为变更,反复进入此分支死循环。改为:
      //   - 若 oldNodeIds 存在,把它们 supersede 到第一个仍活的(无可用目标)→ 标记 superseded 但保留 audit
      //   - 更新 content_hash 让下次跳过此文件
      // 这条路径用 markNodeSupersededRecordOnly 不抢救链接(reasonable:文件清空,
      // 内容已不在,链接也无意义)。
      if (oldNodeIds.length > 0) {
        for (const oldId of oldNodeIds) {
          markNodeSupersededRecordOnly(db, oldId);
        }
        log.info(`文件清空到 0 段:${oldNodeIds.length} 个旧节点已 supersede (${relPath})`);
      } else {
        log.warn(`文件 digest 未产生新节点,且无旧节点: ${relPath}`);
      }
      // 更新 content_hash,避免下次 isFileChanged 反复触发
      updateSyncState(db, relPath, filePath, [], sourceId, contentHash);
      progress.skippedFiles++;
      // 有 supersede 实际处理过(旧节点被标记)算 changed,无旧节点的纯空文件不算。
      return oldNodeIds.length > 0;
    }

    // 多段 part_of 关系串联。必须先 linkExists 守卫:每次同步都会重新生成
     // allNodeIds(supersede 链),原版每次都创建新 part_of 链接,长期累积导致
     // 同一对节点之间叠加几十条相同 link 噪声。
    if (shouldStop?.()) return false;
    if (allNodeIds.length > 1) {
      for (let i = 1; i < allNodeIds.length; i++) {
        if (linkExists(db, allNodeIds[i], allNodeIds[i - 1], 'from_to')) continue;
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

    // 版本替代:段级 dedup 后,allNodeIds[i] === oldNodeIds[i] 时表示段未变(直接复用),
    // 此时不应再 supersede 自己到自己。只 supersede 真正变化的段 + 段数减少场景的多余旧段。
    if (shouldStop?.()) return false;
    if (oldNodeIds.length > 0 && allNodeIds.length > 0) {
      const pairs = Math.min(oldNodeIds.length, allNodeIds.length);
      for (let i = 0; i < pairs; i++) {
        // 跳过段级 dedup 命中的位置(同 ID 表示该段从旧版完整复用):
        if (oldNodeIds[i] === allNodeIds[i]) continue;
        supersedeNodeWithLinks(db, oldNodeIds[i], allNodeIds[i]);
      }
      // 多余旧段：supersede 到最后一个新节点，迁移链接、保留 updates 链
      // （段数减少场景：把多余旧段的链接归并到最后一个新段上，而不是直接 DELETE 丢失关联）
      if (oldNodeIds.length > allNodeIds.length) {
        const targetNewId = allNodeIds[allNodeIds.length - 1];
        for (let i = pairs; i < oldNodeIds.length; i++) {
          supersedeNodeWithLinks(db, oldNodeIds[i], targetNewId);
        }
      }
    }

    // 属性值提升为 tag 节点
    if (shouldStop?.()) return false;
    await promoteProps(db, preprocessed.metadata.properties, allNodeIds, 'obsidian', OBSIDIAN_SYSTEM_PROPERTIES);

    // 文件夹路径 → tag 节点链
    if (shouldStop?.()) return false;
    await createFolderTagChain(db, relPath, allNodeIds);

    // 更新同步状态(包含 segment_hashes 供下次段级 dedup 用)
    if (shouldStop?.()) return false;
    updateSyncState(db, relPath, filePath, allNodeIds, sourceId, contentHash, allHashes);

    progress.processedFiles++;
    return true;
  } catch (err) {
    log.error(`文件处理失败 (${relPath}):`, (err as Error).message);
    progress.failedFiles++;
    return false;
  }
}

/**
 * 处理 Canvas 文件
 *
 * 与 .md 路径保持一致的版本管理：
 * - 记录旧 nodeIds（来自 syncState），新一轮入库后 supersede
 * - 未能配对的旧节点直接标 is_superseded + 清理 links
 * 避免每次编辑 Canvas 都累积旧节点、重复建链。
 */
async function processCanvasFile(
  db: Database.Database,
  filePath: string,
  vaultRoot: string,
  relPath: string,
  syncState: FileSyncState | null,
  sourceId?: string,
  shouldStop?: () => boolean,
): Promise<void> {
  const repo = new SqliteRepository(db);
  if (shouldStop?.()) return;
  const parsed = parseCanvas(filePath);
  if (!parsed) return;

  // 记录旧版本节点 ID（首次导入时为空）
  const oldNodeIds = syncState?.node_ids ?? [];

  const nodeIds: string[] = [];
  // Canvas node id → brain node id（用于 edge 映射）
  const canvasNodeToBrainNode = new Map<string, string>();

  // Text 节点 → digest
  for (const textNode of parsed.textNodes) {
    if (shouldStop?.()) return;
    if (!textNode.text.trim()) continue;

    const tags = [...textNode.groupLabels];
    const result = await digest(repo, {
      content: textNode.text,
      source: { tool: 'obsidian', files: [relPath] },
      context: `Obsidian Canvas: ${path.basename(filePath, '.canvas')}`,
      tags: tags.length > 0 ? tags : undefined,
      async: false,
      // Canvas 节点身份由 canvas file + textNode.id 负责
      skipDedupMerge: true,
    });
    if (result.created_nodes?.[0]) {
      const brainNodeId = result.created_nodes[0].id;
      nodeIds.push(...result.created_nodes.map(n => n.id));
      canvasNodeToBrainNode.set(textNode.id, brainNodeId);
    }
  }

  // Link 节点 → digest（含 URL）
  for (const linkNode of parsed.linkNodes) {
    if (shouldStop?.()) return;
    const result = await digest(repo, {
      content: `外部链接: ${linkNode.url}`,
      source: { tool: 'obsidian', files: [relPath] },
      context: `Obsidian Canvas: ${path.basename(filePath, '.canvas')} | url: ${linkNode.url}`,
      async: false,
      // Canvas link 节点身份由 canvas file + linkNode.id 负责
      skipDedupMerge: true,
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

  // 版本替代：旧节点链接迁移到新节点，旧节点标记为 superseded
  if (shouldStop?.()) return;

  if (oldNodeIds.length > 0 && nodeIds.length > 0) {
    const pairs = Math.min(oldNodeIds.length, nodeIds.length);
    for (let i = 0; i < pairs; i++) {
      supersedeNodeWithLinks(db, oldNodeIds[i], nodeIds[i]);
    }
    // 多余旧段：supersede 到最后一个新节点，迁移链接、保留 updates 链
    if (oldNodeIds.length > nodeIds.length) {
      const targetNewId = nodeIds[nodeIds.length - 1];
      for (let i = pairs; i < oldNodeIds.length; i++) {
        supersedeNodeWithLinks(db, oldNodeIds[i], targetNewId);
      }
    }
  }

  if (nodeIds.length === 0 && oldNodeIds.length > 0) {
    log.warn(`Canvas digest 未产生新节点,保留旧同步状态: ${relPath}`);
    return;
  }

  if (!shouldStop?.()) updateSyncState(db, relPath, filePath, nodeIds, sourceId);
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
  contentHash?: string,
  segmentHashes?: string[],
): void {
  let mtime = 0;
  let size = 0;
  try {
    const stat = fs.statSync(filePath);
    mtime = Math.floor(stat.mtimeMs);
    size = stat.size;
  } catch {
    // File may have become dataless or disappeared between scan and state write.
  }

  // 优先使用调用方已持有的 content hash（来自预处理 snapshot），避免 TOCTOU：
  // 若不提供则退回到重新读文件计算；computeFileHash 在文件 dataless/missing 时返回 null。
  const hash = contentHash ?? computeFileHash(filePath);
  if (hash === null) return; // dataless / missing — 不写入空 hash
  setFileState(db, {
    file_path: relPath,
    content_hash: hash,
    mtime,
    size,
    last_synced: now(),
    node_ids: nodeIds,
    segment_hashes: segmentHashes ?? [],
  }, sourceId);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 处理单个文件变更（watcher 调用）。返回 true 表示文件实际被处理过(产生节点变化),
 * watcher 据此决定是否写 timeline 事件。与 Logseq 的 S10 修复对齐,避免 mtime 漂移
 * (git pull / Dropbox 同步 / 编辑器格式化保存) 触发空噪声事件。
 */
export async function processFileChange(
  db: Database.Database,
  filePath: string,
  vaultRoot: string,
  sourceId?: string,
  shouldStop?: () => boolean,
): Promise<boolean> {
  return processOneFile(db, filePath, vaultRoot, sourceId, shouldStop);
}
