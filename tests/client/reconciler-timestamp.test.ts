/**
 * Reconciler 时间戳规范化测试
 *
 * 背景:客户端 SQLite 和云端 PG 对 updated 字段的字符串格式不同,
 * 老版本直接字符串相等比较会把所有行判为冲突,触发双向全量传输。
 * v0.2.13 新增 normalizeTs + timestampsEqual 做格式无关的比较。
 */

import { describe, it, expect } from 'vitest';
import { normalizeTs, timestampsEqual } from '../../client/electron/cloud/reconciler.js';

describe('normalizeTs', () => {
  it('解析 SQLite datetime(no T, no TZ, UTC)', () => {
    const t = normalizeTs('2026-04-20 10:30:00');
    expect(t).toBe(new Date('2026-04-20T10:30:00Z').getTime());
  });

  it('解析 PG ISO 带毫秒带 +00:00', () => {
    const t = normalizeTs('2026-04-20T10:30:00.123+00:00');
    expect(t).toBe(new Date('2026-04-20T10:30:00.123Z').getTime());
  });

  it('解析 JS toISOString (带 Z)', () => {
    const t = normalizeTs('2026-04-20T10:30:00.456Z');
    expect(t).toBe(new Date('2026-04-20T10:30:00.456Z').getTime());
  });

  it('解析 SQLite datetime 带毫秒', () => {
    const t = normalizeTs('2026-04-20 10:30:00.789');
    expect(t).toBe(new Date('2026-04-20T10:30:00.789Z').getTime());
  });

  it('无效输入返回 0', () => {
    expect(normalizeTs(null)).toBe(0);
    expect(normalizeTs(undefined)).toBe(0);
    expect(normalizeTs('')).toBe(0);
    expect(normalizeTs('   ')).toBe(0);
    expect(normalizeTs('not-a-date')).toBe(0);
  });
});

describe('timestampsEqual', () => {
  it('同一时刻的三种格式判为相等', () => {
    expect(timestampsEqual(
      '2026-04-20 10:30:00',           // SQLite 无 ms
      '2026-04-20T10:30:00.000+00:00', // PG 带 ms
    )).toBe(true);

    expect(timestampsEqual(
      '2026-04-20 10:30:00.123',
      '2026-04-20T10:30:00.123Z',
    )).toBe(true);
  });

  it('相差毫秒级抖动判为相等(1s 容差内)', () => {
    expect(timestampsEqual(
      '2026-04-20T10:30:00.100Z',
      '2026-04-20T10:30:00.900Z',
    )).toBe(true);
  });

  it('相差超 1 秒判为不等', () => {
    expect(timestampsEqual(
      '2026-04-20T10:30:00.000Z',
      '2026-04-20T10:30:02.000Z',
    )).toBe(false);
  });

  it('两边都空视为相等(避免空字段引发假冲突)', () => {
    expect(timestampsEqual(null, null)).toBe(true);
    expect(timestampsEqual('', undefined)).toBe(true);
  });

  it('一边空一边有值判为不等', () => {
    expect(timestampsEqual(null, '2026-04-20T10:30:00Z')).toBe(false);
    expect(timestampsEqual('2026-04-20 10:30:00', undefined)).toBe(false);
  });
});
