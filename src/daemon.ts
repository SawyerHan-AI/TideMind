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

// 提前安装顶层错误处理器，确保 main() 初始化阶段抛错也能被记录而非静默退出
process.on('uncaughtException', (err) => {
  log.error('uncaughtException:', err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection:', reason instanceof Error ? reason.stack : String(reason));
});

const TICK_INTERVAL_MS = 60 * 1000; // 每分钟检查一次

/**
 * 优雅退出
 *
 * 之前 shutdown 是同步函数：调 stopAllNoteSources()（内部是 detached promise）
 * 后立刻 process.exit(0)，导致笔记源 watcher / DB checkpoint 还没收尾进程就消失。
 * 改为 async：等 stop 完成（最多 10s），再 closeDb，最后 exit。
 */
async function shutdown(): Promise<void> {
  log.info('shutdown 开始');
  try {
    // stopAllNoteSources 内部 fire-and-forget 4 个 dynamic import + stop 调用，
    // 这里手动 await 它们的结果以保证收尾真正完成；超过 10s 强制放行避免卡死。
    const stopPromise: Promise<void> = (async () => {
      try {
        await Promise.all([
          import('./integrations/logseq/index.js').then(m => m.stopLogseqIntegration()).catch(() => {}),
          import('./integrations/obsidian/index.js').then(m => m.stopObsidianIntegration()).catch(() => {}),
          import('./integrations/apple-notes/index.js').then(m => m.stopAppleNotesIntegration()).catch(() => {}),
          import('./integrations/notion/index.js').then(m => m.stopNotionIntegration()).catch(() => {}),
        ]);
      } catch (err) {
        log.warn('stopAllNoteSources 出错', err instanceof Error ? err.stack : String(err));
      }
      // 同步版本也调一遍，保留原有副作用（保险起见）
      try { stopAllNoteSources(); } catch { /* ignore */ }
    })();
    const timeoutPromise = new Promise<void>(resolve => setTimeout(resolve, 10_000));
    await Promise.race([stopPromise, timeoutPromise]);
  } catch (err) {
    log.warn('shutdown stop 阶段异常', err instanceof Error ? err.stack : String(err));
  }
  try {
    closeDb();
  } catch (err) {
    log.warn('closeDb 出错', err instanceof Error ? err.stack : String(err));
  }
  process.exit(0);
}

async function main(): Promise<void> {
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
  // 修复 M24(2026-05-09):加宽松超时(12 分钟)兜底。历史移除 55s race 是
  // 因为它不真中止 LLM,但完全无 timeout 也会留下"任意 task 内 promise 不
  // settle 时 daemon 静默冻结"的风险——LLM 客户端的 timeout 是大概率兜底,
  // 不是强制保证。12 分钟远大于 LLM 合理 timeout 上限(标准档 180s),只在
  // 真异常时触发,日志显式标记给 ops 排查。
  const TICK_HARD_TIMEOUT_MS = 12 * 60 * 1000;
  let tickRunning = false;
  let tickCount = 0;
  let tickStartedAt = 0;
  const STRATEGY_SYNC_EVERY_N_TICKS = 5; // 每 5 分钟从源码同步一次策略文件
  setInterval(() => {
    // 超时兜底:发现上一轮已运行超过 hard timeout,放行并 warn
    if (tickRunning && tickStartedAt > 0) {
      const elapsedMs = Date.now() - tickStartedAt;
      if (elapsedMs > TICK_HARD_TIMEOUT_MS) {
        log.error(
          `daemon tick 卡死 ${Math.round(elapsedMs / 60000)} 分钟,强制放行 tickRunning。` +
          '上一轮 promise 仍可能在跑,本轮启动即为并发——异常情形,请检查 LLM 调用与底层 SDK abort 行为。',
        );
        try {
          logTimelineEvent(getDb(), {
            type: 'memory',
            subtype: 'daemon_tick_timeout',
            title: JSON.stringify({ key: 'daemon_tick_timeout' }),
            detail: { elapsed_ms: elapsedMs, hard_timeout_ms: TICK_HARD_TIMEOUT_MS },
            important: 1,
          });
        } catch { /* timeline 写失败不能阻断恢复 */ }
        tickRunning = false;
        tickStartedAt = 0;
      }
    }

    if (tickRunning) return;
    tickRunning = true;
    tickStartedAt = Date.now();
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
      tickStartedAt = 0;
      return;
    }

    runSchedulerTick(getDb(), ALL_TASKS)
      .catch(err => log.error('调度 tick 失败:', err instanceof Error ? err.stack : String(err)))
      .finally(() => { tickRunning = false; tickStartedAt = 0; });
  }, TICK_INTERVAL_MS);

  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });

  logTimelineEvent(getDb(), {
    type: 'memory',
    subtype: 'daemon_start',
    title: JSON.stringify({ key: 'daemon_start' }),
    detail: { task_count: ALL_TASKS.length, tick_interval_s: TICK_INTERVAL_MS / 1000 },
    actor: 'brain',
  });

  log.info(`守护进程已启动。每 ${TICK_INTERVAL_MS / 1000}s tick，共 ${ALL_TASKS.length} 个任务独立调度。`);
}

main().catch((err) => {
  log.error('daemon 启动失败:', err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
