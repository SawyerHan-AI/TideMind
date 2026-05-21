/**
 * tests/client/updater-channel.test.ts
 *
 * 覆盖 client/electron/updater/channel.ts:
 *  - getUpdateChannel():返回 config.update.channel ?? 'stable'
 *  - setUpdateChannel(channel):
 *    - atomic write (tmp file + rename) 替代 writeFileSync(Round 4 Audit B-3 修复)
 *    - inflight 锁串行化并发调用
 *    - parseToml 失败时降级到空 raw + warn
 *    - 写入成功后 reloadConfig + log.info
 *    - rename 失败时清理 tmp 文件并冒泡错误
 *
 * 风险点(backlog / Round 4):
 *  - v0.2.66/v0.2.67 都踩过签名/发版相关 bug,channel 切换是 beta 链路入口
 *  - tmp file 命名用 pid + Date.now()  必须保留(多进程时避免互相覆盖)
 *  - inflight 串行化必须真有效,否则中间窗口 0 字节文件会让全局 config 退到默认
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 把 @server/config 模块整体替换——getConfig/getDataDir/reloadConfig 用 mock
let currentConfig: { update?: { channel?: 'stable' | 'beta' } } = {};
let currentDataDir = '';
const reloadConfigMock = vi.fn(() => undefined);

vi.mock('@server/config.js', () => ({
  getConfig: () => currentConfig,
  getDataDir: () => currentDataDir,
  reloadConfig: reloadConfigMock,
}));

// 在 mock 后再 import 待测模块
const { getUpdateChannel, setUpdateChannel } = await import(
  '../../client/electron/updater/channel.js'
);

function setupDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eb-channel-test-'));
}

function cleanupDataDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

describe('updater channel — getUpdateChannel', () => {
  beforeEach(() => {
    currentConfig = {};
    currentDataDir = '';
  });

  it("config 无 update 节点时默认 'stable'", () => {
    currentConfig = {};
    expect(getUpdateChannel()).toBe('stable');
  });

  it("config.update.channel 缺失时默认 'stable'", () => {
    currentConfig = { update: {} };
    expect(getUpdateChannel()).toBe('stable');
  });

  it("config.update.channel === 'beta' 时返回 'beta'", () => {
    currentConfig = { update: { channel: 'beta' } };
    expect(getUpdateChannel()).toBe('beta');
  });

  it("config.update.channel === 'stable' 时返回 'stable'", () => {
    currentConfig = { update: { channel: 'stable' } };
    expect(getUpdateChannel()).toBe('stable');
  });
});

describe('updater channel — setUpdateChannel', () => {
  beforeEach(() => {
    currentConfig = {};
    currentDataDir = setupDataDir();
    reloadConfigMock.mockClear();
  });

  afterEach(() => {
    cleanupDataDir(currentDataDir);
    currentDataDir = '';
    vi.restoreAllMocks();
  });

  it('config.toml 不存在时新建并写入 channel', async () => {
    const configPath = path.join(currentDataDir, 'config.toml');
    expect(fs.existsSync(configPath)).toBe(false);

    await setUpdateChannel('beta');

    expect(fs.existsSync(configPath)).toBe(true);
    const content = fs.readFileSync(configPath, 'utf-8');
    expect(content).toContain('channel');
    expect(content).toContain('beta');
    expect(reloadConfigMock).toHaveBeenCalledTimes(1);
  });

  it('config.toml 已存在 [update] 时保留其他字段', async () => {
    const configPath = path.join(currentDataDir, 'config.toml');
    fs.writeFileSync(
      configPath,
      `[general]
user_name = "alice"

[update]
channel = "stable"
preview = true
`,
      'utf-8',
    );

    await setUpdateChannel('beta');
    const content = fs.readFileSync(configPath, 'utf-8');
    expect(content).toContain('channel = "beta"');
    expect(content).toContain('user_name = "alice"');
    expect(content).toContain('preview = true');
  });

  it('config.toml 解析失败时降级为空 raw + 写入 channel + 不抛错', async () => {
    const configPath = path.join(currentDataDir, 'config.toml');
    // 写入故意损坏的 TOML
    fs.writeFileSync(configPath, '[invalid:::', 'utf-8');

    await expect(setUpdateChannel('beta')).resolves.toBeUndefined();

    const content = fs.readFileSync(configPath, 'utf-8');
    expect(content).toContain('channel = "beta"');
  });

  it('config.toml 中 update 字段不是 object 时被忽略不抛错', async () => {
    const configPath = path.join(currentDataDir, 'config.toml');
    fs.writeFileSync(
      configPath,
      `update = "this-is-a-string-not-object"
`,
      'utf-8',
    );

    await setUpdateChannel('beta');
    const content = fs.readFileSync(configPath, 'utf-8');
    expect(content).toContain('channel = "beta"');
  });

  it('使用 atomic write (tmp file + rename),写入后无残留 .tmp 文件', async () => {
    const configPath = path.join(currentDataDir, 'config.toml');
    await setUpdateChannel('beta');

    const entries = fs.readdirSync(currentDataDir);
    const tmpFiles = entries.filter((f) => f.startsWith('config.toml.') && f.endsWith('.tmp'));
    expect(tmpFiles).toEqual([]);
    expect(fs.existsSync(configPath)).toBe(true);
  });

  it('rename 失败时 tmp 文件被清理 + 错误冒泡', async () => {
    const configPath = path.join(currentDataDir, 'config.toml');

    // 故意让 renameSync 抛错
    const realRename = fs.renameSync;
    const renameSpy = vi
      .spyOn(fs, 'renameSync')
      .mockImplementationOnce(() => {
        throw new Error('simulated rename failure');
      });

    await expect(setUpdateChannel('beta')).rejects.toThrow('simulated rename failure');

    // 失败后不应该有残留 .tmp 文件(catch 块 try unlinkSync)
    const entries = fs.existsSync(currentDataDir)
      ? fs.readdirSync(currentDataDir)
      : [];
    const tmpFiles = entries.filter((f) => f.startsWith('config.toml.') && f.endsWith('.tmp'));
    expect(tmpFiles).toEqual([]);

    // 原 config.toml 不应被部分写入污染
    expect(fs.existsSync(configPath)).toBe(false);

    renameSpy.mockRestore();
    void realRename;
  });

  it('inflight 锁:连续两次 setUpdateChannel 串行化执行,最终值是最后一次', async () => {
    const p1 = setUpdateChannel('beta');
    const p2 = setUpdateChannel('stable');
    await Promise.all([p1, p2]);

    const content = fs.readFileSync(path.join(currentDataDir, 'config.toml'), 'utf-8');
    expect(content).toContain('channel = "stable"');
    // reloadConfig 被各调用一次
    expect(reloadConfigMock).toHaveBeenCalledTimes(2);
  });

  it('inflight 锁:即便前一次抛错,后一次仍能正常执行(catch 不中断链)', async () => {
    const renameSpy = vi
      .spyOn(fs, 'renameSync')
      .mockImplementationOnce(() => {
        throw new Error('first call fails');
      });

    const failing = setUpdateChannel('beta');
    const succeeding = setUpdateChannel('stable');

    await expect(failing).rejects.toThrow('first call fails');
    await expect(succeeding).resolves.toBeUndefined();

    // 第二次成功写入 stable
    const content = fs.readFileSync(path.join(currentDataDir, 'config.toml'), 'utf-8');
    expect(content).toContain('channel = "stable"');

    renameSpy.mockRestore();
  });

  it('reloadConfig 只在写入成功后调用(失败时不调)', async () => {
    const renameSpy = vi
      .spyOn(fs, 'renameSync')
      .mockImplementationOnce(() => {
        throw new Error('fail');
      });

    await expect(setUpdateChannel('beta')).rejects.toThrow();
    expect(reloadConfigMock).not.toHaveBeenCalled();

    renameSpy.mockRestore();
    // 修复后再写一次应该调一次
    await setUpdateChannel('beta');
    expect(reloadConfigMock).toHaveBeenCalledTimes(1);
  });

  it('tmp 文件名包含 pid + 时间戳避免多 Electron 实例打架', async () => {
    // 间谍 writeFileSync 检查 tmp 路径格式
    const writeFileSpy = vi.spyOn(fs, 'writeFileSync');
    await setUpdateChannel('beta');

    const tmpCall = writeFileSpy.mock.calls.find((c) =>
      typeof c[0] === 'string' ? c[0].endsWith('.tmp') : false,
    );
    expect(tmpCall).toBeDefined();
    const tmpPath = tmpCall![0] as string;
    expect(tmpPath).toMatch(/config\.toml\.\d+\.\d+\.tmp$/);
    // 包含 process.pid
    expect(tmpPath).toContain(String(process.pid));

    writeFileSpy.mockRestore();
  });

  it('mkdirSync recursive 确保 dataDir 父目录存在', async () => {
    // 使用嵌套不存在的 dataDir
    const nested = path.join(currentDataDir, 'nested', 'deeper');
    currentDataDir = nested;
    await setUpdateChannel('beta');
    expect(fs.existsSync(path.join(nested, 'config.toml'))).toBe(true);
  });
});
