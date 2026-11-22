import type Database from 'better-sqlite3';
import {
  claimNextRecallFollowup,
  completeRecallFollowup,
  countPendingRecallFollowups,
  markRecallFollowupItemHandled,
  recoverProcessingRecallFollowups,
  releaseRecallFollowup,
  unmarkRecallFollowupItemHandled,
  type RecallFollowupKind,
  type RecallFollowupRow,
} from '../db/recall-followups.js';
import { LLMServiceError } from '../llm/client.js';
import { getConnectionHealth } from '../llm/connection-health.js';
import { assertRouteCallable, resolveLLMRoute } from '../llm/route.js';
import { getLLMOptions } from '../strategy/loader.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('recall-followup');

export interface RecallFollowupItem {
  /** Stable key recorded in handled_json before the model call. */
  key: string;
  run: () => Promise<void>;
}

export interface RecallFollowupHandlers {
  /** Strategy whose llm_tier decides the route to pre-check. */
  strategy: string;
  /** Return false to leave the queue untouched (e.g. LLM not configured). */
  canRun?: () => boolean;
  /** Skip the route pre-check (work that does not need a model call). */
  skipRoutePrecheck?: () => boolean;
  /**
   * Items of this row that are still to do, already capped by the per-row limits.
   * `retryLater` = some work of this row cannot be done yet (link too young, node
   * not annotated yet): the row is kept and looked at again later instead of deleted.
   */
  planItems: (row: RecallFollowupRow) => RecallFollowupPlan;
  onRowSettled?: (row: RecallFollowupRow, processed: number) => void;
}

export interface RecallFollowupPlan {
  items: RecallFollowupItem[];
  retryLater?: boolean;
}

/** Re-check interval for rows whose remaining work is not doable yet. */
const RETRY_LATER_MS = 60 * 60_000;
/** A row that stayed "not doable yet" this many times is finally dropped. */
const MAX_RETRY_LATER = 48;

type ErrorShape = { name?: string; kind?: string; code?: string; message?: string; options?: { promptCommitted?: boolean } };

function isAmbiguousKind(error: unknown): boolean {
  const e = error as ErrorShape | null;
  return e?.kind === 'ambiguous_outcome' || e?.code === 'ambiguous_outcome';
}

/**
 * Only a prompt that was actually committed must never be replayed. The same
 * kind is also used for refusals *before* submission (connection already
 * paused): nothing ran, so the item stays retryable.
 */
function isCommittedAmbiguous(error: unknown): boolean {
  return isAmbiguousKind(error) && (error as ErrorShape).options?.promptCommitted === true;
}

/**
 * Bad data or a programming error fails the same way every time. Everything else
 * (service errors, CLI errors, route refusals, an open circuit, cancellation, a
 * runtime that is shutting down) did not produce an adopted result and is retried.
 */
function isDeterministicFailure(error: unknown): boolean {
  return error instanceof TypeError || error instanceof SyntaxError
    || error instanceof ReferenceError || error instanceof RangeError;
}

/**
 * Read-only pre-check: is the tier's route callable right now? Never takes the
 * half-open probe lease (assertConnectionHealthCallable would).
 */
function routeCallable(db: Database.Database, strategy: string): boolean {
  try {
    const route = resolveLLMRoute(getLLMOptions(strategy).model, db);
    assertRouteCallable(route);
    // Covers explicit connections and legacy routes alike (scopeId is always set).
    if (getConnectionHealth(db, route.scopeId)?.circuitState === 'open') return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Process at most one queued recall follow-up row (design §5.4).
 *
 * Must run inside runSchedulerTick: the scheduler owner lock guarantees a single
 * consumer, which is what makes leftover `processing` rows provably stale.
 *
 * Item-level at-most-once: an item is recorded as handled *before* its model
 * call. An ambiguous outcome (or a vanished process) therefore never replays
 * it, while untouched items of the row stay queued.
 */
export async function runRecallFollowup(
  db: Database.Database,
  kind: RecallFollowupKind,
  handlers: RecallFollowupHandlers,
): Promise<void> {
  const recovered = recoverProcessingRecallFollowups(db, kind);
  if (recovered > 0) log.info(`${kind}: 放回 ${recovered} 条上次未收尾的后续工作`);
  if (handlers.canRun && !handlers.canRun()) return;
  if (!handlers.skipRoutePrecheck?.() && !routeCallable(db, handlers.strategy)) {
    log.debug(`${kind}: 当前模型路由不可调用，保留 ${countPendingRecallFollowups(db, kind)} 条待处理`);
    return;
  }
  const row = claimNextRecallFollowup(db, kind);
  if (!row) return;

  let processed = 0;
  try {
    let plan: RecallFollowupPlan;
    try {
      plan = handlers.planItems(row);
    } catch (error) {
      releaseRecallFollowup(db, row.id, { backoff: true });
      throw error;
    }
    for (const item of plan.items) {
      markRecallFollowupItemHandled(db, row.id, item.key);
      try {
        await item.run();
        processed++;
      } catch (error) {
        if (isCommittedAmbiguous(error)) {
          // The call may have run and been billed: never replay this item.
          // The rest of the row stays queued for when the connection resumes.
          releaseRecallFollowup(db, row.id, { backoff: false });
          throw error;
        }
        if (isAmbiguousKind(error)) {
          // Refused before submission because the connection is paused: nothing
          // ran. Keep the item retryable; the pre-check holds the row until the
          // user resumes the connection.
          unmarkRecallFollowupItemHandled(db, row.id, item.key);
          releaseRecallFollowup(db, row.id, { backoff: false });
          return;
        }
        if (!isDeterministicFailure(error)) {
          // Definite failure: nothing was adopted, the item may run again later.
          unmarkRecallFollowupItemHandled(db, row.id, item.key);
          releaseRecallFollowup(db, row.id, { backoff: true });
          if (error instanceof LLMServiceError) throw error;
          log.info(`${kind}: 本次未完成，已延后重试: ${(error as Error)?.message ?? String(error)}`);
          return;
        }
        // Deterministic non-model error (bad data, parse failure): retrying would
        // fail the same way. The item stays handled; continue with the rest.
        log.warn(`${kind}: 条目 ${item.key} 处理失败，已跳过: ${(error as Error)?.message ?? String(error)}`);
      }
    }
    if (plan.retryLater && row.attempts < MAX_RETRY_LATER) {
      // Part of this row is not doable yet; look at it again later instead of dropping it.
      releaseRecallFollowup(db, row.id, { backoff: true, delayMs: RETRY_LATER_MS });
    } else {
      completeRecallFollowup(db, row.id);
    }
  } finally {
    try { handlers.onRowSettled?.(row, processed); } catch (error) {
      log.warn(`${kind}: 收尾记录失败: ${(error as Error).message}`);
    }
    const remaining = countPendingRecallFollowups(db, kind);
    if (remaining > 0) log.debug(`${kind}: 仍有 ${remaining} 条待处理`);
  }
}
