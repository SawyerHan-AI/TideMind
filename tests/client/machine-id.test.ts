/**
 * tests/client/machine-id.test.ts
 *
 * 覆盖 client/electron/utils/machine-id.ts:getOrCreateStableClientId(dataDir):
 *  - 文件存在 + 内容非空 → 返回内容
 *  - 文件不存在 → 生成 UUID + 写文件(mode 0o600)
 *  - 文件读失败 → 重新生成
 *  - 文件存在但内容为空(空字符串)→ 重新生成
 *  - 持久化失败时 → log.error 但不抛错(返回新生成的 ID)
 *
 * 风险点:
 *  - 文件 mode 必须 0o600(用户私有),staging bucket 是基于这个 ID 算的,
 *    其他用户能读会破坏 staging 分桶安全性
 *  - 生成的 UUID 必须真随机且不可预测
 *  - 重复调用同一 dataDir 必须返回同一 ID(staging 决策一致性)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { getOrCreateStableClientId } = await import(
  '../../client/electron/utils/machine-id.js'
);

describe('machine-id — getOrCreateStableClientId', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-machine-id-test-'));
  });

  afterEach(() => {
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    vi.restoreAllMocks();
  });

  it('文件不存在 → 生成 UUID + 写入 .client-id 文件', () => {
    expect(fs.existsSync(path.join(dataDir, '.client-id'))).toBe(false);
    const id = getOrCreateStableClientId(dataDir);
    expect(id).toBeTruthy();
    expect(fs.existsSync(path.join(dataDir, '.client-id'))).toBe(true);
  });

  it('文件存在 + 内容非空 → 直接返回文件内容', () => {
    fs.writeFileSync(path.join(dataDir, '.client-id'), 'pre-existing-uuid-12345', 'utf-8');
    const id = getOrCreateStableClientId(dataDir);
    expect(id).toBe('pre-existing-uuid-12345');
  });

  it('两次调用同一 dataDir → 返回同一 ID(staging 决策一致性)', () => {
    const id1 = getOrCreateStableClientId(dataDir);
    const id2 = getOrCreateStableClientId(dataDir);
    expect(id2).toBe(id1);
  });

  it('文件内容包含两端空白 → trim 后返回非空', () => {
    fs.writeFileSync(path.join(dataDir, '.client-id'), '  trimmed-id  \n', 'utf-8');
    const id = getOrCreateStableClientId(dataDir);
    expect(id).toBe('trimmed-id');
  });

  it('文件内容为空字符串 → 重新生成 UUID', () => {
    fs.writeFileSync(path.join(dataDir, '.client-id'), '', 'utf-8');
    const id = getOrCreateStableClientId(dataDir);
    expect(id.length).toBeGreaterThan(0);
    expect(id).not.toBe('');
  });

  it('文件内容全是空白 → trim 后视为空,重新生成', () => {
    fs.writeFileSync(path.join(dataDir, '.client-id'), '   \n\t  ', 'utf-8');
    const id = getOrCreateStableClientId(dataDir);
    expect(id.trim().length).toBeGreaterThan(0);
  });

  it('文件 mode 是 0o600(用户私有)', () => {
    getOrCreateStableClientId(dataDir);
    const stat = fs.statSync(path.join(dataDir, '.client-id'));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('生成的 UUID 长度合理(>= 30 字符,UUIDv4 标准 36)', () => {
    const id = getOrCreateStableClientId(dataDir);
    expect(id.length).toBeGreaterThanOrEqual(30);
  });

  it('两个不同 dataDir 生成的 ID 不一样(避免静态种子 bug)', () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-machine-id-test2-'));
    try {
      const id1 = getOrCreateStableClientId(dataDir);
      const id2 = getOrCreateStableClientId(dir2);
      expect(id1).not.toBe(id2);
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('dataDir 不存在时也能工作(mkdir recursive)', () => {
    const nested = path.join(dataDir, 'nested', 'deeper');
    expect(fs.existsSync(nested)).toBe(false);
    expect(() => getOrCreateStableClientId(nested)).not.toThrow();
    expect(fs.existsSync(path.join(nested, '.client-id'))).toBe(true);
  });

  it('读文件抛错(权限错)时 → 重新生成 + 不抛错', () => {
    fs.writeFileSync(path.join(dataDir, '.client-id'), 'old-id', 'utf-8');
    // mock readFileSync 抛错
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => {
      throw new Error('EACCES');
    });

    const id = getOrCreateStableClientId(dataDir);
    expect(id).toBeTruthy();
    expect(id).not.toBe('old-id');
    readSpy.mockRestore();
  });

  it('writeFileSync 失败时不抛错(返回生成的 ID 不持久化)', () => {
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      throw new Error('ENOSPC');
    });

    const id = getOrCreateStableClientId(dataDir);
    expect(id).toBeTruthy();
    writeSpy.mockRestore();
  });

  it('多次调用 1000 次同一 dataDir,只生成一次 UUID,后续都读 file', () => {
    let writeCount = 0;
    const realWrite = fs.writeFileSync;
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((p, data, opts) => {
      if (String(p).endsWith('.client-id')) writeCount++;
      return realWrite(p, data as Buffer | string, opts as fs.WriteFileOptions);
    });

    for (let i = 0; i < 100; i++) {
      getOrCreateStableClientId(dataDir);
    }
    expect(writeCount).toBe(1);
    writeSpy.mockRestore();
  });
});
