/**
 * Outbox dead-letter 逻辑测试
 *
 * 背景:老版本 pushOutbox 一旦某条 item 脏数据(如 server 422)就
 * 永久卡住后续 push。v0.2.13 引入 retry_count + OUTBOX_MAX_RETRIES,
 * 超过阈值后搬到 local_outbox_dead 表,让队列继续推进。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  createOutboxTable,
  enqueueOutbox,
  getOutboxItems,
  markOutboxFailed,
  getOutboxCount,
  getDeadLetterCount,
  OUTBOX_MAX_RETRIES,
} from '../../client/electron/cloud/outbox.js';

describe('outbox dead-letter', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    createOutboxTable(db);
  });

  it('enqueue 后 retry_count=0, last_error=null', () => {
    const id = enqueueOutbox(db, 'digest', { content: 'hi' });
    const [item] = getOutboxItems(db, 10);
    expect(item.id).toBe(id);
    expect(item.retry_count).toBe(0);
    expect(item.last_error).toBeNull();
  });

  it('markOutboxFailed 递增 retry_count 且不 dead-letter', () => {
    const id = enqueueOutbox(db, 'digest', { content: 'hi' });
    const r1 = markOutboxFailed(db, id, 'first fail');
    expect(r1.deadLettered).toBe(false);
    expect(getOutboxCount(db)).toBe(1);
    expect(getDeadLetterCount(db)).toBe(0);

    const [item] = getOutboxItems(db, 10);
    expect(item.retry_count).toBe(1);
    expect(item.last_error).toBe('first fail');
  });

  it(`连续 ${OUTBOX_MAX_RETRIES} 次失败后进入 dead-letter`, () => {
    const id = enqueueOutbox(db, 'digest', { content: 'poison' });

    for (let i = 0; i < OUTBOX_MAX_RETRIES - 1; i++) {
      const r = markOutboxFailed(db, id, `fail ${i}`);
      expect(r.deadLettered).toBe(false);
    }

    // 最后一次触发 dead-letter
    const rFinal = markOutboxFailed(db, id, 'final');
    expect(rFinal.deadLettered).toBe(true);

    expect(getOutboxCount(db)).toBe(0);       // 主表移除
    expect(getDeadLetterCount(db)).toBe(1);   // 死信表 +1
  });

  it('dead-letter 保留 payload 和失败次数', () => {
    const id = enqueueOutbox(db, 'digest', { content: 'x' }, 'mcp');
    for (let i = 0; i < OUTBOX_MAX_RETRIES; i++) {
      markOutboxFailed(db, id, 'repeating failure');
    }
    const dead = db.prepare('SELECT * FROM local_outbox_dead').get() as {
      id: string;
      operation: string;
      payload: string;
      source: string;
      retry_count: number;
      last_error: string;
    };
    expect(dead.id).toBe(id);
    expect(dead.operation).toBe('digest');
    expect(JSON.parse(dead.payload)).toEqual({ content: 'x' });
    expect(dead.source).toBe('mcp');
    expect(dead.retry_count).toBe(OUTBOX_MAX_RETRIES);
    expect(dead.last_error).toBe('repeating failure');
  });

  it('不存在的 id 不报错,返回 deadLettered=false', () => {
    const r = markOutboxFailed(db, 'nonexistent-id', 'err');
    expect(r.deadLettered).toBe(false);
  });

  it('error 字符串超 500 字符会被截断', () => {
    const id = enqueueOutbox(db, 'digest', {});
    const longErr = 'x'.repeat(2000);
    markOutboxFailed(db, id, longErr);
    const [item] = getOutboxItems(db, 10);
    expect(item.last_error).toHaveLength(500);
  });

  it('老库 ALTER TABLE 加 last_error 列(migration 幂等)', () => {
    const db2 = new Database(':memory:');
    // 模拟老库:没有 last_error 列
    db2.exec(`CREATE TABLE local_outbox (
      id TEXT PRIMARY KEY,
      operation TEXT NOT NULL,
      payload TEXT NOT NULL,
      source TEXT,
      created TEXT NOT NULL DEFAULT (datetime('now')),
      retry_count INTEGER DEFAULT 0
    )`);
    db2.prepare('INSERT INTO local_outbox (id, operation, payload) VALUES (?, ?, ?)').run('old', 'digest', '{}');

    // createOutboxTable 必须把 last_error 补上,不能丢数据
    createOutboxTable(db2);

    const cols = db2.prepare(`PRAGMA table_info(local_outbox)`).all() as Array<{ name: string }>;
    expect(cols.some(c => c.name === 'last_error')).toBe(true);

    const [item] = db2.prepare('SELECT * FROM local_outbox').all() as Array<{ id: string }>;
    expect(item.id).toBe('old'); // 老数据保留
  });
});
