/**
 * compareSemver 单元测试。
 *
 * Round 3 修复时把 cloud-server/src/update/routes.ts:compareVersions 解决了
 * 0.2.x-beta.N 等 prerelease 排序错误,但没有专门的回归测试。本次抽到
 * src/utils/semver-compare.ts 共享给客户端 verifier downgrade guard 用,补齐
 * 覆盖。
 *
 * 重点 case:
 *   - core 大小比较
 *   - prerelease vs 无 prerelease(1.0.0-beta < 1.0.0)
 *   - 数字段 vs 字母段(beta.10 > beta.2 但 beta > 10 因为数字 < 字母)
 *   - build metadata 被忽略(1.0.0+abc == 1.0.0)
 *   - 边界:全 0 / 半写 "1.0" / 带 v 前缀
 */
import { describe, it, expect } from 'vitest';
import { compareSemver } from '../../src/utils/semver-compare.js';

describe('compareSemver', () => {
  it('core 不等 → 按数字大小', () => {
    expect(compareSemver('1.0.0', '2.0.0')).toBeLessThan(0);
    expect(compareSemver('2.0.0', '1.0.0')).toBeGreaterThan(0);
    expect(compareSemver('1.2.0', '1.10.0')).toBeLessThan(0);
    expect(compareSemver('0.2.65', '0.2.68')).toBeLessThan(0);
  });

  it('core 相等', () => {
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
  });

  it('prerelease vs 正式版:正式版更大', () => {
    expect(compareSemver('1.0.0-beta', '1.0.0')).toBeLessThan(0);
    expect(compareSemver('1.0.0', '1.0.0-beta')).toBeGreaterThan(0);
    expect(compareSemver('0.2.69-beta.1', '0.2.69')).toBeLessThan(0);
  });

  it('两边都 prerelease:按段比较', () => {
    expect(compareSemver('1.0.0-beta.1', '1.0.0-beta.2')).toBeLessThan(0);
    expect(compareSemver('1.0.0-beta.2', '1.0.0-beta.10')).toBeLessThan(0); // 数字段按数字
    expect(compareSemver('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0); // 字母段按字典
    expect(compareSemver('1.0.0-alpha.1', '1.0.0-alpha.beta')).toBeLessThan(0); // 数字段 < 字母段
  });

  it('build metadata 被忽略', () => {
    expect(compareSemver('1.0.0+sha1', '1.0.0+sha2')).toBe(0);
    expect(compareSemver('1.0.0+sha1', '1.0.0')).toBe(0);
  });

  it('v 前缀被剥离', () => {
    expect(compareSemver('v1.0.0', '1.0.0')).toBe(0);
    expect(compareSemver('v2.0.0', 'v1.0.0')).toBeGreaterThan(0);
  });

  it('半写版本号兜底:1.0 → 1.0.0', () => {
    expect(compareSemver('1.0', '1.0.0')).toBe(0);
    expect(compareSemver('1', '1.0.0')).toBe(0);
  });

  it('短 prerelease 段 < 长 prerelease 段', () => {
    expect(compareSemver('1.0.0-beta', '1.0.0-beta.1')).toBeLessThan(0);
  });

  it('downgrade guard 场景:服务端下发的版本不大于本地 → 返回 ≤ 0', () => {
    // 我在 0.2.68,服务端说 latest 是 0.2.67(被入侵 / 缓存污染)
    expect(compareSemver('0.2.67', '0.2.68')).toBeLessThan(0);
    // 我在 0.2.68,服务端说 latest 是 0.2.68(无更新)
    expect(compareSemver('0.2.68', '0.2.68')).toBe(0);
  });
});
