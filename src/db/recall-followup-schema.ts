import type Database from 'better-sqlite3';

/**
 * recall 后续工作队列（schema v50）。
 *
 * 设计依据：docs/design/recall-followup-queue-and-llm-quiesce-2026-11-20.md §5。
 *
 * - brain_recall 只在这里记录“链接重新验证 / 深度再巩固”的意图；模型调用由调度器任务
 *   在长驻进程里消费，短命的 MCP / Hook 进程不再发起脱离请求的订阅 CLI 调用。
 * - 行不过期、不淘汰；handled_json 记录已尝试过的条目，保证条目级至多一次。
 * - 本机数据，不加入 cloud_dirty trigger，不进入云同步。
 *
 * SQL 只有这一份权威定义：ensureSchema、v50 migration、Electron fresh / repair schema
 * 都必须调用 ensureRecallFollowupSchema。
 */
export const RECALL_FOLLOWUP_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS recall_followups (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('link_revalidate', 'reconsolidate')),
    dedupe_key TEXT NOT NULL,
    node_ids_json TEXT NOT NULL,
    query TEXT,
    context TEXT,
    handled_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing')),
    attempts INTEGER NOT NULL DEFAULT 0,
    not_before TEXT,
    created TEXT NOT NULL,
    updated TEXT NOT NULL,
    claimed_at TEXT,
    UNIQUE (kind, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_recall_followups_claim
    ON recall_followups(kind, status, updated);
`;

export function ensureRecallFollowupSchema(db: Database.Database): void {
  db.exec(RECALL_FOLLOWUP_SCHEMA_SQL);
}
