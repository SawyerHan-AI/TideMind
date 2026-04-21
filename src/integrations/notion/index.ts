// ============================================================
// Notion 集成 — 生命周期管理
//
// 与 Obsidian/Logseq 不同，Notion 是云端 API 驱动的轮询模式，
// 不使用 fs.watch。
// ============================================================

import type Database from 'better-sqlite3';
import { createLogger } from '../../utils/logger.js';
import { clearTagNodeCache } from '../shared/property-promote.js';
import { listAllPages, getPageProperties, validateToken } from './api-client.js';
import { getAllPageStates, removePageState, hasCompletedFullScan, markFullScanCompleted } from './sync-state.js';
import { processNotionPages, resetProgress } from './queue.js';
import { isNotionInitializing } from './initialization.js';
import type { NotionPageSummary } from './types.js';

const log = createLogger('notion');

// ── 轮询管理 ──────────────────────────────────────────────────

const pollingTimers = new Map<string, ReturnType<typeof setInterval>>();
const syncCounters = new Map<string, number>(); // 用于周期性删除检测
const syncingSources = new Set<string>(); // 并发防护

/** 供 initialization.ts 通过动态 import 做互斥检查(避免循环静态依赖)。 */
export function isNotionSyncing(sourceId: string): boolean {
  return syncingSources.has(sourceId);
}

// ── 公开 API ──────────────────────────────────────────────────

/**
 * 启动 Notion 笔记源
 */
export async function startNotionSource(
  db: Database.Database,
  sourceId: string,
  path: string,
  pollInterval?: number,
): Promise<void> {
  const token = extractToken(path);
  if (!token) {
    log.error(`无效的 Notion 配置: path 不包含 token`);
    return;
  }

  // 验证 token。validateToken 在网络错误时会 throw,不代表 token 无效 —
  // 启动路径不阻塞:先启动轮询,首次同步自己会再试。只有明确 401 才终止。
  try {
    const validation = await validateToken(token);
    if (!validation.valid) {
      log.error(`Notion token 验证失败(401),sourceId: ${sourceId}`);
      return;
    }
  } catch (err) {
    log.warn(`Notion token 瞬时验证失败,稍后首轮扫描会再试: ${(err as Error).message}`);
    // 继续启动 — 不能因网络抖动阻塞用户集成
  }

  log.info(`启动 Notion 笔记源: ${sourceId}`);

  // 首次全量同步
  const isFirstRun = !hasCompletedFullScan(db, sourceId);
  if (isFirstRun) {
    // 若外部触发的 runInitialization 正在跑(首次引导),不要叠加 runSync:
    // 两者都会对同一 sourceId 写入 nodes,并发会产生重复节点。
    if (isNotionInitializing(sourceId)) {
      log.info(`首次运行,但 runInitialization 已在进行,跳过 runSync: ${sourceId}`);
    } else {
      log.info('首次运行，执行全量同步...');
      // 异步执行，不阻塞启动
      runSync(db, token, sourceId).catch(err =>
        log.error(`全量同步失败: ${err.message}`),
      );
    }
  }

  // 启动轮询
  const intervalMs = ((pollInterval ?? 300) * 1000);
  const timer = setInterval(async () => {
    try {
      await runIncrementalSync(db, token, sourceId);
    } catch (err) {
      log.error(`增量同步失败: ${(err as Error).message}`);
    }
  }, intervalMs);

  pollingTimers.set(sourceId, timer);
  syncCounters.set(sourceId, 0);
  log.info(`轮询已启动，间隔: ${pollInterval ?? 300}s`);
}

/**
 * 停止 Notion 笔记源
 */
export function stopNotionSource(sourceId: string): void {
  const timer = pollingTimers.get(sourceId);
  if (timer) {
    clearInterval(timer);
    pollingTimers.delete(sourceId);
  }
  syncCounters.delete(sourceId);
  log.info(`Notion 笔记源已停止: ${sourceId}`);
}

