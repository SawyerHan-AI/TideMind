/**
 * apple-notes/database.ts 单元测试（纯函数部分）
 *
 * SQLite 查询相关的测试需要真实测试数据库，放到集成测试。
 */
import { describe, it, expect } from 'vitest';
import {
  coreDataToISO,
  coreDataToUnixMs,
  parseAccountsFromPath,
} from '../../../src/integrations/apple-notes/database.js';

describe('coreDataToISO', () => {
  it('Core Data epoch 0 → 2001-01-01', () => {
    const iso = coreDataToISO(0);
    expect(iso).toBe('2001-01-01T00:00:00.000Z');
  });

  it('正向时间戳正确转换', () => {
    // 1 小时 = 3600 秒
    const iso = coreDataToISO(3600);
    expect(iso).toBe('2001-01-01T01:00:00.000Z');
  });

  it('较大时间戳（2024 年）正确转换', () => {
    // 2024-01-01 00:00:00 UTC = 23 年 = 725846400 秒（大约，不含闰秒）
    const coreDataTs = (new Date('2024-01-01T00:00:00Z').getTime() / 1000) - 978307200;
    const iso = coreDataToISO(coreDataTs);
    expect(iso).toBe('2024-01-01T00:00:00.000Z');
  });
});

describe('coreDataToUnixMs', () => {
  it('0 → 978307200000（Unix 2001-01-01 毫秒）', () => {
    expect(coreDataToUnixMs(0)).toBe(978307200 * 1000);
  });

  it('与 Date.parse 结果一致', () => {
    const ms = coreDataToUnixMs(1000);
    const expected = new Date('2001-01-01T00:16:40.000Z').getTime();
    expect(ms).toBe(expected);
  });
});

describe('parseAccountsFromPath', () => {
  it('纯路径（无 query）→ accountZpks 为 undefined', () => {
    const result = parseAccountsFromPath('/path/to/NoteStore.sqlite');
    expect(result.dbPath).toBe('/path/to/NoteStore.sqlite');
    expect(result.accountZpks).toBeUndefined();
  });

  it('带 accounts 参数 → 解析为数字数组', () => {
    const result = parseAccountsFromPath('/path/to/NoteStore.sqlite?accounts=1,3,5');
    expect(result.dbPath).toBe('/path/to/NoteStore.sqlite');
    expect(result.accountZpks).toEqual([1, 3, 5]);
  });

  it('单个账户', () => {
    const result = parseAccountsFromPath('/path/to/db.sqlite?accounts=7');
    expect(result.accountZpks).toEqual([7]);
  });

  it('空 accounts 参数 → undefined（URLSearchParams 视为无值）', () => {
    const result = parseAccountsFromPath('/path/to/db.sqlite?accounts=');
    // accounts= 在 URLSearchParams 中 get 返回空串，实现中空串判定后回退到 undefined
    expect(result.accountZpks).toBeUndefined();
  });

  it('过滤无效数字', () => {
    const result = parseAccountsFromPath('/path/to/db.sqlite?accounts=1,abc,3');
    expect(result.accountZpks).toEqual([1, 3]);
  });

  it('带空格的路径', () => {
    const result = parseAccountsFromPath('/Users/me/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite?accounts=1');
    expect(result.dbPath).toContain('NoteStore.sqlite');
    expect(result.accountZpks).toEqual([1]);
  });
});
