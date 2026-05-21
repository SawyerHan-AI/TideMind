/**
 * reconsolidate in-flight 并发控制 + 异常恢复测试
 *
 * 历史(2026-05-19 audit):本文件曾用 `class FlagController` inline 复刻一份
 * 单 boolean flag 的控制流(旧 reconsolidateInFlight 实现)。但生产代码早就改成
 * `Set<string>` 按 node id 去重 + 全局上限 5 的方案,inline 复刻已严重漂移(参见
 * docs/design/test-coverage-plan-2026-05-20.md §1.1 #2)。
 *
 * 改造:直接 import 真源的 `__testing` 辅助函数,验证 Set + 上限 + claim/release
 * 语义。这套语义才是 reconsolidateOnRecall 真正用的。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { __testing } from '../../src/metabolism/reconsolidate.js';

describe('reconsolidate inFlightNodes (Set-based concurrency control)', () => {
  beforeEach(() => {
    __testing.resetInFlight();
  });

  it('claim 后 size 增加,release 后归零', () => {
    expect(__testing.getInFlightSize()).toBe(0);
    const { claimed, release } = __testing.simulateClaim(['n1', 'n2', 'n3']);
    expect(claimed).toEqual(['n1', 'n2', 'n3']);
    expect(__testing.getInFlightSize()).toBe(3);
    expect(__testing.hasInFlight('n1')).toBe(true);
    expect(__testing.hasInFlight('n3')).toBe(true);
    release();
    expect(__testing.getInFlightSize()).toBe(0);
    expect(__testing.hasInFlight('n1')).toBe(false);
  });

  it('同一 node id 不重复占名额(去重语义)', () => {
    const a = __testing.simulateClaim(['n1', 'n2']);
    expect(a.claimed).toEqual(['n1', 'n2']);
    // 再 claim 已存在的 id:不应再占
    const b = __testing.simulateClaim(['n1', 'n3']);
    expect(b.claimed).toEqual(['n3']); // n1 被跳过
    expect(__testing.getInFlightSize()).toBe(3);
  });

  it('达到 MAX_CONCURRENT 上限后新 claim 拒绝', () => {
    const max = __testing.maxConcurrent;
    expect(max).toBeGreaterThan(0);
    const ids = Array.from({ length: max }, (_, i) => `node-${i}`);
    const first = __testing.simulateClaim(ids);
    expect(first.claimed.length).toBe(max);
    expect(__testing.getInFlightSize()).toBe(max);

    // 再 claim:上限已满,拒绝
    const overflow = __testing.simulateClaim(['extra-1', 'extra-2']);
    expect(overflow.claimed).toEqual([]);
    expect(__testing.getInFlightSize()).toBe(max);
  });

  it('部分填满后 claim 只接受可容纳数量', () => {
    const max = __testing.maxConcurrent;
    // 先占 max - 1 个名额
    const initial = Array.from({ length: max - 1 }, (_, i) => `init-${i}`);
    __testing.simulateClaim(initial);
    expect(__testing.getInFlightSize()).toBe(max - 1);

    // 试 claim 5 个,只允许 1 个进
    const next = __testing.simulateClaim(['a', 'b', 'c', 'd', 'e']);
    expect(next.claimed.length).toBe(1);
    expect(__testing.getInFlightSize()).toBe(max);
  });

  it('release 后名额回收,可重新 claim', () => {
    const max = __testing.maxConcurrent;
    const ids = Array.from({ length: max }, (_, i) => `n${i}`);
    const a = __testing.simulateClaim(ids);
    expect(__testing.getInFlightSize()).toBe(max);

    a.release();
    expect(__testing.getInFlightSize()).toBe(0);

    // 释放后可以重新 claim 同样的 id
    const b = __testing.simulateClaim(ids);
    expect(b.claimed.length).toBe(max);
  });

  it('resetInFlight() 是测试 hook,强制清空所有占用(模拟崩溃恢复)', () => {
    __testing.simulateClaim(['leak-1', 'leak-2', 'leak-3']);
    expect(__testing.getInFlightSize()).toBe(3);

    // 模拟"异常退出但 finally 没跑到 release":手动 reset 模拟下次启动
    __testing.resetInFlight();
    expect(__testing.getInFlightSize()).toBe(0);

    // 重置后可以正常使用
    const fresh = __testing.simulateClaim(['fresh-1']);
    expect(fresh.claimed).toEqual(['fresh-1']);
  });
});