/**
 * 停止所有 Notion 集成（进程退出时调用）
 */
export function stopNotionIntegration(): void {
  for (const [sourceId] of pollingTimers) {
    stopNotionSource(sourceId);
  }
}

/**
 * 触发全量重扫
 */
export async function triggerFullRescan(
  db: Database.Database,
  sourceId: string,
  path: string,
): Promise<void> {
  const token = extractToken(path);
  if (!token) return;

  resetProgress(sourceId);
  await runSync(db, token, sourceId);
}

/**
 * 获取导入进度
 */
export { getImportProgress } from './queue.js';

// ── 全量同步 ──────────────────────────────────────────────────

async function runSync(
  db: Database.Database,
  token: string,
  sourceId: string,
): Promise<void> {
  if (syncingSources.has(sourceId)) {
    log.info(`全量同步已在进行中，跳过: ${sourceId}`);
    return;
  }
  if (isNotionInitializing(sourceId)) {
    log.info(`runInitialization 正在进行,跳过 runSync: ${sourceId}`);
    return;
  }
  syncingSources.add(sourceId);
  try {
    await runSyncInner(db, token, sourceId);
  } finally {
    syncingSources.delete(sourceId);
  }
}

async function runSyncInner(
  db: Database.Database,
  token: string,
  sourceId: string,
): Promise<void> {
  clearTagNodeCache();

  log.info('开始全量同步...');

  // 1. 扫描所有页面
  const allPages: NotionPageSummary[] = [];
  for await (const page of listAllPages(token)) {
    if (page.inTrash) continue;
    allPages.push(page);
  }

  log.info(`发现 ${allPages.length} 个页面`);

  // 2. 过滤已同步且未变更的页面
  const syncStates = getAllPageStates(db, sourceId);
  const pagesToProcess: NotionPageSummary[] = [];

  for (const page of allPages) {
    const prevState = syncStates.get(page.id);
    if (prevState && prevState.last_edited_time === page.lastEditedTime) {
      continue; // 快速路径：last_edited_time 未变
    }
    pagesToProcess.push(page);
  }

  log.info(`${pagesToProcess.length} 个页面需要处理（${allPages.length - pagesToProcess.length} 个跳过）`);

  // 3. 处理变更页面
  if (pagesToProcess.length > 0) {
    await processNotionPages(db, token, pagesToProcess, sourceId);
  }

  // 4. 清理已删除/取消共享的页面
  const currentPageIds = new Set(allPages.map(p => p.id));
  const stalePageIds: string[] = [];
  for (const [pageId] of syncStates) {
    if (!currentPageIds.has(pageId)) {
      stalePageIds.push(pageId);
    }
  }

  if (stalePageIds.length > 0) {
    log.info(`清理 ${stalePageIds.length} 个已删除/取消共享的页面`);
    for (const pageId of stalePageIds) {
      const state = syncStates.get(pageId)!;
      // Archive 关联节点
      for (const nodeId of state.node_ids) {
        db.prepare('UPDATE nodes SET archived = 1, heat = 0.01 WHERE id = ?').run(nodeId);
      }
      removePageState(db, pageId, sourceId);
    }
  }

  // 5. 标记全量同步完成
  markFullScanCompleted(db, sourceId);
  log.info('全量同步完成');
}

// ── 增量同步 ──────────────────────────────────────────────────

async function runIncrementalSync(
  db: Database.Database,
  token: string,
  sourceId: string,
): Promise<void> {
  if (syncingSources.has(sourceId)) {
    log.debug(`增量同步已在进行中，跳过: ${sourceId}`);
    return;
  }
  if (isNotionInitializing(sourceId)) {
    log.debug(`runInitialization 正在进行,跳过增量同步: ${sourceId}`);
    return;
  }
  syncingSources.add(sourceId);
  try {
    await runIncrementalSyncInner(db, token, sourceId);
  } finally {
    syncingSources.delete(sourceId);
  }
}

