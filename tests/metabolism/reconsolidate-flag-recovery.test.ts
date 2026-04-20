/**
 * reconsolidateInFlight 崩溃恢复测试
 *
 * 背景:模块级 bool flag 在同步异常路径不复位,导致本进程所有后续 recall
 * 永远跳过深度/感知读,必须重启 daemon。
 * v0.2.15 在函数外层包 try/catch/finally,任何同步异常都复位 flag。
 *
 * 这里用最小 mock 验证 flag 复位行为(纯控制流,不依赖 DB/LLM)。
 */

import { describe, it, expect, beforeEach } from 'vitest';

// 复刻 flag 管理逻辑 - 不 import 真实模块避免 LLM / DB 依赖
class FlagController {
  inFlight = false;
  callCount = 0;

  run(syncThrows: boolean, spawnAsync: boolean): Promise<void> {
    if (this.inFlight) return Promise.resolve();
    this.inFlight = true;
    this.callCount++;

    let spawnedAsync = false;
    try {
      if (syncThrows) throw new Error('sync path exploded');
      if (spawnAsync) {
        spawnedAsync = true;
        // 模拟 async IIFE 5ms 后完成
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            this.inFlight = false;
            resolve();
          }, 5);
        });
      }
    } catch (err) {
      this.inFlight = false;
      throw err;
    } finally {
      if (!spawnedAsync) this.inFlight = false;
    }
    return Promise.resolve();
  }
}

describe('reconsolidateInFlight crash recovery', () => {
  let ctrl: FlagController;

  beforeEach(() => {
    ctrl = new FlagController();
  });

  it('正常完成同步路径后 flag 复位', async () => {
    await ctrl.run(false, false);
    expect(ctrl.inFlight).toBe(false);
    // 下次可以再进入
    await ctrl.run(false, false);
    expect(ctrl.callCount).toBe(2);
  });

  it('同步异常也复位 flag(核心 bug 修复)', async () => {
    // run() 同步路径 throw,用 try/catch 捕获,验证 flag 已复位
    let caught: Error | null = null;
    try {
      await ctrl.run(true, false);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught?.message).toBe('sync path exploded');
    expect(ctrl.inFlight).toBe(false);
    // 崩溃后下次仍能进入
    await ctrl.run(false, false);
    expect(ctrl.callCount).toBe(2);
  });

  it('异步路径:同步返回后 flag 仍 true,等 async 完成才复位', async () => {
    const promise = ctrl.run(false, true);
    // 此时 flag 应该是 true
    expect(ctrl.inFlight).toBe(true);
    await promise;
    expect(ctrl.inFlight).toBe(false);
  });

  it('flag 占用时重入立刻 return,不重复执行', async () => {
    const p1 = ctrl.run(false, true);  // 异步进行中
    await ctrl.run(false, true);       // 被 flag 拦截
    await p1;
    expect(ctrl.callCount).toBe(1); // 第二次没进入
  });
});
