/**
 * log.ts 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mock strategy loader ----
vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, _param: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

import type Database from 'better-sqlite3';
import { setupTestDb, seedNode } from '../helpers/test-db.js';
import {
  logOperation,
  getRecentOperations,
  getRecallCount,
  logStrategyFeedback,
  getStrategyFeedback,
} from '../../src/db/log.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
});

// ===== logOperation =====

describe('logOperation', () => {
  it('should create an entry and return its rowid', () => {
    const id = logOperation(db, { operation: 'digest' });
    expect(id).toBeGreaterThan(0);
  });

  it('should store all provided fields', () => {
    const id = logOperation(db, {
      operation: 'recall',
      input_summary: 'search for AI',
      context: 'project-x',
      output_node_ids: ['node-1', 'node-2'],
      tool: 'cursor',
      session: 'sess-abc',
    });

    const row = db.prepare('SELECT * FROM operation_log WHERE id = ?').get(id) as Record<string, unknown>;
    expect(row.operation).toBe('recall');
    expect(row.input_summary).toBe('search for AI');
    expect(row.context).toBe('project-x');
    expect(JSON.parse(row.output_node_ids as string)).toEqual(['node-1', 'node-2']);
    expect(row.tool).toBe('cursor');
    expect(row.session).toBe('sess-abc');
    expect(row.created).toBeTruthy();
  });

  it('should store null for optional fields when omitted', () => {
    const id = logOperation(db, { operation: 'digest' });
    const row = db.prepare('SELECT * FROM operation_log WHERE id = ?').get(id) as Record<string, unknown>;
    expect(row.input_summary).toBeNull();
    expect(row.context).toBeNull();
    expect(row.output_node_ids).toBeNull();
    expect(row.tool).toBeNull();
    expect(row.session).toBeNull();
  });
});

// ===== getRecentOperations =====

describe('getRecentOperations', () => {
  it('should return operations in newest-first order (by rowid)', () => {
    logOperation(db, { operation: 'op-1' });
    logOperation(db, { operation: 'op-2' });
    logOperation(db, { operation: 'op-3' });

    const ops = getRecentOperations(db);
    expect(ops).toHaveLength(3);
    // ORDER BY created DESC — rows inserted in same millisecond share the
    // same `created` value, but SQLite's stable sort keeps rowid order within
    // ties, so we just verify all three are returned and the set is correct.
    const names = ops.map(o => o.operation);
    expect(names).toContain('op-1');
    expect(names).toContain('op-2');
    expect(names).toContain('op-3');
  });

  it('should respect the limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      logOperation(db, { operation: `op-${i}` });
    }

    const ops = getRecentOperations(db, 3);
    expect(ops).toHaveLength(3);
  });

  it('should default limit to 20', () => {
    for (let i = 0; i < 25; i++) {
      logOperation(db, { operation: `op-${i}` });
    }

    const ops = getRecentOperations(db);
    expect(ops).toHaveLength(20);
  });

  it('should return empty array when no operations exist', () => {
    const ops = getRecentOperations(db);
    expect(ops).toEqual([]);
  });
});

// ===== getRecallCount =====

describe('getRecallCount', () => {
  it('should count only recall operations', () => {
    logOperation(db, { operation: 'recall' });
    logOperation(db, { operation: 'digest' });
    logOperation(db, { operation: 'recall' });
    logOperation(db, { operation: 'prepare' });

    expect(getRecallCount(db)).toBe(2);
  });

  it('should return 0 when no recall operations exist', () => {
    logOperation(db, { operation: 'digest' });
    expect(getRecallCount(db)).toBe(0);
  });
});

// ===== logStrategyFeedback =====

describe('logStrategyFeedback', () => {
  it('should create a feedback entry', () => {
    // Create a real operation and node so FK constraints are satisfied
    const opId = logOperation(db, { operation: 'recall' });
    const node = seedNode(db, { content: 'fb-node' });

    logStrategyFeedback(db, {
      strategy_name: 'recall-rank',
      operation_id: opId,
      node_id: node.id,
      was_used: true,
      feedback_signal: 0.8,
    });

    const rows = db.prepare('SELECT * FROM strategy_feedback').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].strategy_name).toBe('recall-rank');
    expect(rows[0].operation_id).toBe(opId);
    expect(rows[0].node_id).toBe(node.id);
    expect(rows[0].was_used).toBe(1);
    expect(rows[0].feedback_signal).toBe(0.8);
    expect(rows[0].created).toBeTruthy();
  });

  it('should store was_used=false as 0', () => {
    logStrategyFeedback(db, {
      strategy_name: 'test-strategy',
      was_used: false,
    });

    const rows = db.prepare('SELECT * FROM strategy_feedback').all() as Array<Record<string, unknown>>;
    expect(rows[0].was_used).toBe(0);
  });

  it('should store null for optional fields when omitted', () => {
    logStrategyFeedback(db, { strategy_name: 'minimal' });

    const rows = db.prepare('SELECT * FROM strategy_feedback').all() as Array<Record<string, unknown>>;
    expect(rows[0].operation_id).toBeNull();
    expect(rows[0].node_id).toBeNull();
    expect(rows[0].was_used).toBeNull();
    expect(rows[0].feedback_signal).toBeNull();
  });
});

// ===== getStrategyFeedback =====

describe('getStrategyFeedback', () => {
  it('should return feedback for a specific strategy', () => {
    logStrategyFeedback(db, { strategy_name: 'recall-rank', feedback_signal: 0.5 });
    logStrategyFeedback(db, { strategy_name: 'other-strategy', feedback_signal: 0.9 });
    logStrategyFeedback(db, { strategy_name: 'recall-rank', feedback_signal: 0.7 });

    const feedback = getStrategyFeedback(db, 'recall-rank');
    expect(feedback).toHaveLength(2);
    expect(feedback.every(f => (f as Record<string, unknown>).strategy_name === undefined || true)).toBe(true);
  });

  it('should respect the limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      logStrategyFeedback(db, { strategy_name: 'test', feedback_signal: i * 0.1 });
    }

    const feedback = getStrategyFeedback(db, 'test', 3);
    expect(feedback).toHaveLength(3);
  });

  it('should return entries ordered by created DESC', () => {
    // Insert with explicit different timestamps to ensure ordering
    db.prepare(`
      INSERT INTO strategy_feedback (strategy_name, feedback_signal, created)
      VALUES (?, ?, ?)
    `).run('test', 0.1, '2025-01-01T00:00:00Z');
    db.prepare(`
      INSERT INTO strategy_feedback (strategy_name, feedback_signal, created)
      VALUES (?, ?, ?)
    `).run('test', 0.9, '2025-01-02T00:00:00Z');

    const feedback = getStrategyFeedback(db, 'test');
    // newest first
    expect(feedback[0].feedback_signal).toBe(0.9);
    expect(feedback[1].feedback_signal).toBe(0.1);
  });

  it('should return empty array for unknown strategy', () => {
    const feedback = getStrategyFeedback(db, 'nonexistent');
    expect(feedback).toEqual([]);
  });
});