async function runIncrementalSyncInner(
  db: Database.Database,
  token: string,
  sourceId: string,
): Promise<void> {
  // 获取上次同步时间
  const source = db.prepare('SELECT last_synced FROM note_sources WHERE id = ?').get(sourceId) as { last_synced: string | null } | undefined;
  const lastSynced = source?.last_synced ?? '1970-01-01T00:00:00.000Z';

  // **在开始扫描前**记录 scanStartedAt,用作下次的 last_synced。
  //
  // 老代码在 processNotionPages 完成后才 `new Date().toISOString()`,处理
  // 期间(可能 2 分钟+)被编辑的页面 lastEditedTime < 这个时间 → 下轮
  // `page.lastEditedTime > lastSynced` 判不中,要等用户再次编辑才会被
  // 同步。用 scanStartedAt 可保证不漏:所有被跳过的页面都不会晚于扫描起点。
  const scanStartedAt = new Date().toISOString();

  // 搜索最近变更的页面
  // 注意：Search API 排序不保证严格有序，不能用 break 提前终止
  // 遍历所有结果，过滤出 lastEditedTime > lastSynced 的页面
  const changedPages: NotionPageSummary[] = [];
  for await (const page of listAllPages(token)) {
    if (page.inTrash) continue;
    if (page.lastEditedTime > lastSynced) {
      changedPages.push(page);
    }
  }

  if (changedPages.length === 0) {
    // 即便没有变更,也推进 last_synced 到 scanStartedAt,下次查询范围收窄,
    // 避免每次都拿历史所有页面做比较
    db.prepare('UPDATE note_sources SET last_synced = ? WHERE id = ?')
      .run(scanStartedAt, sourceId);

    // 周期性删除检测
    const counter = (syncCounters.get(sourceId) ?? 0) + 1;
    syncCounters.set(sourceId, counter);
    if (counter % 10 === 0) {
      await detectDeletedPages(db, token, sourceId);
    }
    return;
  }

  log.info(`增量同步: ${changedPages.length} 个页面变更`);
  await processNotionPages(db, token, changedPages, sourceId);

  // 用扫描开始时间作为 last_synced,下次不漏处理期间被编辑的页面
  db.prepare('UPDATE note_sources SET last_synced = ? WHERE id = ?')
    .run(scanStartedAt, sourceId);
}

// ── 删除检测 ──────────────────────────────────────────────────

async function detectDeletedPages(
  db: Database.Database,
  token: string,
  sourceId: string,
): Promise<void> {
  log.debug('执行周期性删除检测...');

  const syncStates = getAllPageStates(db, sourceId);
  const currentPageIds = new Set<string>();

  for await (const page of listAllPages(token)) {
    currentPageIds.add(page.id);
  }

  let deletedCount = 0;
  for (const [pageId, state] of syncStates) {
    if (!currentPageIds.has(pageId)) {
      // 确认：尝试直接获取该页面
      try {
        await getPageProperties(token, pageId);
        // 页面仍然可访问，只是 Search 索引延迟
      } catch {
        // 404/403 → 确认已删除/取消共享
        for (const nodeId of state.node_ids) {
          db.prepare('UPDATE nodes SET archived = 1, heat = 0.01 WHERE id = ?').run(nodeId);
        }
        removePageState(db, pageId, sourceId);
        deletedCount++;
      }
    }
  }

  if (deletedCount > 0) {
    log.info(`删除检测: 清理了 ${deletedCount} 个页面`);
  }
}

// ── 辅助 ──────────────────────────────────────────────────────

function extractToken(path: string): string | null {
  // 格式: notion://<token>
  if (path.startsWith('notion://')) {
    return path.slice('notion://'.length);
  }
  // 直接传 token 的兼容模式
  if (path.startsWith('ntn_') || path.startsWith('secret_')) {
    return path;
  }
  return null;
}
