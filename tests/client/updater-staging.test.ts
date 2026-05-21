/**
 * tests/client/updater-staging.test.ts
 *
 * 覆盖 client/electron/updater/staging.ts。该模块只 export 一个函数
 * `isInStagingBatch(percentage, dataDir)`,职责是基于持久化 client-id
 * 的 sha256 哈希取模 100 与 percentage 比较,判断当前客户端是否在灰度批次。
 *
 * 关键规约(staging.ts 注释):
 *  - percentage == null → true (P0 端点没返回 percentage,全量放行)
 *  - percentage >= 100 → true
 *  - percentage <= 0 → false
 *  - 同一 client-id + 同一 percentage 结果稳定不横跳
 *  - 不同 client-id 在 [0,100) percentage 上大致均匀分布
 *
 * 风险点:
 *  - hash bucket 公式不能因为重构悄悄改变,否则一个用户可能在 percentage=50 时
 *    瞬间从"在批次"翻到"不在批次",beta 体验断裂
 *  - client-id 文件读失败不能让 staging 抛错(否则更新流程中断)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isInStagingBatch } from '../../client/electron/updater/staging.js';

function makeTmpDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-staging-test-'));
  return dir;
}

function writeClientId(dataDir: string, id: string): void {
  fs.writeFileSync(path.join(dataDir, '.client-id'), id, 'utf-8');
}

describe('updater staging — isInStagingBatch', () => {
  // 多个分布检查跑 500-1000 次真实 tmpdir 创建/写/删循环(重 I/O)。5s 默认 timeout
  // 在 vitest 并行 + 发版机器负载下太紧会偶发超时(v0.2.74 OSS 发版踩到 → 加到 30s,
  // v0.2.75 OSS 发版 percentage=10 那个又超 30s → 加到 60s)。
  // 这些断言是统计/确定性的(不依赖时间),只是循环本身慢,给足 timeout 余量即可。
  vi.setConfig({ testTimeout: 60_000 });

  let dataDir: string;

  beforeEach(() => {
    dataDir = makeTmpDataDir();
  });

  afterEach(() => {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    vi.restoreAllMocks();
  });

  it('percentage == null 时全量放行', () => {
    writeClientId(dataDir, 'any-id');
    expect(isInStagingBatch(null, dataDir)).toBe(true);
    expect(isInStagingBatch(undefined, dataDir)).toBe(true);
  });

  it('percentage >= 100 时全量放行', () => {
    writeClientId(dataDir, 'any-id');
    expect(isInStagingBatch(100, dataDir)).toBe(true);
    expect(isInStagingBatch(101, dataDir)).toBe(true);
    expect(isInStagingBatch(1000, dataDir)).toBe(true);
  });

  it('percentage <= 0 时全量拒绝', () => {
    writeClientId(dataDir, 'any-id');
    expect(isInStagingBatch(0, dataDir)).toBe(false);
    expect(isInStagingBatch(-1, dataDir)).toBe(false);
    expect(isInStagingBatch(-100, dataDir)).toBe(false);
  });

  it('同一 client-id + 同一 percentage 多次调用结果稳定', () => {
    writeClientId(dataDir, 'stable-id-abc');
    const first = isInStagingBatch(50, dataDir);
    for (let i = 0; i < 10; i++) {
      expect(isInStagingBatch(50, dataDir)).toBe(first);
    }
  });

  it('hash bucket 公式可被独立验证(回归保护)', () => {
    // 这里写死期望值——若公式被改(sha256 → md5、readUInt32BE → LE、% 100 → % 50)
    // 这个测试会立刻 fail。期望值由当前 staging.ts 公式计算得出。
    const id = 'fixed-test-id-2026';
    writeClientId(dataDir, id);

    // 期望 bucket 与下面手算一致
    const hash = crypto.createHash('sha256').update(id).digest();
    const expectedBucket = hash.readUInt32BE(0) % 100;

    // bucket < 50 时,percentage=50 应返回 true;否则 false
    expect(isInStagingBatch(50, dataDir)).toBe(expectedBucket < 50);
    expect(isInStagingBatch(expectedBucket, dataDir)).toBe(false); // bucket == percentage 时 < percentage 不成立
    expect(isInStagingBatch(expectedBucket + 1, dataDir)).toBe(true); // bucket < percentage+1 成立
  });

  it('不同 client-id 在 percentage=50 大致均匀(允许 30%-70% 离差)', () => {
    let inBatch = 0;
    const total = 1000;
    for (let i = 0; i < total; i++) {
      const dir = makeTmpDataDir();
      try {
        writeClientId(dir, `client-${i}-${crypto.randomBytes(4).toString('hex')}`);
        if (isInStagingBatch(50, dir)) inBatch++;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    // 期望 50% 上下,放宽到 [30%, 70%](避免偶发噪声 flake)
    expect(inBatch).toBeGreaterThanOrEqual(300);
    expect(inBatch).toBeLessThanOrEqual(700);
  });

  it('percentage=10 时不在批次的客户端明显多于在批次的(粗略分布检查)', () => {
    let inBatch = 0;
    const total = 500;
    for (let i = 0; i < total; i++) {
      const dir = makeTmpDataDir();
      try {
        writeClientId(dir, `client-${i}`);
        if (isInStagingBatch(10, dir)) inBatch++;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    // 期望约 10%,放宽到 [3%, 20%]
    expect(inBatch).toBeGreaterThanOrEqual(15); // 3%
    expect(inBatch).toBeLessThanOrEqual(100); // 20%
  });

  it('dataDir 不存在 .client-id 时自动生成,后续调用结果稳定', () => {
    // 不预写 client-id,让 getOrCreateStableClientId 内部生成
    const first = isInStagingBatch(50, dataDir);
    const second = isInStagingBatch(50, dataDir);
    expect(first).toBe(second);
    // 验证文件已被写入
    expect(fs.existsSync(path.join(dataDir, '.client-id'))).toBe(true);
  });

  it('boundary: percentage=1 时极少数客户端在批次', () => {
    let inBatch = 0;
    const total = 500;
    for (let i = 0; i < total; i++) {
      const dir = makeTmpDataDir();
      try {
        writeClientId(dir, `boundary-${i}`);
        if (isInStagingBatch(1, dir)) inBatch++;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    // 期望约 1% (5/500),放宽到 [0, 30](高方差但应远低于 50%)
    expect(inBatch).toBeLessThanOrEqual(30);
  });

  it('percentage=99 时绝大多数客户端在批次', () => {
    let inBatch = 0;
    const total = 500;
    for (let i = 0; i < total; i++) {
      const dir = makeTmpDataDir();
      try {
        writeClientId(dir, `boundary-high-${i}`);
        if (isInStagingBatch(99, dir)) inBatch++;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    expect(inBatch).toBeGreaterThanOrEqual(450); // ≥90%
  });
});
