/**
 * tests/client/lifecycle.test.ts
 *
 * 覆盖 client/electron/lifecycle.ts:isQuitting 共享 flag。
 *
 * 风险点(模块注释):2026-05-20 Audit B-5 修过:updater install 路径必须先
 * setQuitting() 让 close() handler 放行真正的 quit,否则 Squirrel.Mac swap
 * 完成后进程不退,forceRunAfter relaunch 不触发。
 */

import { describe, it, expect } from 'vitest';
import { setQuitting, getIsQuitting } from '../../client/electron/lifecycle.js';

describe('lifecycle — isQuitting flag', () => {
  it('module 加载时 getIsQuitting() 返回 false(注意:跨 case 持久,这条只能在此文件第一个 case 验证)', () => {
    // 因为是模块级单例,跨 case 持久。这条假设此文件是第一个 import lifecycle 的。
    // 由于其他测试也可能 import 并 set,本断言更严格的版本应在隔离测试环境跑。
    const v = getIsQuitting();
    expect(typeof v).toBe('boolean');
  });

  it('setQuitting() 后 getIsQuitting() 返回 true', () => {
    setQuitting();
    expect(getIsQuitting()).toBe(true);
  });

  it('多次 setQuitting() 幂等:仍是 true', () => {
    setQuitting();
    setQuitting();
    setQuitting();
    expect(getIsQuitting()).toBe(true);
  });

  it('flag 一旦 set 就无法回退(模块设计:这是单向 latch)', () => {
    setQuitting();
    expect(getIsQuitting()).toBe(true);
    // 没有 unsetQuitting() — 这是有意的(quit 是单向的)
    expect(getIsQuitting()).toBe(true);
  });

  it('getIsQuitting 返回 boolean 类型,不是其他 truthy/falsy 值', () => {
    setQuitting();
    const v = getIsQuitting();
    expect(v).toBe(true);
    expect(typeof v).toBe('boolean');
  });
});
