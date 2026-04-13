/**
 * db/agents.ts 单元测试
 *
 * Agent CRUD + touchAgent 自动复活。
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

    touchAgent(db, agent.id);

    const updated = getAgent(db, agent.id);
    expect(updated!.last_active).not.toBeNull();
  });

  it('自动取消归档', () => {
    const agent = createAgent(db, { name: 'Revive', tool_type: 't' });
    archiveAgent(db, agent.id);
    expect(getAgent(db, agent.id)!.archived).toBe(1);

    touchAgent(db, agent.id);
    expect(getAgent(db, agent.id)!.archived).toBe(0);
  });

  it('agent 被删除后自动重建', () => {
    const agentId = 'eb_deadbeef';
    // agent 不存在
    expect(getAgent(db, agentId)).toBeUndefined();

    // touch 应该自动重建
    touchAgent(db, agentId);

    const revived = getAgent(db, agentId);
    expect(revived).not.toBeNull();
    expect(revived!.id).toBe(agentId);
    expect(revived!.tool_type).toBe('unknown');
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
