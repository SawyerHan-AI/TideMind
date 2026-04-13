import type Database from 'better-sqlite3';
import { now } from '../utils/time.js';
import { randomBytes } from 'node:crypto';

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

/**
 * 更新 Agent 最近活跃时间 + 自动取消归档
 * 每次 MCP 调用时执行，单条 UPDATE by PK，亚毫秒
 * 如果 agent 已被删除（UPDATE 影响 0 行），自动重建
 */
export function touchAgent(db: Database.Database, agentId: string): void {
  const result = db.prepare(
    'UPDATE agents SET last_active = ?, archived = 0 WHERE id = ?'
  ).run(now(), agentId);

  // agent 被删除后 MCP 进程仍在运行的兜底：自动重建
  if (result.changes === 0) {
    db.prepare(
      'INSERT OR IGNORE INTO agents (id, name, tool_type, last_active, created) VALUES (?, ?, ?, ?, ?)'
    ).run(agentId, `Agent ${agentId}`, 'unknown', now(), now());
  }
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
