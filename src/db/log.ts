import type Database from 'better-sqlite3';
import type { OperationLogEntry } from '../types.js';
import { now } from '../utils/time.js';

type ParamFeedbackRow = {
  id: number;
  param_name: string | null;
  signal_type: string;
  signal_value: number;
  created: string;
};

export function logOperation(
  db: Database.Database,
  params: {
    operation: string;
    input_summary?: string;
    context?: string;
    output_node_ids?: string[];
    tool?: string;
    session?: string;
    agent_id?: string;
  },
): number {
  const result = db.prepare(`
    INSERT INTO operation_log (operation, input_summary, context, output_node_ids, tool, session, agent_id, created)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.operation,
    params.input_summary ?? null,
    params.context ?? null,
    params.output_node_ids ? JSON.stringify(params.output_node_ids) : null,
    params.tool ?? null,
    params.session ?? null,
    params.agent_id ?? null,
    now(),
  );
  return result.lastInsertRowid as number;
}

export function getRecallCount(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) as cnt FROM operation_log WHERE operation = 'recall'").get() as { cnt: number }).cnt;
}

export function getRecentOperations(db: Database.Database, limit: number = 20): OperationLogEntry[] {
  return db.prepare(
    'SELECT * FROM operation_log ORDER BY created DESC LIMIT ?',
  ).all(limit) as OperationLogEntry[];
}

export function logStrategyFeedback(
  db: Database.Database,
  params: {
    strategy_name: string;
    operation_id?: number;
    node_id?: string;
    was_used?: boolean;
    feedback_signal?: number;
  },
): void {
  db.prepare(`
    INSERT INTO strategy_feedback (strategy_name, operation_id, node_id, was_used, feedback_signal, created)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    params.strategy_name,
    params.operation_id ?? null,
    params.node_id ?? null,
    params.was_used !== undefined ? (params.was_used ? 1 : 0) : null,
    params.feedback_signal ?? null,
    now(),
  );
}

export function logTimelineEvent(
  db: Database.Database,
  params: {
    type: string;
    subtype: string;
    title: string;
    detail?: Record<string, unknown>;
    node_ids?: string[];
    important?: number;
    actor?: 'user' | 'agent' | 'brain';
  },
): number {
  const result = db.prepare(`
    INSERT INTO timeline_events (type, subtype, title, detail, node_ids, important, actor, created)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.type,
    params.subtype,
    params.title,
    params.detail ? JSON.stringify(params.detail) : null,
    params.node_ids ? JSON.stringify(params.node_ids) : null,
    params.important ?? 0,
    params.actor ?? 'brain',
    now(),
  );
  return result.lastInsertRowid as number;
}

// --- Learning II 参数反馈 ---

export function logParamFeedback(
  db: Database.Database,
  params: {
    strategy_name: string;
    param_name?: string;
    signal_type: string;
    signal_value: number;
    context?: string;
  },
): void {
  db.prepare(`
    INSERT INTO param_feedback (strategy_name, param_name, signal_type, signal_value, context, created)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    params.strategy_name,
    params.param_name ?? null,
    params.signal_type,
    params.signal_value,
    params.context ?? null,
    now(),
  );
}

export function getParamFeedback(
  db: Database.Database,
  strategyName: string,
  signalType?: string,
  days: number = 30,
): ParamFeedbackRow[] {
  if (signalType) {
    return db.prepare(
      `SELECT * FROM param_feedback WHERE strategy_name = ? AND signal_type = ? AND created > datetime('now', '-' || ? || ' days') ORDER BY created DESC`
    ).all(strategyName, signalType, days) as ParamFeedbackRow[];
  }
  return db.prepare(
    `SELECT * FROM param_feedback WHERE strategy_name = ? AND created > datetime('now', '-' || ? || ' days') ORDER BY created DESC`
  ).all(strategyName, days) as ParamFeedbackRow[];
}

export function getParamFeedbackByRange(
  db: Database.Database,
  strategyName: string,
  signalType: string | undefined,
  startDate: string,
  endDate: string,
): ParamFeedbackRow[] {
  if (signalType) {
    return db.prepare(
      `SELECT * FROM param_feedback WHERE strategy_name = ? AND signal_type = ? AND created BETWEEN ? AND ? ORDER BY created DESC`
    ).all(strategyName, signalType, startDate, endDate) as ParamFeedbackRow[];
  }
  return db.prepare(
    `SELECT * FROM param_feedback WHERE strategy_name = ? AND created BETWEEN ? AND ? ORDER BY created DESC`
  ).all(strategyName, startDate, endDate) as ParamFeedbackRow[];
}

export function getStrategyFeedback(
  db: Database.Database,
  strategyName: string,
  limit: number = 100,
): Array<{ id: number; operation_id: number | null; node_id: string | null; was_used: number | null; feedback_signal: number | null; created: string }> {
  return db.prepare(
    'SELECT * FROM strategy_feedback WHERE strategy_name = ? ORDER BY created DESC LIMIT ?'
  ).all(strategyName, limit) as Array<{ id: number; operation_id: number | null; node_id: string | null; was_used: number | null; feedback_signal: number | null; created: string }>;
}
