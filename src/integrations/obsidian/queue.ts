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
  computeFileHash, computeContentHash, computeSegmentHash, getFileStat,
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

  // 本轮新建（非复用旧 ID）的节点。声明在 try 外，让 catch 能据此清理已建节点。
  const createdThisRun: string[] = [];

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
      const canvasChanged = await processCanvasFile(db, filePath, vaultRoot, relPath, syncState, sourceId, shouldStop);
      if (shouldStop?.()) return false;
      // 仅当实际产生处理（产出/supersede 节点）才计入 processed 并允许写 timeline，
      // 与 .md 路径对齐——清空/空转的 canvas 不再每次 trigger 写噪声事件。
      if (canvasChanged) progress.processedFiles++;
      else progress.skippedFiles++;
      return canvasChanged;
    }

    // 避免 TOCTOU：在预处理（读内容）的同一时刻抓 stat 作为本轮 snapshot。
    // digest 期间（LLM 调用，可达分钟级）用户若编辑文件,写回 sync state 的
    // content_hash + mtime + size 必须都来自被 digest 的那份内容,否则:
    //   - 用 digest 后重读的新 hash → 下轮 isFileChanged 判未变更,编辑永久丢失;
    //   - 用 digest 后重读的新 mtime/size → isFileChanged 的 mtime+size 快速路径
    //     直接短路,hash 比对都走不到,同样丢失编辑。
    // 与 Logseq 对齐(logseq/queue.ts 同款 snapshotStat)。
    const entrySnapshotStat = getFileStat(filePath);

    // 预处理
    const preprocessed = preprocessFile(filePath, vaultRoot);
    if (!preprocessed) {
      progress.skippedFiles++;
      return false;
    }

    // read-time snapshot:入口 getFileStat 抓到 dataless 返回 null,但 preprocessFile 随后
    // 成功(文件在 stat 与 read 之间被 iCloud 下载)→ 文件此刻可读,在 digest 前(此刻仍是被
    // digest 那份内容)补抓一次 stat,与下面用 rawContent 算的 hash 同源。绝不在 digest 后补抓。
    const snapshotStat = entrySnapshotStat ?? getFileStat(filePath);

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
      updateSyncState(db, relPath, filePath, nodeIds, sourceId, contentHash, undefined, snapshotStat);
      progress.processedFiles++;
      return true;
    }

    // 逐段 digest(段级 dedup,与 Logseq parity):
    // 段内容 hash 未变 → 保留旧 nodeId,跳过 digest;变了或新增段才走 LLM 路径。
    // 显著减少小修改的写放大(原版每次小改都重 digest 整个文件所有段)。
    const oldHashes = syncState?.segment_hashes ?? [];
    const allNodeIds: string[] = [];
    const allHashes: string[] = [];
    // createdThisRun（声明在 try 外）：本轮新建的节点 ID。若中途某段抛错
    // （SQLITE_BUSY / 磁盘错误 / shutdown closeDb），catch 里据此清理已建节点，避免：
    //   (a) 这些节点不在任何 sync state 里 → 永远不被 supersede（孤儿，且带向量持续被 recall）；
    //   (b) 下次重跑因 isFileChanged 仍为 true 重新 digest 同一段 → 产生重复活跃节点。

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
        const newIds = result.created_nodes.map(n => n.id);
        allNodeIds.push(...newIds);
        createdThisRun.push(...newIds);
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
      updateSyncState(db, relPath, filePath, [], sourceId, contentHash, undefined, snapshotStat);
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
    updateSyncState(db, relPath, filePath, allNodeIds, sourceId, contentHash, allHashes, snapshotStat);

    progress.processedFiles++;
    return true;
  } catch (err) {
    log.error(`文件处理失败 (${relPath}):`, (err as Error).message);
    // 段级 digest 部分失败补偿：本轮已建节点 + 旧节点都未被 supersede，sync state
    // 也未更新。这些新建节点不在任何 sync state 里，永不会被后续 supersede（孤儿），
    // 且下次重跑会重复 digest 同段产生重复活跃节点。这里把它们标记 superseded
    //（heat=0.01 + is_superseded=1，recall 与向量搜索都会过滤掉，与 M18 空文件路径
    // 用同一原语），旧节点仍是活跃版本、recall 一致；下次重跑从干净状态重建。
    // closeDb 导致的 'database is not open' 等场景清理也可能失败，故整体 try 兜底。
    if (createdThisRun.length > 0) {
      try {
        for (const id of createdThisRun) {
          markNodeSupersededRecordOnly(db, id);
        }
        log.warn(`部分失败回滚:已标记本轮新建的 ${createdThisRun.length} 个节点为 superseded (${relPath})`);
      } catch (cleanupErr) {
        log.error(`部分失败回滚清理也失败 (${relPath}):`, (cleanupErr as Error).message);
      }
    }
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
): Promise<boolean> {
  // 返回 boolean = 是否产生了实质处理（产出/supersede 了节点）。供 processOneFile
  // 决定是否写 timeline 事件，与 .md 路径对齐——避免空转 canvas 反复写噪声事件。
  const repo = new SqliteRepository(db);
  if (shouldStop?.()) return false;

  // 避免 TOCTOU：在 parse(读内容)的同一时刻抓 stat 作为本轮 snapshot。canvas digest
  // 对每个 text/link 节点逐个 await(可达分钟级),期间用户若编辑 .canvas,写回 sync state
  // 的 content_hash + mtime + size 必须都来自被 digest 的那份内容,否则下次 isFileChanged
  // 的 mtime+size 快速路径会短路 / 用新 hash 判未变更,这次编辑永久丢失。与 .md 路径
  //(processOneFile)及 Logseq 对齐。
  const entrySnapshotStat = getFileStat(filePath);

  const parsed = parseCanvas(filePath);
  if (!parsed) {
    // 解析失败（JSON.parse 抛错 / 缺 nodes 数组）≠ 用户清空 canvas。最常见成因是
    // Obsidian 非原子保存的半截写、Obsidian Sync / iCloud 冲突损坏文件——内容仍在，
    // 只是这一瞬读到的是坏文件。此处绝不能 supersede 旧节点：markNodeSupersededRecordOnly
    // 不迁移链接，下次成功解析又建全新 ID，旧节点 + 入边会被永久遗弃 = 一次瞬时
    // 解析失败抹掉用户手绘 canvas 记忆。
    //
    // 只为断死循环更新 content_hash（不更新 node_ids，旧节点原样保留）：否则下次
    // isFileChanged 因 hash 仍是旧值反复判为变更、每次都重 parse + log 空转。
    // 与 .md 路径对齐——.md 读/预处理失败时(queue.ts:182)同样只跳过、不 supersede；
    // 真·清空(parse 成功但 0 节点)走下方 nodeIds.length===0 分支才 supersede。
    if (!shouldStop?.()) {
      const oldNodeIds = syncState?.node_ids ?? [];
      updateSyncState(db, relPath, filePath, oldNodeIds, sourceId);
    }
    return false;
  }

  // 记录旧版本节点 ID（首次导入时为空）
  const oldNodeIds = syncState?.node_ids ?? [];

  // read-time snapshot:入口 stat 为 null 但 parseCanvas 随后成功 ⇒ 文件此刻可读,在 digest
  // 前补抓 stat,与下面用 rawContent 算的 hash 同源。绝不在 digest 后补抓。
  const snapshotStat = entrySnapshotStat ?? getFileStat(filePath);

  // 避免 TOCTOU：用 parse 时刻读到的 rawContent 算 hash,而不是 digest 后重读盘。
  const contentHash = computeContentHash(parsed.rawContent);

  const nodeIds: string[] = [];
  // Canvas node id → brain node id（用于 edge 映射）
  const canvasNodeToBrainNode = new Map<string, string>();

  // Text 节点 → digest
  for (const textNode of parsed.textNodes) {
    if (shouldStop?.()) return false;
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
    if (shouldStop?.()) return false;
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
  if (shouldStop?.()) return false;

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
    // 修复 canvas 死循环（对齐 .md M18，queue.ts:282-303）：canvas 被清空
    // （内容删光 / 所有 text 节点变空）后 digest 不产节点。原代码直接 return 而
    // 不 supersede 旧节点、不更新 sync state，下次 isFileChanged 因 hash 变化又判
    // 为变更，每次同步/watcher 事件都重 parse + log，旧节点也一直保持活跃。
    // 改为：旧节点逐个 markNodeSupersededRecordOnly（文件清空，链接已无意义，不抢救），
    // 再写入空 node_ids + 当前 hash，让下次跳过此文件。
    for (const oldId of oldNodeIds) {
      markNodeSupersededRecordOnly(db, oldId);
    }
    log.info(`Canvas 清空到 0 节点:${oldNodeIds.length} 个旧节点已 supersede (${relPath})`);
    if (!shouldStop?.()) updateSyncState(db, relPath, filePath, [], sourceId, contentHash, undefined, snapshotStat);
    return true;
  }

  if (!shouldStop?.()) updateSyncState(db, relPath, filePath, nodeIds, sourceId, contentHash, undefined, snapshotStat);
  // 产出了新节点 → 实质处理；纯空 canvas 且无旧节点 → 无实质处理
  return nodeIds.length > 0;
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
  snapshotStat?: { mtime: number; size: number } | null,
): void {
  // snapshotStat 三态语义(与 4 条路径一致):调用方已在「内容读取成功那一刻、digest 前」
  // 把有效 snapshot 捕获/补抓好传进来,这里不再重抓(digest 后重抓会拿到编辑后的 mtime/size
  // 配 digest 前的 hash,下轮 isFileChanged 快速路径短路丢编辑)。
  let mtime = 0;
  let size = 0;
  if (snapshotStat) {
    // 有 read-time snapshot:mtime/size 与 contentHash 同源(都反映被 digest 那份内容)。
    mtime = snapshotStat.mtime;
    size = snapshotStat.size;
  } else if (snapshotStat === null && contentHash === undefined) {
    // null 且无 contentHash = 内容根本没读到(dataless / 消失,本就没 digest)。整条跳过。
    return;
  } else if (snapshotStat === null) {
    // null 但有 contentHash = 极罕见:内容读成功却连 read-time 补抓 stat 都失败。用 mtime=0/
    // size=0 + 已算出的 hash——0/0 永不等于真实值,强制下轮走 hash 比对(既不丢编辑也无孤儿)。
    mtime = 0;
    size = 0;
  } else {
    // 未传(undefined,旧调用点) → 退回重读盘(保持旧行为)。
    try {
      const stat = fs.statSync(filePath);
      mtime = Math.floor(stat.mtimeMs);
      size = stat.size;
    } catch {
      // File may have become dataless or disappeared between scan and state write.
    }
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
