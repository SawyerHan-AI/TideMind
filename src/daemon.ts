#!/usr/bin/env node
/**
 * 外脑心跳守护进程
 *
 * 独立于 MCP Server 运行，负责调度所有代谢任务。
 * 每分钟 tick 一次，每个任务独立判断是否到期执行。
 *
 * 通过 WAL 模式 + busy_timeout 安全地与 MCP Server 共享 SQLite 数据库。
 */

import { loadConfig, getConfig, ensureDataDirs, backfillSyncHashes, syncStrategiesFromSource } from './config.js';
import { checkFileWatchers, reloadStrategies } from './strategy/loader.js';
import { getDb, closeDb, initVec } from './db/connection.js';
import { createLogger } from './utils/logger.js';
import { logTimelineEvent } from './db/log.js';
import { runSchedulerTick } from './metabolism/scheduler.js';
import { ALL_TASKS } from './metabolism/tasks.js';
import { migrateDataDirIfNeeded } from './utils/migrate-data-dir.js';
import { migrateConfigIfNeeded } from './utils/config-migrate.js';

const log = createLogger('daemon');
const migrationLog = createLogger('migrate');
import { startAllNoteSources, stopAllNoteSources } from './integrations/shared/note-sources.js';
import { loadProModules } from './plugin-loader.js';

// 初始化
// 数据目录一次性迁移必须是第一步（在 loadConfig / 打开 DB 之前）
migrateDataDirIfNeeded(migrationLog);
// 检查 config 内已停用的模型 ID,自动替换为可用版本(必须在 loadConfig 之前)
migrateConfigIfNeeded(migrationLog);
loadConfig();
ensureDataDirs();

// Cloud mode: when enabled, local metabolism is disabled (cloud handles it)
const cloudEnabled = getConfig().cloud?.enabled ?? false;
if (cloudEnabled) {
  log.info('cloud mode enabled — local metabolism tasks will be skipped');
}
getDb();
backfillSyncHashes(); // DB 初始化后补填同步哈希
await initVec();

// 加载 Pro 模块（不存在则跳过）
await loadProModules({ db: getDb() });

const TICK_INTERVAL_MS = 60 * 1000; // 每分钟检查一次

// 启动所有已配置的笔记源
startAllNoteSources(getDb()).catch(err =>
  log.error('笔记源启动失败:', err instanceof Error ? err.stack : String(err)),
);

// 启动时立刻执行一轮（cloud mode 下跳过本地代谢）
if (!cloudEnabled) {
  runSchedulerTick(getDb(), ALL_TASKS).catch(err =>
    log.error('初始调度失败:', err instanceof Error ? err.stack : String(err)),
  );
}

// 定时调度：每分钟 tick，每个任务独立判断是否到期
// 防重入：上一轮未完成时跳过，避免长任务（LLM 调用）导致堆叠
//
// 注意：这里没有 tick 级 timeout。长 LLM 调用由 src/llm/client.ts 的
// AbortController 控制上限（TIMEOUT_MS_BY_TIER）。此前曾用 Promise.race
// 加 55s 上限，但那不会真的中止在途的 LLM 调用，只会让 tickRunning 提前
// 放行，反而造成多轮 scheduler 并发执行——已移除。
let tickRunning = false;
let tickCount = 0;
const STRATEGY_SYNC_EVERY_N_TICKS = 5; // 每 5 分钟从源码同步一次策略文件
setInterval(() => {
  if (tickRunning) return;
  tickRunning = true;
  tickCount++;

  // 检查 Skill/MCP 描述文件变更（轻量级，不阻塞）
  try { checkFileWatchers(); } catch (err) { log.warn('checkFileWatchers 出错', err); }
  // 定期从源码同步策略文件，无需重启 daemon
  if (tickCount % STRATEGY_SYNC_EVERY_N_TICKS === 0) {
    try { syncStrategiesFromSource(); reloadStrategies(); } catch (err) { log.warn('策略同步/重载出错', err); }
  }

  if (cloudEnabled) {
    // Cloud mode: skip local metabolism, only run file watchers / strategy sync above
    tickRunning = false;
    return;
  }

  runSchedulerTick(getDb(), ALL_TASKS)
    .catch(err => log.error('调度 tick 失败:', err instanceof Error ? err.stack : String(err)))
    .finally(() => { tickRunning = false; });
}, TICK_INTERVAL_MS);

// 优雅退出
function shutdown() {
  stopAllNoteSources();
  try { closeDb(); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

logTimelineEvent(getDb(), {
  type: 'memory',
  subtype: 'daemon_start',
  title: JSON.stringify({ key: 'daemon_start' }),
  detail: { task_count: ALL_TASKS.length, tick_interval_s: TICK_INTERVAL_MS / 1000 },
  actor: 'brain',
});

log.info(`守护进程已启动。每 ${TICK_INTERVAL_MS / 1000}s tick，共 ${ALL_TASKS.length} 个任务独立调度。`);
