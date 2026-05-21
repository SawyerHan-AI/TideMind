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
import { runSchedulerTick, noteSuccessfulLLMCall, setLLMFailureHook, recordLLMFailureForHook, recordEmbeddingSuccess, recordEmbeddingFailure } from './metabolism/scheduler.js';
import { ALL_TASKS } from './metabolism/tasks.js';
import { setLLMSuccessHook } from './llm/client.js';
import { setEmbeddingSuccessHook, setEmbeddingFailureHook } from './llm/embedding.js';
import { migrateDataDirIfNeeded } from './utils/migrate-data-dir.js';
import { migrateConfigIfNeeded } from './utils/config-migrate.js';

const log = createLogger('daemon');
const migrationLog = createLogger('migrate');
import { startAllNoteSources, stopAllNoteSources } from './integrations/shared/note-sources.js';
import { loadProModules } from './plugin-loader.js';

// 提前安装顶层错误处理器，确保 main() 初始化阶段抛错也能被记录而非静默退出
//
// 2026-05-21 audit F10:旧实现 uncaughtException 是 immediate exit(1),
// unhandledRejection 完全不退出。两者行为不一致,后者会让 daemon 留在僵尸态
// 继续 tick 但内部状态可能已坏。统一为"log.error 后等 1s 让日志 flush 再 exit(1)"。
// 1s 是经验值:足够 stderr / file logger 把异步队列 drain 完,又不至于让运维等太久。
process.on('uncaughtException', (err) => {
  log.error('uncaughtException:', err instanceof Error ? err.stack : String(err));
  setTimeout(() => process.exit(1), 1000);
});
process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection:', reason instanceof Error ? reason.stack : String(reason));
  setTimeout(() => process.exit(1), 1000);
});

const TICK_INTERVAL_MS = 60 * 1000; // 每分钟检查一次

// 2026-05-21 audit F9:daemon 主循环 setInterval 句柄,shutdown 时必须
// clearInterval。老实现没有 clear,主循环会继续触发(每 60s)直到 process.exit
// 真正生效——若 stop 阶段卡在 10s,期间还会有一次 tick 启 LLM/DB 调用,
// 跟 closeDb 竞争产生 cryptic error。即便 exit(0) 同步到来,挂在 timer
// 队列里的 callback 也是噪声。改成持有句柄 + shutdown 先 clearInterval。
let tickHandle: NodeJS.Timeout | null = null;

/**
 * 优雅退出
 *
 * 之前 shutdown 是同步函数：调 stopAllNoteSources()（内部是 detached promise）
 * 后立刻 process.exit(0)，导致笔记源 watcher / DB checkpoint 还没收尾进程就消失。
 * 改为 async：等 stop 完成（最多 10s），再 closeDb，最后 exit。
 */
