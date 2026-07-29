/**
 * tests/hook-once-session.test.ts
 *
 * 覆盖 src/hook-once-session.ts(--once-per-session 的 marker 去重逻辑):
 *   - session_id 文件名安全化(防路径注入)
 *   - marker 目录 / 路径 / 存在性判断 / 创建
 *   - 异常 session_id(全部字符被剥掉)返回 null,不建 marker
 *
 * 注:hook-session-start.ts 的 main 流程(读 stdin payload → marker 存在则静默
 * 退出 → 成功输出后建 marker)是薄集成层,核心判定逻辑全部在本模块内,
 * 因此直接测这个纯逻辑模块。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  onceMarkerDir,
  sanitizeSessionId,
  sessionMarkerPath,
  hasSessionMarker,
  createSessionMarker,
} from '../src/hook-once-session.js';

describe('sanitizeSessionId', () => {
  it('保留 [A-Za-z0-9_-],剥掉其他字符', () => {
    expect(sanitizeSessionId('abc-123_XYZ')).toBe('abc-123_XYZ');
    expect(sanitizeSessionId('sess ion@2.0')).toBe('session20');
  });

  it('防路径注入:.. 和 / 全部被剥掉', () => {
    expect(sanitizeSessionId('../../etc/passwd')).toBe('etcpasswd');
    expect(sanitizeSessionId('..')).toBe('');
    expect(sanitizeSessionId('a/b\\c')).toBe('abc');
  });

  it('空串 / 全部非法字符 → 空串', () => {
    expect(sanitizeSessionId('')).toBe('');
    expect(sanitizeSessionId('///')).toBe('');
  });
});

describe('once-per-session marker', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-once-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('marker 目录默认在 os.tmpdir() 下的 tidemind-hook-once', () => {
    expect(onceMarkerDir()).toBe(path.join(os.tmpdir(), 'tidemind-hook-once'));
    expect(onceMarkerDir(tmpDir)).toBe(path.join(tmpDir, 'tidemind-hook-once'));
  });

  it('marker 文件名是安全化后的 session_id', () => {
    const p = sessionMarkerPath('sess-1_A', tmpDir);
    expect(p).toBe(path.join(tmpDir, 'tidemind-hook-once', 'sess-1_A'));
  });

  it('注入过的 session_id 无法逃逸出 marker 目录', () => {
    const p = sessionMarkerPath('../../evil', tmpDir);
    expect(p).not.toBeNull();
    expect(path.dirname(p!)).toBe(path.join(tmpDir, 'tidemind-hook-once'));
  });

  it('marker 不存在 → hasSessionMarker 为 false;创建后为 true(幂等)', () => {
    expect(hasSessionMarker('s1', tmpDir)).toBe(false);
    createSessionMarker('s1', tmpDir);
    expect(hasSessionMarker('s1', tmpDir)).toBe(true);
    // 重复创建不抛错
    createSessionMarker('s1', tmpDir);
    expect(hasSessionMarker('s1', tmpDir)).toBe(true);
  });

  it('不同 session_id 的 marker 相互独立', () => {
    createSessionMarker('s1', tmpDir);
    expect(hasSessionMarker('s1', tmpDir)).toBe(true);
    expect(hasSessionMarker('s2', tmpDir)).toBe(false);
  });

  it('session_id 安全化后为空(异常场景)→ 路径为 null,不建 marker、不判重', () => {
    expect(sessionMarkerPath('...', tmpDir)).toBeNull();
    expect(hasSessionMarker('...', tmpDir)).toBe(false);
    expect(() => createSessionMarker('...', tmpDir)).not.toThrow();
    expect(fs.existsSync(path.join(tmpDir, 'tidemind-hook-once'))).toBe(false);
  });
});
