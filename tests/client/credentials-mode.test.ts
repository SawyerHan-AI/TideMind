/**
 * writeVertexCredentials 文件权限测试(HIGH bug 修复)。
 *
 * 背景:
 *   原版 `unlinkSync + writeFileSync({mode:0o600})`,unlink 失败时空 catch 吞掉,
 *   然后 writeFileSync 在现有 0o644 文件上 truncate —— Node.js writeFileSync 的
 *   mode 选项**只在创建新文件时**应用,truncate 不改 mode。GCP Service Account
 *   私钥继续以 0o644 落盘,世界可读。
 *
 * 修复:writeFileSync 之后**强制** chmodSync(destPath, 0o600) 兜底。
 *
 * 本测试覆盖三个场景:
 *   1. 不存在目标文件 → 创建后 mode = 0o600
 *   2. 已存在 0o644 目标文件(模拟老版本残留 / unlink 失败 / 手工拷贝) → 写入后 mode = 0o600
 *   3. 已存在 0o600 目标文件 → 写入后 mode 保持 0o600(回归)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// electron / logger stub:writeVertexCredentials 只用 fs + logger
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));

vi.mock('../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

import { writeVertexCredentials } from '../../client/electron/ipc/credentials.js';

describe('writeVertexCredentials — 强制 0o600 mode', () => {
  let tmpDir: string;
  let destPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vertex-cred-test-'));
    destPath = path.join(tmpDir, 'vertex-credentials.json');
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // Skip on Windows:NTFS 没有 POSIX mode,statSync().mode & 0o777 总返回 0o666 (rw-rw-rw-)
  // 或全 0,与 POSIX 含义不对应。该 bug 影响 Unix-likes,Windows 走 ACL,本测试
  // 不需在 Win 上运行。
  const itPosix = process.platform === 'win32' ? it.skip : it;

  itPosix('目标文件不存在 → mode = 0o600', () => {
    expect(fs.existsSync(destPath)).toBe(false);
    writeVertexCredentials(destPath, JSON.stringify({ type: 'service_account', project_id: 'p1' }));
    const stat = fs.statSync(destPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  itPosix('已存在 0o644 文件 → 覆盖后 mode = 0o600(关键防回归)', () => {
    // 预存一份 0o644 的"老文件"(模拟历史版本写入或外部拷贝)
    fs.writeFileSync(destPath, 'old contents', { mode: 0o644 });
    // 显式 chmod 兜一下:某些 FS 上 writeFileSync 的 mode 受 umask 影响
    fs.chmodSync(destPath, 0o644);
    expect(fs.statSync(destPath).mode & 0o777).toBe(0o644);

    // 跑写入流程
    writeVertexCredentials(destPath, JSON.stringify({ type: 'service_account', project_id: 'p2' }));

    // 关键:即便 unlinkSync 因为某些原因失败(此处会成功,但 chmod 兜底也保证),
    // mode 必须降到 0o600
    const stat = fs.statSync(destPath);
    expect(stat.mode & 0o777, 'after writeVertexCredentials, mode must be 0o600').toBe(0o600);

    // 内容也对(确保不是 unlink 失败 → 老内容残留)
    const content = fs.readFileSync(destPath, 'utf-8');
    expect(JSON.parse(content).project_id).toBe('p2');
  });

  itPosix('已存在 0o600 文件 → 覆盖后保持 0o600(回归)', () => {
    fs.writeFileSync(destPath, 'old', { mode: 0o600 });
    fs.chmodSync(destPath, 0o600);

    writeVertexCredentials(destPath, JSON.stringify({ type: 'service_account', project_id: 'p3' }));

    expect(fs.statSync(destPath).mode & 0o777).toBe(0o600);
  });

  itPosix('unlinkSync 抛 EBUSY(模拟) → chmod 兜底仍把 mode 改成 0o600', () => {
    // 写一个 0o644 老文件
    fs.writeFileSync(destPath, 'busy file', { mode: 0o644 });
    fs.chmodSync(destPath, 0o644);

    // 通过 spy 让 unlinkSync 抛 EBUSY
    const original = fs.unlinkSync;
    const spy = vi.spyOn(fs, 'unlinkSync').mockImplementationOnce((p) => {
      if (String(p) === destPath) {
        const err = new Error('EBUSY: resource busy or locked') as NodeJS.ErrnoException;
        err.code = 'EBUSY';
        throw err;
      }
      return original.call(fs, p as fs.PathLike);
    });

    try {
      writeVertexCredentials(destPath, JSON.stringify({ type: 'service_account', project_id: 'p4' }));
    } finally {
      spy.mockRestore();
    }

    // 即便 unlink 失败,write + chmod 兜底应让最终 mode = 0o600
    expect(fs.statSync(destPath).mode & 0o777, 'chmod fallback must enforce 0o600 even after unlink failure').toBe(0o600);
  });
});
