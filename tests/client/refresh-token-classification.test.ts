/**
 * refreshTokenIfNeeded 错误分类测试
 *
 * 背景:老版本任何非 2xx 都 cachedAuth = null,网络抖动也让用户"无声登出"。
 * v0.2.13 修正:
 *  - 400 / 401 / 403 = 永久失败,清除登录态,返回 null
 *  - 5xx / 网络错误 = 临时失败,保留登录态,抛异常
 */

import { describe, it, expect } from 'vitest';

/** 复刻 refreshTokenIfNeeded 的分类逻辑(纯函数部分) */
function classifyRefreshResult(args: {
  networkError: boolean;
  status?: number;
}): 'ok' | 'permanent' | 'transient' {
  if (args.networkError) return 'transient';
  const s = args.status ?? 0;
  if (s >= 200 && s < 300) return 'ok';
  if (s === 400 || s === 401 || s === 403) return 'permanent';
  return 'transient';
}

describe('refresh token error classification', () => {
  it('200 返回 ok', () => {
    expect(classifyRefreshResult({ networkError: false, status: 200 })).toBe('ok');
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

  it('其他 4xx(408 timeout / 429 rate limit)= transient,不应清登录态', () => {
    expect(classifyRefreshResult({ networkError: false, status: 408 })).toBe('transient');
    expect(classifyRefreshResult({ networkError: false, status: 429 })).toBe('transient');
  });
});