async function shutdown(): Promise<void> {
  log.info('shutdown 开始');
  // F9:第一时间停掉主 tick,避免 shutdown 期间再启动新 tick 触发 LLM/DB
  // 调用与 closeDb 竞争。clearInterval 后,即便 finally 中的回调还在,
  // 也不会再有新的 setInterval 触发。
  if (tickHandle !== null) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
  try {
    // stopAllNoteSources 内部 fire-and-forget 4 个 dynamic import + stop 调用，
    // 这里手动 await 它们的结果以保证收尾真正完成；超过 10s 强制放行避免卡死。
    const stopPromise: Promise<void> = (async () => {
      try {
        await Promise.all([
          // F12 (audit-8): catch 内必须 log 出来,不然 logseq/obsidian/apple-notes/notion
          // stop 失败完全静默,运维只能看到"shutdown 完成"但实际可能某个 integration
          // 留下了 fs.watch / 长任务 handle,进程没能干净退出。
          import('./integrations/logseq/index.js').then(m => m.stopLogseqIntegration()).catch(err => log.warn('stopLogseqIntegration failed:', err)),
          import('./integrations/obsidian/index.js').then(m => m.stopObsidianIntegration()).catch(err => log.warn('stopObsidianIntegration failed:', err)),
          import('./integrations/apple-notes/index.js').then(m => m.stopAppleNotesIntegration()).catch(err => log.warn('stopAppleNotesIntegration failed:', err)),
          import('./integrations/notion/index.js').then(m => m.stopNotionIntegration()).catch(err => log.warn('stopNotionIntegration failed:', err)),
        ]);
      } catch (err) {
        log.warn('stopAllNoteSources 出错', err instanceof Error ? err.stack : String(err));
      }
      // 同步版本也调一遍，保留原有副作用（保险起见）
      try { stopAllNoteSources(); } catch (err) { log.warn('stopAllNoteSources sync 调用失败:', err); }
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

  // 注入 LLM 成功 hook(2026-05-20 Audit A-1/A-2 修复):
  // callLLM 拿到 2xx response 时主动调本回调,只对真实 LLM 成功记录健康度信号。
  // 之前 scheduler 在 task.execute() 完成后无条件调 recordLLMSuccess,导致 LLM
  // 全挂 7 天期间 digest-retry 等任务内部吞 LLMServiceError 后仍 "正常 return",
  // scheduler 误写 llm_last_success_at 并重置熔断器,使整个 resilience 防御失效。
  // hook 走 try/catch 兜底,失败永远不影响 LLM 调用主流程。
  const dbForHook = getDb();
  setLLMSuccessHook(() => noteSuccessfulLLMCall(dbForHook));

  // 修复 F3(2026-05-21): 注入 LLM 失败 hook —
  // link-revalidate / reconsolidate 在 recall 路径 fire-and-forget 调用,
  // 内部 catch LLMServiceError 只 log.warn,不走 scheduler 的 recordLLMFailure。
  // 通过 hook,这些路径的 LLM 失败也能累积熔断计数。
  setLLMFailureHook(err => recordLLMFailureForHook(dbForHook, err.message));

  // B-3 (2026-05-21): 注入 Embedding 健康度 hook —
  // getEmbedding 拿到合法向量 → recordEmbeddingSuccess 清零熔断器。
  // getEmbedding 拿到 null / 抛错 → recordEmbeddingFailure 累积失败。
  // requiresEmbedding 任务在熔断器 open 时被跳过,避免持续浪费 quota。
  setEmbeddingSuccessHook(() => recordEmbeddingSuccess(dbForHook));
  setEmbeddingFailureHook(err => recordEmbeddingFailure(dbForHook, err.message));

  // 冷启 backfill llm_last_success_at(2026-05-20 Audit A-5 修复):
  // 升级用户从 v0.2.67 → v0.2.68 后,metadata 表没有 llm_last_success_at 这条
  // 记录(本字段 v0.2.68 才引入),pending-link-gc 的 gate 永远拒绝放行 →
  // pending 表只增不清。从 timeline_events 找最近一条 LLM 操作事件作为兜底
  // 时间戳(annotate / links_evaluated / links_discovered 等 events.type 反映
  // "曾经成功调过 LLM"),写一个合理近似值。fresh install 没这些事件,留 null
  // 走"从未成功 → gate 拒绝"的保守分支,首次真实 LLM 成功会立刻被 hook 覆盖。
  try {
    const existing = dbForHook.prepare('SELECT value FROM metadata WHERE key = ?').get('llm_last_success_at');
    if (!existing) {
      const recent = dbForHook.prepare(
        `SELECT created FROM timeline_events
         WHERE type IN ('think_associate', 'memory', 'config')
           AND created IS NOT NULL
         ORDER BY created DESC
         LIMIT 1`,
      ).get() as { created: string } | undefined;
      if (recent?.created) {
        const ts = Date.parse(recent.created);
        if (Number.isFinite(ts) && ts > 0) {
          dbForHook.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)')
            .run('llm_last_success_at', String(ts));
          log.info(`backfilled llm_last_success_at from timeline (${recent.created})`);
        }
      }
    }
  } catch (err) {
    log.warn(`llm_last_success_at backfill failed: ${(err as Error).message}`);
  }

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
  //
  // tickId 配对(2026-05-10,与 metabolism/scheduler.ts:M11 同根因):
  // 老版 finally 直接 reset tickRunning=false,在"watchdog 强制复位 → 新 tick
  // 启动 → 老 tick 的 promise 才完成"序列下,老 finally 会把新 tick 的 running
  // 状态抹掉,使下一轮 setInterval 与新 tick 真正并发。改用 currentTickId 严格
  // 配对:finally 只在自己仍是当前 tick 时才 reset。
  const TICK_HARD_TIMEOUT_MS = 12 * 60 * 1000;
  let tickRunning = false;
  let tickCount = 0;
  let tickStartedAt = 0;
  let currentTickId = 0;
  const STRATEGY_SYNC_EVERY_N_TICKS = 5; // 每 5 分钟从源码同步一次策略文件
  tickHandle = setInterval(() => {
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
        currentTickId++; // 让老 tick 的 finally 失效(不会再 reset 状态)
      }
    }

    if (tickRunning) return;
    tickRunning = true;
    tickStartedAt = Date.now();
    tickCount++;
    const myTickId = ++currentTickId;

    // 检查 Skill/MCP 描述文件变更（轻量级，不阻塞）
    try { checkFileWatchers(); } catch (err) { log.warn('checkFileWatchers 出错', err); }
    // 定期从源码同步策略文件，无需重启 daemon
    if (tickCount % STRATEGY_SYNC_EVERY_N_TICKS === 0) {
      try { syncStrategiesFromSource(); reloadStrategies(); } catch (err) { log.warn('策略同步/重载出错', err); }
    }

    if (cloudEnabled) {
      // Cloud mode: skip local metabolism, only run file watchers / strategy sync above
      if (myTickId === currentTickId) {
        tickRunning = false;
        tickStartedAt = 0;
      }
      return;
    }

    runSchedulerTick(getDb(), ALL_TASKS)
      .catch(err => log.error('调度 tick 失败:', err instanceof Error ? err.stack : String(err)))
      .finally(() => {
        // 只在自己仍是当前 tick 时才 reset。watchdog 已 ++currentTickId 让
        // 老 tick 失效,避免老 finally 抹掉新 tick 的 running 状态。
        if (myTickId === currentTickId) {
          tickRunning = false;
          tickStartedAt = 0;
        }
      });
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
