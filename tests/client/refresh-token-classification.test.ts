/**
 * refreshTokenIfNeeded 错误分类测试
 *
 * 背景:老版本任何非 2xx 都 cachedAuth = null,网络抖动也让用户"无声登出"。
 * v0.2.13 修正:
 *  - 400 / 401 / 403 = 永久失败,清除登录态,返回 null
 *  - 5xx / 网络错误 = 临时失败,保留登录态,抛异常
 *
 * 历史(2026-05-19 audit):本文件曾 inline 复刻 classifyRefreshResult 函数,
 * 与源代码的内联 if-else 完全独立(参见 docs/design/test-coverage-plan-2026-05-20.md §1.1 #4)。
 * 已将真源抽出为 export `classifyRefreshResult` + refreshTokenIfNeeded 内部走该函数,
 * 测试直接 import 真源。
 */

import { describe, it, expect, vi } from 'vitest';

// auth-client.ts 顶层 import 了 'electron',测试环境需要 mock
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: vi.fn(() => Buffer.alloc(0)),
    decryptString: vi.fn(() => ''),
  },
}));

import { classifyRefreshResult } from '../../client/electron/cloud/auth-client.js';

describe('classifyRefreshResult (refresh token error classification)', () => {
  it('200 返回 ok', () => {
    expect(classifyRefreshResult({ networkError: false, status: 200 })).toBe('ok');
  });

  it('全范围 2xx 都视为 ok', () => {
    expect(classifyRefreshResult({ networkError: false, status: 201 })).toBe('ok');
    expect(classifyRefreshResult({ networkError: false, status: 299 })).toBe('ok');
  });

  it('400 / 401 / 403 = permanent(真正凭据失效,需要重登)', () => {
    expect(classifyRefreshResult({ networkError: false, status: 400 })).toBe('permanent');
    expect(classifyRefreshResult({ networkError: false, status: 401 })).toBe('permanent');
    expect(classifyRefreshResult({ networkError: false, status: 403 })).toBe('permanent');
  });

  it('5xx = transient(服务器波动,保留登录态)', () => {
    expect(classifyRefreshResult({ networkError: false, status: 500 })).toBe('transient');
    expect(classifyRefreshResult({ networkError: false, status: 502 })).toBe('transient');
    expect(classifyRefreshResult({ networkError: false, status: 503 })).toBe('transient');
    expect(classifyRefreshResult({ networkError: false, status: 504 })).toBe('transient');
  });

  it('网络错误 = transient', () => {
    expect(classifyRefreshResult({ networkError: true })).toBe('transient');
  });

  // 网络错误优先级最高:即便提供了 status 也应分类为 transient
  it('网络错误 + 任何 status = transient(networkError 优先)', () => {
    expect(classifyRefreshResult({ networkError: true, status: 200 })).toBe('transient');
    expect(classifyRefreshResult({ networkError: true, status: 401 })).toBe('transient');
    expect(classifyRefreshResult({ networkError: true, status: 500 })).toBe('transient');
  });

  it('其他 4xx(408 timeout / 429 rate limit)= transient,不应清登录态', () => {
    expect(classifyRefreshResult({ networkError: false, status: 408 })).toBe('transient');
    expect(classifyRefreshResult({ networkError: false, status: 429 })).toBe('transient');
  });

  // 404 / 405 / 422 也是非 400/401/403,应保留登录态(服务端临时配置错误等)
  it('404 / 405 / 422 = transient(非凭据失效,保留登录态)', () => {
    expect(classifyRefreshResult({ networkError: false, status: 404 })).toBe('transient');
    expect(classifyRefreshResult({ networkError: false, status: 405 })).toBe('transient');
    expect(classifyRefreshResult({ networkError: false, status: 422 })).toBe('transient');
  });

  it('status undefined / 0 = transient(unknown 默认保留登录态)', () => {
    expect(classifyRefreshResult({ networkError: false })).toBe('transient');
    expect(classifyRefreshResult({ networkError: false, status: 0 })).toBe('transient');
  });
});
