import type Database from 'better-sqlite3';
import { now } from '../utils/time.js';
import { randomBytes } from 'node:crypto';
import { sanitizeAgentIntegrationEventPersistence } from './agent-integration-event-sanitizer.js';

export interface Agent {
  id: string;
  name: string;
  tool_type: string;
  archived: number;
  last_active: string | null;
  created: string;
}

/**
 * 生成 agent_id: "eb_" + 8 位随机 hex
 */
function generateAgentId(): string {
  return 'eb_' + randomBytes(4).toString('hex');
}

export type TouchAgentResult =
  | { status: 'touched' }
  | { status: 'suppressed'; reason: 'archived' | 'removed' | 'tombstoned' }
  | { status: 'orphan'; reason: 'unknown_agent' };

function tableExists(db: Database.Database, table: string): boolean {
  try {
    return Boolean(db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
    ).get(table));
  } catch {
    return false;
  }
}

function getManagedIdentitySuppression(
  db: Database.Database,
  agentId: string,
): { reason: 'removed' | 'tombstoned'; installationId: string } | null {
  if (!tableExists(db, 'agent_installations')) return null;
  try {
    let row = db.prepare(`
      SELECT id, desired_state, tombstoned_at
      FROM agent_installations
      WHERE agent_id = ?
      LIMIT 1
    `).get(agentId) as {
      id: string;
      desired_state: string;
      tombstoned_at: string | null;
    } | undefined;
    if (!row && tableExists(db, 'agent_aliases')) {
      row = db.prepare(`
        SELECT i.id, i.desired_state, i.tombstoned_at
        FROM agent_aliases a
        JOIN agent_installations i ON i.id = a.installation_id
        WHERE a.alias_value = ?
          AND a.alias_type IN ('legacy_agent_id', 'agent_id')
        LIMIT 1
      `).get(agentId) as typeof row;
    }
    if (!row) return null;
    if (row.desired_state === 'removed') {
      return { reason: 'removed', installationId: row.id };
    }
    if (row.tombstoned_at) {
      return { reason: 'tombstoned', installationId: row.id };
    }
  } catch {
    // v34 之前的兼容 schema 或正在修复的 DB 不得阻断已知活跃身份。
    // 真正的 removed/tombstone 仍由 archived 和新表双重保护。
    return null;
  }
  return null;
}

function recordOrphanAgentActivity(
  db: Database.Database,
  agentId: string,
  reason: 'unknown_agent' | 'archived' | 'removed' | 'tombstoned',
  installationId: string | null = null,
): void {
  if (!tableExists(db, 'agent_integration_events')) return;
  const createdAt = now();
  // 旧 MCP 可能在每个工具调用都上报，按身份/原因/自然日去重，
  // 避免一个遗留进程刷爆诊断表。
  const day = createdAt.slice(0, 10);
  const dedupeKey = `orphan-agent-activity:${agentId}:${reason}:${day}`;
  const sanitized = sanitizeAgentIntegrationEventPersistence({
    kind: 'orphan_agent_activity',
    dedupeKey,
    payload: { agent_id: agentId, reason },
  });
  try {
    db.prepare(`
      INSERT OR IGNORE INTO agent_integration_events (
        id, installation_id, kind, severity, dedupe_key, state, payload_json, created_at
      ) VALUES (?, ?, 'orphan_agent_activity', 'warning', ?, 'unread', ?, ?)
    `).run(
      `aie_${randomBytes(12).toString('hex')}`,
      installationId,
      sanitized.dedupeKey,
      sanitized.payloadJson,
      createdAt,
    );
  } catch {
    // 诊断落库不能让 MCP 业务调用失败。返回值仍完整表达 orphan/suppressed。
  }
}

/**
 * 更新仍启用的已知 Agent 最近活跃时间。
 *
 * MCP/hook 是不可信活动信号，不能用来改变用户期望：
 * - archived/removed/tombstoned 身份不复活；
 * - 未知旧 ID 不自动 INSERT，只返回 orphan diagnostic 给调用方记录。
 */
export function touchAgent(db: Database.Database, agentId: string): TouchAgentResult {
  const existing = db.prepare(
    'SELECT archived FROM agents WHERE id = ?'
  ).get(agentId) as { archived: number } | undefined;

  if (!existing) {
    const managedSuppression = getManagedIdentitySuppression(db, agentId);
    if (managedSuppression) {
      recordOrphanAgentActivity(
        db,
        agentId,
        managedSuppression.reason,
        managedSuppression.installationId,
      );
      return { status: 'suppressed', reason: managedSuppression.reason };
    }
    recordOrphanAgentActivity(db, agentId, 'unknown_agent');
    return { status: 'orphan', reason: 'unknown_agent' };
  }
  if (existing.archived !== 0) {
    recordOrphanAgentActivity(db, agentId, 'archived');
    return { status: 'suppressed', reason: 'archived' };
  }

  const managedSuppression = getManagedIdentitySuppression(db, agentId);
  if (managedSuppression) {
    recordOrphanAgentActivity(
      db,
      agentId,
      managedSuppression.reason,
      managedSuppression.installationId,
    );
    return { status: 'suppressed', reason: managedSuppression.reason };
  }

  const touchedAt = now();
  db.prepare(`
    UPDATE agents SET last_active = ?
    WHERE id = ? AND archived = 0
      AND (last_active IS NULL OR julianday(?) > julianday(last_active))
  `).run(touchedAt, agentId, touchedAt);
  return { status: 'touched' };
}

export function getAgent(db: Database.Database, agentId: string): Agent | undefined {
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as Agent | undefined;
}

export function listAgents(db: Database.Database, includeArchived: boolean = false): Agent[] {
  if (includeArchived) {
    return db.prepare('SELECT * FROM agents ORDER BY last_active DESC NULLS LAST, created DESC').all() as Agent[];
  }
  return db.prepare('SELECT * FROM agents WHERE archived = 0 ORDER BY last_active DESC NULLS LAST, created DESC').all() as Agent[];
}

export function createAgent(db: Database.Database, params: { name: string; tool_type: string }): Agent {
  const id = generateAgentId();
  const created = now();
  db.prepare(
    'INSERT INTO agents (id, name, tool_type, created) VALUES (?, ?, ?, ?)'
  ).run(id, params.name, params.tool_type, created);
  return { id, name: params.name, tool_type: params.tool_type, archived: 0, last_active: null, created };
}

export function updateAgent(db: Database.Database, id: string, params: Partial<{ name: string; tool_type: string }>): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (params.name !== undefined) { sets.push('name = ?'); values.push(params.name); }
  if (params.tool_type !== undefined) { sets.push('tool_type = ?'); values.push(params.tool_type); }
  if (sets.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function archiveAgent(db: Database.Database, id: string): void {
  db.prepare('UPDATE agents SET archived = 1 WHERE id = ?').run(id);
}

export function unarchiveAgent(db: Database.Database, id: string): void {
  db.prepare('UPDATE agents SET archived = 0 WHERE id = ?').run(id);
}
