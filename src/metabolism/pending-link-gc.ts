// ============================================================
// Pending Link GC — 独立于 LLM 的过期 pending 链接清理
//
// 历史背景：原先这段逻辑嵌在 link-evaluate 内部、先于 LLM 调用执行，
// 导致 LLM 长期不可用时（如 region 错配）熔断器半开探测仍会触发 GC，
// 一次性误删大量等待评估的 pending（2026-05-19 事故，~19200 条）。
// 现在拆成独立任务：
//   - requiresLLM=false，不受熔断器探测影响
//   - gateCheck 依赖 llm_last_success_at 健康度信号，LLM 长期失败时跳过
//   - 单次 LIMIT 兜底防失控
// ============================================================

import type Database from 'better-sqlite3';
import { getParam } from '../strategy/loader.js';
import { logTimelineEvent } from '../db/log.js';
import { now } from '../utils/time.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('pending-link-gc');

export interface PendingLinkGcResult {
  deleted: number;
}

/**
 * 物理删除过期的 pending 链接。
 *
 * 单次最多删 `gc_max_per_run`（默认 2000）条；剩余下一 tick 继续清。
 * 健康路径下日到期数远低于此上限；恢复期（如长时间故障后）渐进清理，留察觉窗口。
 */
export function runPendingLinkGc(
  db: Database.Database,
  opts?: { signal?: AbortSignal },
): PendingLinkGcResult {
  if (opts?.signal?.aborted) throw opts.signal.reason ?? new Error('pending-link-gc aborted');

  const pendingExpireDays = getParam('link-evaluate', 'pending_expire_days', 7);
  const maxPerRun = getParam('link-evaluate', 'gc_max_per_run', 2000);
  // 修复 F2(2026-05-21): created 列是 JS ISO 字符串。原先用 `datetime('now', '-N days')`
  // 返回的字符串没有 'T' 分隔符，字典序对比时位置 10 是 ' ' (0x20) < ISO 的 'T' (0x54),
  // 导致 ISO 永远 ">" SQLite datetime → 过期判定边界一天内全部错判。
  // 改在 JS 侧算好 ISO cutoff 再丢给 SQL。
  const expiredCutoff = new Date(Date.now() - pendingExpireDays * 24 * 3600_000).toISOString();

  const expired = db.prepare(
    `SELECT id FROM links
     WHERE status = 'pending' AND created < ? AND deleted = 0
     ORDER BY created ASC
     LIMIT ?`,
  ).all(expiredCutoff, maxPerRun) as Array<{ id: string }>;

  if (expired.length === 0) return { deleted: 0 };

  // M10:软删(deleted=1 + bump updated/edit_seq),靠 LWW 跨设备传播删除;不 hard-delete。
  const stmt = db.prepare('UPDATE links SET deleted = 1, updated = ?, edit_seq = edit_seq + 1 WHERE id = ?');
  const tx = db.transaction((ids: string[]) => {
    const ts = now();
    for (const id of ids) stmt.run(ts, id);
  });
  tx(expired.map(r => r.id));

  log.info(`pending-link-gc: deleted=${expired.length}`);
  // 修复(2026-05-20 Audit A-3/A-6):type 不能用 'metabolism' —— renderer 的
  // EVENT_TYPES / EVENT_TYPE_COLORS / TYPE_DISPATCH 都不知道这个值,事件会变
  // 成无色、不可筛选、走兜底 GenericDetail。改成 'think_associate'(归属于
  // "联想/链接管理"分类,跟 link_classify / link_discover 一类),subtype 保留
  // 'pending_link_gc' 以便 timeline 详情面板按 subtype 区分。
  logTimelineEvent(db, {
    type: 'think_associate',
    subtype: 'pending_link_gc',
    title: JSON.stringify({ key: 'pending_link_gc', params: { count: expired.length } }),
    detail: { deleted: expired.length },
  });

  return { deleted: expired.length };
}

/**
 * GC 任务门控：仅当最近 pending_expire_days × gc_health_window_ratio 天内有过成功 LLM 调用才放行。
 *
 * 设计意图：
 *   - LLM 健康时 → last success 总是很新 → gate 几乎总放行 → GC 按日 tick 正常清
 *   - LLM 长期故障时 → last success 老化 → gate 拦下 → 避免 pending 在 LLM
 *     不可用期间被无差别清理（次生损失）
 *   - 从未成功过（key 不存在或非数字）→ 保守拒绝。fresh install 或升级后首次未调过 LLM 的
 *     极少数情况下，pending 表会临时不被清理；首次成功 LLM 调用后下一 tick 立即恢复。
 */
export function pendingLinkGcGate(db: Database.Database): boolean {
  const row = db.prepare('SELECT value FROM metadata WHERE key = ?')
    .get('llm_last_success_at') as { value: string } | undefined;
  if (!row) return false;

  const lastSuccessMs = Number(row.value);
  if (!Number.isFinite(lastSuccessMs) || lastSuccessMs <= 0) return false;

  const pendingExpireDays = getParam('link-evaluate', 'pending_expire_days', 7);
  const ratio = getParam('link-evaluate', 'gc_health_window_ratio', 0.5);
  const healthWindowMs = pendingExpireDays * 24 * 3600_000 * ratio;
  const elapsed = Date.now() - lastSuccessMs;
  if (elapsed > healthWindowMs) {
    log.info(`pending-link-gc skipped: last LLM success ${Math.round(elapsed / 3600_000)}h ago (window=${Math.round(healthWindowMs / 3600_000)}h)`);
    return false;
  }
  return true;
}
