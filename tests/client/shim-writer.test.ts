/**
 * tests/client/shim-writer.test.ts
 *
 * 覆盖 client/electron/runtime/shim-writer.ts 的 writeShimAndRuntimePath():
 *  - shim 脚本和 runtime-path 文件的 atomic write + diff-based skip
 *  - shim 文件必须 mode=0o755(可执行)
 *  - 多层 fallback shell 脚本内容稳定(不会因为重构悄悄漂移)
 *
 * 风险点:
 *  - shim 内容变化会让所有外部 Agent 重新解析,频繁重写浪费 IO
 *  - shim mode 缺 +x 会让外部 Agent 找不到 node 启动失败(plugin runtime guide 注释)
 *  - runtime-path 漂移会让 tm-node 走错 fallback 层
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { getShimDirMock, getShimPathMock, getRuntimePathFileMock, getCurrentRuntimePathMock, getStandardInstallPathMock } = vi.hoisted(() => ({
  getShimDirMock: vi.fn(),
  getShimPathMock: vi.fn(),
  getRuntimePathFileMock: vi.fn(),
  getCurrentRuntimePathMock: vi.fn(),
  getStandardInstallPathMock: vi.fn(),
}));

vi.mock('../../client/electron/runtime/runtime-paths', () => ({
  getShimDir: getShimDirMock,
  getShimPath: getShimPathMock,
  getRuntimePathFile: getRuntimePathFileMock,
  getCurrentRuntimePath: getCurrentRuntimePathMock,
  getStandardInstallPath: getStandardInstallPathMock,
}));

const { writeShimAndRuntimePath } = await import(
  '../../client/electron/runtime/shim-writer'
);

describe('shim-writer — writeShimAndRuntimePath', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-shim-test-'));
    const shimDir = path.join(tmpRoot, 'bin');
    const shimPath = path.join(shimDir, 'tm-node');
    const runtimePathFile = path.join(tmpRoot, 'runtime-path');
    const runtimePath = '/path/to/electron';

    getShimDirMock.mockReturnValue(shimDir);
    getShimPathMock.mockReturnValue(shimPath);
    getRuntimePathFileMock.mockReturnValue(runtimePathFile);
    getCurrentRuntimePathMock.mockReturnValue(runtimePath);
    getStandardInstallPathMock.mockReturnValue('/Applications/Tide Mind.app/Contents/MacOS/Tide Mind');
  });

  afterEach(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    vi.restoreAllMocks();
  });

  it('全新安装(shim + runtime-path 都不存在)→ 都写入 + shimUpdated/runtimePathUpdated=true', () => {
    const result = writeShimAndRuntimePath();
    expect(result.shimUpdated).toBe(true);
    expect(result.runtimePathUpdated).toBe(true);
    expect(fs.existsSync(result.shimPath)).toBe(true);
    expect(fs.existsSync(result.runtimePathFile)).toBe(true);
  });

  it('shim 文件 mode 必须是 0o755(可执行)', () => {
    writeShimAndRuntimePath();
    const stat = fs.statSync(getShimPathMock());
    // mode 低 9 位
    expect(stat.mode & 0o777).toBe(0o755);
  });

  it('shim 内容相同时不重写 shim(shimUpdated=false)', () => {
    writeShimAndRuntimePath();
    // 第二次
    const r2 = writeShimAndRuntimePath();
    expect(r2.shimUpdated).toBe(false);
  });

  it('shim 内容不同时重写(shimUpdated=true)', () => {
    writeShimAndRuntimePath();
    // 篡改 shim 文件
    fs.writeFileSync(getShimPathMock(), 'tampered content', 'utf-8');
    const r2 = writeShimAndRuntimePath();
    expect(r2.shimUpdated).toBe(true);
    const finalContent = fs.readFileSync(getShimPathMock(), 'utf-8');
    expect(finalContent).not.toBe('tampered content');
    expect(finalContent).toContain('Tide Mind tm-node shim');
  });

  it('runtime-path 相同时不重写(runtimePathUpdated=false)', () => {
    writeShimAndRuntimePath();
    const r2 = writeShimAndRuntimePath();
    expect(r2.runtimePathUpdated).toBe(false);
  });

  it('runtime-path 不同时重写(runtimePathUpdated=true)', () => {
    writeShimAndRuntimePath();
    // 改 mock 让 getCurrentRuntimePath 返回新路径
    getCurrentRuntimePathMock.mockReturnValueOnce('/new/path/to/electron');
    const r2 = writeShimAndRuntimePath();
    expect(r2.runtimePathUpdated).toBe(true);
    const content = fs.readFileSync(getRuntimePathFileMock(), 'utf-8').trim();
    expect(content).toBe('/new/path/to/electron');
  });

  it('mkdir 父目录幂等:重复调不抛错', () => {
    expect(() => {
      writeShimAndRuntimePath();
      writeShimAndRuntimePath();
      writeShimAndRuntimePath();
    }).not.toThrow();
  });

  it('shim 内容相同但 mode 被外部改成 644 时,chmod 兜底恢复 755', () => {
    writeShimAndRuntimePath();
    // 模拟用户/其他工具 chmod 644
    fs.chmodSync(getShimPathMock(), 0o644);
    expect(fs.statSync(getShimPathMock()).mode & 0o777).toBe(0o644);

    // 第二次:shim 内容一致 → 走 chmod 兜底分支
    writeShimAndRuntimePath();
    expect(fs.statSync(getShimPathMock()).mode & 0o777).toBe(0o755);
  });

  it('shim 内容包含 STANDARD_INSTALL 变量定义(由 getStandardInstallPath() 注入)', () => {
    // SHIM_CONTENT 是 module-level 常量,在 import 时已用首次 getStandardInstallPath() 计算
    // 这里只断言占位符模式存在,不验证具体值(因为 module-level 拿到的是 mock 初始值)
    writeShimAndRuntimePath();
    const content = fs.readFileSync(getShimPathMock(), 'utf-8');
    expect(content).toMatch(/STANDARD_INSTALL="[^"]*"/);
  });

  it('shim 内容包含 5 层 fallback(runtime-path / standard / login shell / hardcode / nvm)', () => {
    writeShimAndRuntimePath();
    const content = fs.readFileSync(getShimPathMock(), 'utf-8');
    expect(content).toContain('RUNTIME_PATH_FILE');
    expect(content).toContain('STANDARD_INSTALL');
    expect(content).toContain("command -v node");
    expect(content).toContain('/opt/homebrew/bin/node');
    expect(content).toContain('/usr/local/bin/node');
    expect(content).toContain('.nvm/versions/node');
  });

  it('runtime-path 文件以换行符结尾', () => {
    writeShimAndRuntimePath();
    const content = fs.readFileSync(getRuntimePathFileMock(), 'utf-8');
    expect(content).toBe('/path/to/electron\n');
  });

  it('返回值结构完整:shimPath/runtimePathFile/runtimePath + 两个 updated 标志', () => {
    const result = writeShimAndRuntimePath();
    expect(result).toMatchObject({
      shimPath: expect.stringContaining('tm-node'),
      runtimePathFile: expect.stringContaining('runtime-path'),
      runtimePath: '/path/to/electron',
      shimUpdated: expect.any(Boolean),
      runtimePathUpdated: expect.any(Boolean),
    });
  });

  it('parent dir 不存在时也能写(mkdir recursive)', () => {
    // 删除整个 tmpRoot,确保 mkdir recursive 真生效
    fs.rmSync(tmpRoot, { recursive: true, force: true });

    expect(() => writeShimAndRuntimePath()).not.toThrow();
    expect(fs.existsSync(getShimPathMock())).toBe(true);
    expect(fs.existsSync(getRuntimePathFileMock())).toBe(true);
  });
});
