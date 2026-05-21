/**
 * tests/utils/json-safe.test.ts
 *
 * 覆盖 src/utils/json-safe.ts:
 *  - 合法 JSON 数组 → 原值
 *  - parse 失败 → []
 *  - 非数组(对象 / 字符串 / null) → []
 *  - null / undefined → []
 *
 * 风险点:旧代码到处 `JSON.parse(value).filter(...)`,假设 parse 一定是数组。
 * 切到 helper 之后必须保证语义一致(返回 array)且 log 出错误。
 */
import { describe, it, expect, vi } from 'vitest';
import { safeParseJsonArray } from '../../src/utils/json-safe.js';

function makeLog() {
  return { warn: vi.fn() };
}

describe('safeParseJsonArray', () => {
  it('合法 JSON 数组 → 原值', () => {
    const log = makeLog();
    const out = safeParseJsonArray<string>('["a","b","c"]', log, 'test');
    expect(out).toEqual(['a', 'b', 'c']);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('空数组 → []', () => {
    const log = makeLog();
    const out = safeParseJsonArray<string>('[]', log, 'test');
    expect(out).toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('JSON.parse 失败 → [] + log.warn', () => {
    const log = makeLog();
    const out = safeParseJsonArray<string>('{not valid json', log, 'demoted_tags');
    expect(out).toEqual([]);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toContain('demoted_tags');
    expect(log.warn.mock.calls[0][0]).toContain('JSON.parse 失败');
  });

  it('解析出来是对象(不是数组) → [] + log.warn', () => {
    const log = makeLog();
    const out = safeParseJsonArray<string>('{"foo":"bar"}', log, 'metadata');
    expect(out).toEqual([]);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toContain('不是数组');
  });

  it('解析出来是字符串 → [] + log.warn', () => {
    const log = makeLog();
    const out = safeParseJsonArray<string>('"just a string"', log, 'metadata');
    expect(out).toEqual([]);
    expect(log.warn).toHaveBeenCalled();
  });

  it('解析出来是 null → [] + log.warn (因 Array.isArray(null)=false)', () => {
    const log = makeLog();
    const out = safeParseJsonArray<string>('null', log, 'metadata');
    expect(out).toEqual([]);
    expect(log.warn).toHaveBeenCalled();
  });

  it('value 是 null / undefined → [],不打 warn(常见 row 不存在场景)', () => {
    const log = makeLog();
    expect(safeParseJsonArray<string>(null, log, 'x')).toEqual([]);
    expect(safeParseJsonArray<string>(undefined, log, 'x')).toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('数组里混杂 string / number / object → 返回原数组,调用方负责 filter', () => {
    const log = makeLog();
    const out = safeParseJsonArray<unknown>('["a", 1, {"k":"v"}, null]', log, 'mixed');
    expect(out).toHaveLength(4);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
