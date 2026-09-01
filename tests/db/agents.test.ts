/**
 * db/agents.ts 单元测试
 *
 * Agent CRUD + touchAgent 身份安全边界。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_s: string, _p: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

import type Database from 'better-sqlite3';
import { setupTestDb } from '../helpers/test-db.js';
import {
  touchAgent,
  getAgent,
  listAgents,
  createAgent,
  updateAgent,
  archiveAgent,
  unarchiveAgent,
} from '../../src/db/agents.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
});

// ===== createAgent =====

describe('createAgent', () => {
  it('创建 agent 并返回完整对象', () => {
    const agent = createAgent(db, { name: 'Test Agent', tool_type: 'cowork' });
    expect(agent.id).toMatch(/^eb_[a-f0-9]{8}$/);
    expect(agent.name).toBe('Test Agent');
    expect(agent.tool_type).toBe('cowork');
    expect(agent.archived).toBe(0);
    expect(agent.last_active).toBeNull();
  });

  it('每次创建的 id 不同', () => {
    const a1 = createAgent(db, { name: 'A1', tool_type: 't' });
    const a2 = createAgent(db, { name: 'A2', tool_type: 't' });
    expect(a1.id).not.toBe(a2.id);
  });
});

// ===== getAgent =====

describe('getAgent', () => {
  it('存在的 agent 返回数据', () => {
    const created = createAgent(db, { name: 'X', tool_type: 'mcp' });
    const found = getAgent(db, created.id);
    expect(found).not.toBeNull();
    expect(found!.name).toBe('X');
  });

  it('不存在的 id 返回 undefined', () => {
    expect(getAgent(db, 'nonexistent')).toBeUndefined();
  });
});

// ===== listAgents =====

describe('listAgents', () => {
  it('默认不包含归档 agent', () => {
    const a1 = createAgent(db, { name: 'Active', tool_type: 't' });
    const a2 = createAgent(db, { name: 'Archived', tool_type: 't' });
    archiveAgent(db, a2.id);

    const list = listAgents(db);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(a1.id);
  });

  it('includeArchived=true 包含归档 agent', () => {
    createAgent(db, { name: 'Active', tool_type: 't' });
    const a2 = createAgent(db, { name: 'Archived', tool_type: 't' });
    archiveAgent(db, a2.id);

    const list = listAgents(db, true);
    expect(list).toHaveLength(2);
  });

  it('空表返回空数组', () => {
    expect(listAgents(db)).toHaveLength(0);
  });
});

// ===== touchAgent =====

describe('touchAgent', () => {
  it('更新 last_active 时间', () => {
    const agent = createAgent(db, { name: 'Touch', tool_type: 't' });
    expect(agent.last_active).toBeNull();

    const result = touchAgent(db, agent.id);

    const updated = getAgent(db, agent.id);
    expect(updated!.last_active).not.toBeNull();
    expect(result).toEqual({ status: 'touched' });
  });

  it('不会让 last_active 因系统时钟回拨而倒退', () => {
    const agent = createAgent(db, { name: 'Future Agent', tool_type: 'cursor' });
    const future = '2099-01-01T00:00:00.000Z';
    db.prepare('UPDATE agents SET last_active = ? WHERE id = ?').run(future, agent.id);

    expect(touchAgent(db, agent.id)).toEqual({ status: 'touched' });
    expect(getAgent(db, agent.id)?.last_active).toBe(future);
  });

  it('归档身份不会因 MCP 活动自动复活', () => {
    const agent = createAgent(db, { name: 'Archived', tool_type: 't' });
    archiveAgent(db, agent.id);
    expect(getAgent(db, agent.id)!.archived).toBe(1);

    const result = touchAgent(db, agent.id);

    expect(result).toEqual({ status: 'suppressed', reason: 'archived' });
    expect(getAgent(db, agent.id)!.archived).toBe(1);
    expect(getAgent(db, agent.id)!.last_active).toBeNull();
  });

  it('未知 agent 只返回 orphan diagnostic，不隐式建档', () => {
    const agentId = 'eb_deadbeef';
    expect(getAgent(db, agentId)).toBeUndefined();

    const result = touchAgent(db, agentId);

    expect(result).toEqual({ status: 'orphan', reason: 'unknown_agent' });
    expect(getAgent(db, agentId)).toBeUndefined();
    const event = db.prepare(`
      SELECT kind, severity, payload_json
      FROM agent_integration_events
      WHERE kind = 'orphan_agent_activity'
    `).get() as { kind: string; severity: string; payload_json: string };
    expect(event.kind).toBe('orphan_agent_activity');
    expect(event.severity).toBe('warning');
    expect(JSON.parse(event.payload_json)).toEqual({
      agent_id: agentId,
      reason: 'unknown_agent',
    });
  });

  it('removed/tombstoned Installation 不更新旧 agents 行', () => {
    const agent = createAgent(db, { name: 'Removed', tool_type: 'cursor' });
    db.prepare(`
      INSERT INTO agent_installations (
        id, family, host_variant, install_key, provenance, display_name,
        agent_id, desired_state, tombstoned_at, created_at, updated_at
      ) VALUES (?, 'cursor', 'cursor-desktop', ?, 'legacy', 'Cursor', ?, 'removed', ?, ?, ?)
    `).run(
      'installation-1',
      'cursor:test',
      agent.id,
      new Date().toISOString(),
      new Date().toISOString(),
      new Date().toISOString(),
    );

    const result = touchAgent(db, agent.id);

    expect(result).toEqual({ status: 'suppressed', reason: 'removed' });
    expect(getAgent(db, agent.id)!.last_active).toBeNull();
    const event = db.prepare(`
      SELECT installation_id, payload_json
      FROM agent_integration_events
      WHERE kind = 'orphan_agent_activity'
    `).get() as { installation_id: string; payload_json: string };
    expect(event.installation_id).toBe('installation-1');
    expect(JSON.parse(event.payload_json).reason).toBe('removed');
  });

  it('legacy alias 指向 tombstone 时不会被当作新身份重建', () => {
    const legacyId = 'eb_legacy_alias';
    const timestamp = new Date().toISOString();
    db.prepare(`
      INSERT INTO agent_installations (
        id, family, host_variant, install_key, provenance, display_name,
        desired_state, tombstoned_at, created_at, updated_at
      ) VALUES (?, 'cursor', 'cursor-desktop', ?, 'legacy', 'Cursor tombstone',
        'disabled', ?, ?, ?)
    `).run('installation-tombstone', 'cursor:tombstone', timestamp, timestamp, timestamp);
    db.prepare(`
      INSERT INTO agent_aliases (
        id, alias_type, alias_value, canonical_agent_id, installation_id, reason, created_at
      ) VALUES (?, 'legacy_agent_id', ?, NULL, ?, 'legacy migration', ?)
    `).run('alias-tombstone', legacyId, 'installation-tombstone', timestamp);

    const result = touchAgent(db, legacyId);

    expect(result).toEqual({ status: 'suppressed', reason: 'tombstoned' });
    expect(getAgent(db, legacyId)).toBeUndefined();
    const event = db.prepare(`
      SELECT installation_id, payload_json
      FROM agent_integration_events
      WHERE kind = 'orphan_agent_activity'
    `).get() as { installation_id: string; payload_json: string };
    expect(event.installation_id).toBe('installation-tombstone');
    expect(JSON.parse(event.payload_json).reason).toBe('tombstoned');
  });
});

// ===== updateAgent =====

describe('updateAgent', () => {
  it('更新 name', () => {
    const agent = createAgent(db, { name: 'Old', tool_type: 't' });
    updateAgent(db, agent.id, { name: 'New' });
    expect(getAgent(db, agent.id)!.name).toBe('New');
  });

  it('更新 tool_type', () => {
    const agent = createAgent(db, { name: 'X', tool_type: 'old' });
    updateAgent(db, agent.id, { tool_type: 'new' });
    expect(getAgent(db, agent.id)!.tool_type).toBe('new');
  });

  it('空 params 不做任何修改', () => {
    const agent = createAgent(db, { name: 'Keep', tool_type: 'keep' });
    updateAgent(db, agent.id, {});
    const found = getAgent(db, agent.id)!;
    expect(found.name).toBe('Keep');
    expect(found.tool_type).toBe('keep');
  });
});

// ===== archive / unarchive =====

describe('archive / unarchive', () => {
  it('归档后 archived = 1', () => {
    const agent = createAgent(db, { name: 'A', tool_type: 't' });
    archiveAgent(db, agent.id);
    expect(getAgent(db, agent.id)!.archived).toBe(1);
  });

  it('取消归档后 archived = 0', () => {
    const agent = createAgent(db, { name: 'A', tool_type: 't' });
    archiveAgent(db, agent.id);
    unarchiveAgent(db, agent.id);
    expect(getAgent(db, agent.id)!.archived).toBe(0);
  });
});
