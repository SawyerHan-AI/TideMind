import type Database from 'better-sqlite3';
import { createLogger } from '../utils/logger.js';

const log = createLogger('llm-success-backfill');

/**
 * 只有这些 timeline_events subtype 是**确由 LLM 成功调用产出**的。冷启 backfill
 * llm_last_success_at 必须按本白名单过滤,不能按 type——type IN ('memory','config',
 * 'think_associate') 会命中 daemon_start / 笔记同步 / synaptic_scaling /
 * pending_link_gc / circuit_breaker_on(LLM 失败事件)等大量非 LLM 事件。
 * 它们都是 LLM 驱动的代谢任务(annotate/link-evaluate/divergent/link-revalidate)
 * 在成功完成后才写。注:link_discover 是纯启发式(无 LLM),故意不入白名单。
 */
export const LLM_SUCCESS_SUBTYPES = ['annotate', 'link_classify', 'crystal_update', 'refine_links'] as const;

/**
 * 冷启 backfill llm_last_success_at(2026-05-20 Audit A-5):升级用户/旧库可能没有
 * 这条 metadata,导致 pending-link-gc 的健康度 gate 永远拒绝放行,pending 表只增不清。
 * 从 timeline 找最近一条**确由 LLM 成功产出**的事件作为兜底时间戳。无此类事件
 * (fresh install / LLM 从未成功)→ 留空,走"从未成功 → gate 拒绝"的保守分支,
 * 首次真实 LLM 成功会被 hook 立刻覆盖。已有该 key 时不动(只兜底一次)。
 */
export function backfillLlmLastSuccessAt(db: Database.Database): void {
  try {
    const existing = db.prepare('SELECT value FROM metadata WHERE key = ?').get('llm_last_success_at');
    if (existing) return;
    const placeholders = LLM_SUCCESS_SUBTYPES.map(() => '?').join(',');
    const recent = db.prepare(
      `SELECT created FROM timeline_events
       WHERE subtype IN (${placeholders})
         AND created IS NOT NULL
       ORDER BY created DESC
       LIMIT 1`,
    ).get(...LLM_SUCCESS_SUBTYPES) as { created: string } | undefined;
    if (recent?.created) {
      const ts = Date.parse(recent.created);
      if (Number.isFinite(ts) && ts > 0) {
        db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)')
          .run('llm_last_success_at', String(ts));
        log.info(`backfilled llm_last_success_at from timeline (${recent.created})`);
      }
    }
  } catch (err) {
    log.warn(`llm_last_success_at backfill failed: ${(err as Error).message}`);
  }
}
