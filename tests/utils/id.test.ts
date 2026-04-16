/**
 * utils/id.ts 单元测试
 *
 * 验证 generateId() 基于 nanoid(21) 的行为：长度、唯一性、字符集。
 */
import { describe, it, expect } from 'vitest';
import { generateId } from '../../src/utils/id.js';

describe('generateId', () => {
  it('返回长度为 21 的字符串', () => {
    const id = generateId();
    expect(typeof id).toBe('string');
    expect(id).toHaveLength(21);
  });

  it('生成 10000 个 ID 全部唯一', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      ids.add(generateId());
    }
    expect(ids.size).toBe(10_000);
  });

  it('仅包含 URL 安全字符（nanoid 默认字母表 A-Za-z0-9_-）', () => {
    const urlSafePattern = /^[A-Za-z0-9_-]+$/;
    for (let i = 0; i < 100; i++) {
      const id = generateId();
      expect(id).toMatch(urlSafePattern);
    }
  });

  it('快速连续调用不会碰撞', () => {
    const ids = Array.from({ length: 1000 }, () => generateId());
    const unique = new Set(ids);
    expect(unique.size).toBe(1000);
  });
});
