/**
 * cloud outbox 单元测试
 *
 * 测试本地 outbox 队列的增删查功能。
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
import { setupTestDb } from '../helpers/test-db.js';
import {
  createOutboxTable,
  enqueueOutbox,
  getOutboxItems,
  removeOutboxItem,
  getOutboxCount,
} from '../../client/electron/cloud/outbox.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
  createOutboxTable(db);
});

// ===== createOutboxTable =====

describe('createOutboxTable', () => {
  it('should be idempotent', () => {
    // Already called in beforeEach; calling again should not throw
    expect(() => createOutboxTable(db)).not.toThrow();
  });
});

// ===== enqueueOutbox =====

describe('enqueueOutbox', () => {
  it('should insert an item and return its id', () => {
    const id = enqueueOutbox(db, 'node_create', { id: 'n1', content: 'hello' });
    expect(id).toBeTruthy();
    expect(typeof id).toBe('string');
  });

  it('should store the operation and payload', () => {
    const payload = { id: 'n1', type: 'fact', content: 'test' };
    enqueueOutbox(db, 'node_create', payload);

    const items = getOutboxItems(db);
    expect(items.length).toBe(1);
    expect(items[0].operation).toBe('node_create');
    expect(JSON.parse(items[0].payload)).toEqual(payload);
  });

  it('should store source when provided', () => {
    enqueueOutbox(db, 'node_update', { id: 'n2' }, 'device-abc');

    const items = getOutboxItems(db);
    expect(items[0].source).toBe('device-abc');
  });

  it('should set source to null when not provided', () => {
    enqueueOutbox(db, 'node_delete', { id: 'n3' });

    const items = getOutboxItems(db);
    expect(items[0].source).toBeNull();
  });

  it('should default retry_count to 0', () => {
    enqueueOutbox(db, 'link_create', { from: 'a', to: 'b' });

    const items = getOutboxItems(db);
    expect(items[0].retry_count).toBe(0);
  });
});

// ===== getOutboxItems =====

describe('getOutboxItems', () => {
  it('should return empty array when no items exist', () => {
    const items = getOutboxItems(db);
    expect(items).toEqual([]);
  });

  it('should return items in creation order (ASC)', () => {
    enqueueOutbox(db, 'op_first', { seq: 1 });
    enqueueOutbox(db, 'op_second', { seq: 2 });
    enqueueOutbox(db, 'op_third', { seq: 3 });

    const items = getOutboxItems(db);
    expect(items.length).toBe(3);
    expect(items[0].operation).toBe('op_first');
    expect(items[1].operation).toBe('op_second');
    expect(items[2].operation).toBe('op_third');
  });

  it('should respect limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      enqueueOutbox(db, `op_${i}`, { i });
    }

    const items = getOutboxItems(db, 3);
    expect(items.length).toBe(3);
    // Should be the first 3
    expect(items[0].operation).toBe('op_0');
  });
});

// ===== removeOutboxItem =====

describe('removeOutboxItem', () => {
  it('should remove a specific item by id', () => {
    const id1 = enqueueOutbox(db, 'op_a', { x: 1 });
    const id2 = enqueueOutbox(db, 'op_b', { x: 2 });

    removeOutboxItem(db, id1);

    const items = getOutboxItems(db);
    expect(items.length).toBe(1);
    expect(items[0].id).toBe(id2);
  });

  it('should not throw when removing nonexistent item', () => {
    expect(() => removeOutboxItem(db, 'nonexistent')).not.toThrow();
  });
});

// ===== getOutboxCount =====

describe('getOutboxCount', () => {
  it('should return 0 for empty outbox', () => {
    expect(getOutboxCount(db)).toBe(0);
  });

  it('should return correct count after enqueue and remove', () => {
    const id1 = enqueueOutbox(db, 'op1', {});
    enqueueOutbox(db, 'op2', {});
    enqueueOutbox(db, 'op3', {});
    expect(getOutboxCount(db)).toBe(3);

    removeOutboxItem(db, id1);
    expect(getOutboxCount(db)).toBe(2);
  });
});

// ===== 综合场景 =====

describe('outbox - integration scenarios', () => {
  it('should handle enqueue-process-remove cycle', () => {
    // Simulate: enqueue several items, process first batch, remove processed
    enqueueOutbox(db, 'node_create', { id: 'n1', content: 'hello' });
    enqueueOutbox(db, 'node_create', { id: 'n2', content: 'world' });
    enqueueOutbox(db, 'link_create', { from: 'n1', to: 'n2' });

    expect(getOutboxCount(db)).toBe(3);

    // Process first 2
    const batch = getOutboxItems(db, 2);
    expect(batch.length).toBe(2);

    for (const item of batch) {
      removeOutboxItem(db, item.id);
    }

    expect(getOutboxCount(db)).toBe(1);
    const remaining = getOutboxItems(db);
    expect(remaining[0].operation).toBe('link_create');
  });
});
