/**
 * client/electron/updater/index.ts — 协调逻辑单元测试
 *
 * 已存在测试:
 *   - updater-scheduler / updater-staging / updater-channel / updater-mandatory / update-signature
 *
 * 本文件聚焦 index.ts 本身的协调函数 — 多状态机分支:
 *   1. initAutoUpdater 防御:dev 模式 / 重复调用 / autoUpdater 事件订阅
 *   2. runUpdateCheck happy path:checking → cross-check → available(autoDownload=false)
 *   3. runUpdateCheck 自动下载:autoDownload=true → 触发 downloadUpdate
 *   4. runUpdateCheck mandatory:即便 autoDownload=false 也会强制下载
 *   5. runUpdateCheck status='no-update' / 'fetch-error' / 'invalid' 分支
 *   6. runUpdateCheck staged-out(stagingPercentage 未命中且非 mandatory)
 *   7. runUpdateCheck cross-check 失败 → release-pending
 *   8. runUpdateCheck cross-check version 不一致 → release-pending(非红色 signature-invalid)
 *   9. runUpdateCheck manifest query 超时 → error
 *  10. runUpdateCheck inflight 锁:并发调用直接 skip
 *  11. runUpdateCheck downloading/downloaded 状态下 skip
 *  12. triggerDownload happy path
 *  13. triggerDownload 非 available 状态 skip
 *  14. triggerDownload 与 runUpdateCheck inflight 互斥(throw error)
 *  15. triggerDownload download 失败 → error state + rethrow + pendingMandatory 不清(F3)
 *  16. autoUpdater 'download-progress' 事件推 downloading state
 *  17. autoUpdater 'update-downloaded' 事件推 downloaded + 带 pendingMandatory
 *  18. autoUpdater 'error' 事件推 error state + state=downloaded 时 reset isQuitting
 *  19. setUpdateChannel 持久化 + apply + fire-and-forget check(autoDownload=false)
 *  20. installUpdate happy path:setQuitting + quitAndInstall
 *  21. installUpdate 非 downloaded 状态 → ignore
 *
 * 因 index.ts 有 module-level state,每个 test 用 vi.resetModules + 重新 import,
 * 在 vi.mock 因为 vitest 行为是 module-cached 的复杂性下,把 mock 放最外层 + reset
 * 跟踪状态。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─────────── 全局 mocks ───────────

const downloadUpdateMock = vi.fn();
const quitAndInstallMock = vi.fn();
const checkForUpdatesMock = vi.fn();
const autoUpdaterOnMock = vi.fn();
const autoUpdaterListeners = new Map<string, ((...args: unknown[]) => void)>();

autoUpdaterOnMock.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
  autoUpdaterListeners.set(event, cb);
});

const autoUpdaterMock = {
  autoDownload: false,
  autoInstallOnAppQuit: false,
  allowPrerelease: false,
  logger: null,
  on: autoUpdaterOnMock,
  downloadUpdate: downloadUpdateMock,
  checkForUpdates: checkForUpdatesMock,
  quitAndInstall: quitAndInstallMock,
};
const electronUpdaterMock = { autoUpdater: autoUpdaterMock };
vi.mock('electron-updater', () => electronUpdaterMock);
vi.mock('../../client/node_modules/electron-updater/out/main.js', () => electronUpdaterMock);

const electronMock = {
  app: {
    isPackaged: true,
    getVersion: () => '0.1.0',
  },
  BrowserWindow: { getAllWindows: () => [] },
};
vi.mock('electron', () => electronMock);
vi.mock('../../client/node_modules/electron/index.js', () => electronMock);

const queryAndVerifyManifestMock = vi.fn();
vi.mock('../../client/electron/updater/verifier.js', () => ({
  queryAndVerifyManifest: queryAndVerifyManifestMock,
}));

const isInStagingBatchMock = vi.fn(() => true);
vi.mock('../../client/electron/updater/staging.js', () => ({
  isInStagingBatch: isInStagingBatchMock,
}));

const persistChannelMock = vi.fn();
const getUpdateChannelMock = vi.fn(() => 'stable');
vi.mock('../../client/electron/updater/channel.js', () => ({
  getUpdateChannel: getUpdateChannelMock,
  setUpdateChannel: persistChannelMock,
}));

const setQuittingMock = vi.fn();
const resetQuittingMock = vi.fn();
vi.mock('../../client/electron/lifecycle.js', () => ({
  setQuitting: setQuittingMock,
  resetQuitting: resetQuittingMock,
  getIsQuitting: vi.fn(() => false),
}));

vi.mock('@server/config.js', () => ({
  getDataDir: () => '/tmp/test',
}));

vi.mock('@server/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// ─────────── 辅助 ───────────

function makeFakeWindow(): unknown {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
  };
}

interface UpdaterModule {
  initAutoUpdater: (w: unknown) => void;
  runUpdateCheck: (opts?: { autoDownload?: boolean }) => Promise<void>;
  triggerDownload: () => Promise<void>;
  setUpdateChannel: (c: 'stable' | 'beta') => Promise<void>;
  installUpdate: () => void;
  getUpdaterState: () => { status: string; version?: string; mandatory?: boolean; message?: string; percent?: number };
}

async function freshModule(): Promise<UpdaterModule> {
  vi.resetModules();
  // resetModules 后所有 mock 还在(vitest 保留 vi.mock 注册),但 module 内的
  // initialized / inflight / currentState 等闭包变量会重置。
  return (await import('../../client/electron/updater/index.js')) as unknown as UpdaterModule;
}

beforeEach(() => {
  downloadUpdateMock.mockReset();
  checkForUpdatesMock.mockReset();
  quitAndInstallMock.mockReset();
  queryAndVerifyManifestMock.mockReset();
  setQuittingMock.mockReset();
  resetQuittingMock.mockReset();
  persistChannelMock.mockReset();
  autoUpdaterOnMock.mockClear();
  isInStagingBatchMock.mockReset();
  isInStagingBatchMock.mockReturnValue(true);
  autoUpdaterListeners.clear();
  // reset autoUpdater 字段
  autoUpdaterMock.autoDownload = false;
  autoUpdaterMock.allowPrerelease = false;
  electronMock.app.isPackaged = true;
});

// ─────────────────────────────────────────────────────
// 测试:initAutoUpdater
// ─────────────────────────────────────────────────────

describe('initAutoUpdater', () => {
  it('app.isPackaged=false(dev 模式)→ 跳过,不订阅事件', async () => {
    electronMock.app.isPackaged = false;
    const mod = await freshModule();
    mod.initAutoUpdater(makeFakeWindow() as never);
    // 事件没订阅
    expect(autoUpdaterOnMock).not.toHaveBeenCalled();
    // 后续 runUpdateCheck 也 noop
    await mod.runUpdateCheck();
    expect(queryAndVerifyManifestMock).not.toHaveBeenCalled();
  });

  it('生产模式 → autoDownload=false + autoInstallOnAppQuit=true + 订阅 4 个事件', async () => {
    const mod = await freshModule();
    mod.initAutoUpdater(makeFakeWindow() as never);
    expect(autoUpdaterMock.autoDownload).toBe(false);
    expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(true);
    // 至少订阅:update-available / update-not-available / download-progress / update-downloaded / error
    const events = Array.from(autoUpdaterListeners.keys());
    expect(events).toContain('download-progress');
    expect(events).toContain('update-downloaded');
    expect(events).toContain('error');
  });

  it('重复调用 → 只 init 一次(idempotent)', async () => {
    const mod = await freshModule();
    mod.initAutoUpdater(makeFakeWindow() as never);
    const firstCount = autoUpdaterOnMock.mock.calls.length;
    mod.initAutoUpdater(makeFakeWindow() as never);
    expect(autoUpdaterOnMock.mock.calls.length).toBe(firstCount);
  });

  it('channel=beta → allowPrerelease=true', async () => {
    getUpdateChannelMock.mockReturnValueOnce('beta');
    const mod = await freshModule();
    mod.initAutoUpdater(makeFakeWindow() as never);
    expect(autoUpdaterMock.allowPrerelease).toBe(true);
  });
});

// ─────────────────────────────────────────────────────
// 测试:runUpdateCheck — manifest 状态分支
// ─────────────────────────────────────────────────────

describe('runUpdateCheck — manifest 状态分支', () => {
  it('未 init → return,不查 manifest', async () => {
    electronMock.app.isPackaged = false;  // 让 init skip
    const mod = await freshModule();
    mod.initAutoUpdater(makeFakeWindow() as never);
    await mod.runUpdateCheck();
    expect(queryAndVerifyManifestMock).not.toHaveBeenCalled();
  });

  it('no-update → state=up-to-date', async () => {
    const mod = await freshModule();
    mod.initAutoUpdater(makeFakeWindow() as never);
    queryAndVerifyManifestMock.mockResolvedValueOnce({ status: 'no-update', version: '0.1.0' });
    await mod.runUpdateCheck();
    expect(mod.getUpdaterState().status).toBe('up-to-date');
  });

  it('fetch-error → state=error', async () => {
    const mod = await freshModule();
    mod.initAutoUpdater(makeFakeWindow() as never);
    queryAndVerifyManifestMock.mockResolvedValueOnce({ status: 'fetch-error' });
    await mod.runUpdateCheck();
    expect(mod.getUpdaterState().status).toBe('error');
    expect(mod.getUpdaterState().message).toContain('manifest fetch failed');
  });

  it('invalid 签名 → state=signature-invalid + releaseUrl 透传', async () => {
    const mod = await freshModule();
    mod.initAutoUpdater(makeFakeWindow() as never);
    queryAndVerifyManifestMock.mockResolvedValueOnce({
      status: 'invalid',
      version: '9.9.9',
      releaseUrl: 'https://github.com/.../release/9.9.9',
    });
    await mod.runUpdateCheck();
    const st = mod.getUpdaterState();
    expect(st.status).toBe('signature-invalid');
    expect((st as { releaseUrl?: string }).releaseUrl).toBe('https://github.com/.../release/9.9.9');
  });

  it('staging 未命中 + 非 mandatory → state=staged-out, 不下载', async () => {
    isInStagingBatchMock.mockReturnValueOnce(false);
    const mod = await freshModule();
    mod.initAutoUpdater(makeFakeWindow() as never);
    queryAndVerifyManifestMock.mockResolvedValueOnce({
      status: 'ok',
      version: '9.9.9',
      mandatory: false,
      stagingPercentage: 10,
    });
    await mod.runUpdateCheck();
    expect(mod.getUpdaterState().status).toBe('staged-out');
    expect(checkForUpdatesMock).not.toHaveBeenCalled();
    expect(downloadUpdateMock).not.toHaveBeenCalled();
  });

  it('staging 未命中但 mandatory=true → 仍然进 available + auto-download', async () => {
    isInStagingBatchMock.mockReturnValueOnce(false);
    const mod = await freshModule();
    mod.initAutoUpdater(makeFakeWindow() as never);
    queryAndVerifyManifestMock.mockResolvedValueOnce({
      status: 'ok',
      version: '9.9.9',
      mandatory: true,
      stagingPercentage: 10,
    });
    checkForUpdatesMock.mockResolvedValueOnce({ updateInfo: { version: '9.9.9' } });
    downloadUpdateMock.mockResolvedValueOnce(undefined);
    await mod.runUpdateCheck({ autoDownload: false });  // 即便 false, mandatory 也强下
    expect(downloadUpdateMock).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────
// 测试:runUpdateCheck — cross-check
// ─────────────────────────────────────────────────────

describe('runUpdateCheck — cross-check', () => {
  it('cross-check OK + autoDownload=true → state=available + 触发 downloadUpdate', async () => {
    const mod = await freshModule();
    mod.initAutoUpdater(makeFakeWindow() as never);
    queryAndVerifyManifestMock.mockResolvedValueOnce({
      status: 'ok',
      version: '9.9.9',
      mandatory: false,
      stagingPercentage: 100,
      releaseNotes: 'new feature X',
    });
    checkForUpdatesMock.mockResolvedValueOnce({ updateInfo: { version: '9.9.9' } });
    downloadUpdateMock.mockResolvedValueOnce(undefined);
    await mod.runUpdateCheck({ autoDownload: true });
    expect(downloadUpdateMock).toHaveBeenCalledTimes(1);
  });

  it('cross-check OK + autoDownload=false + 非 mandatory → 停在 available,不下载', async () => {
    const mod = await freshModule();
    mod.initAutoUpdater(makeFakeWindow() as never);
    queryAndVerifyManifestMock.mockResolvedValueOnce({
      status: 'ok',
      version: '9.9.9',
      mandatory: false,
      stagingPercentage: 100,
    });
    checkForUpdatesMock.mockResolvedValueOnce({ updateInfo: { version: '9.9.9' } });
    await mod.runUpdateCheck({ autoDownload: false });
    expect(mod.getUpdaterState().status).toBe('available');
    expect(downloadUpdateMock).not.toHaveBeenCalled();
  });

  it('cross-check 失败:electron-updater throw → state=release-pending(非 signature-invalid)', async () => {
    const mod = await freshModule();
    mod.initAutoUpdater(makeFakeWindow() as never);
    queryAndVerifyManifestMock.mockResolvedValueOnce({
      status: 'ok',
      version: '9.9.9',
      mandatory: false,
      stagingPercentage: 100,
    });
    checkForUpdatesMock.mockRejectedValueOnce(new Error('ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'));
    await mod.runUpdateCheck();
    const st = mod.getUpdaterState();
    expect(st.status).toBe('release-pending');
    expect(st.status).not.toBe('signature-invalid');
    // 没下载
    expect(downloadUpdateMock).not.toHaveBeenCalled();
  });

  it('cross-check version 不一致 → state=release-pending', async () => {
    const mod = await freshModule();
    mod.initAutoUpdater(makeFakeWindow() as never);
    queryAndVerifyManifestMock.mockResolvedValueOnce({
      status: 'ok',
      version: '9.9.9',
      mandatory: false,
      stagingPercentage: 100,
    });
    checkForUpdatesMock.mockResolvedValueOnce({ updateInfo: { version: '9.9.8' } });  // 老版本
    await mod.runUpdateCheck();
    expect(mod.getUpdaterState().status).toBe('release-pending');
  });

  it('cross-check 返回当前版本(updateInfo.version === currentAppVersion) → release-pending', async () => {
    const mod = await freshModule();
    mod.initAutoUpdater(makeFakeWindow() as never);
    queryAndVerifyManifestMock.mockResolvedValueOnce({
      status: 'ok',
      version: '9.9.9',
      mandatory: false,
      stagingPercentage: 100,
    });
    // 当前 0.1.0, eu 看到 0.1.0 → 跟 verifier(9.9.9) 不一致
    checkForUpdatesMock.mockResolvedValueOnce({ updateInfo: { version: '0.1.0' } });
    await mod.runUpdateCheck();
    expect(mod.getUpdaterState().status).toBe('release-pending');
  });
});

// ─────────────────────────────────────────────────────
// 测试:runUpdateCheck — inflight 锁 & 状态守卫
// ─────────────────────────────────────────────────────

describe('runUpdateCheck — inflight & state guards', () => {
  it('已有 inflight → skip', async () => {
    const mod = await freshModule();
    mod.initAutoUpdater(makeFakeWindow() as never);
    // 用一个长时间挂起的 promise 制造 inflight
    let resolveFirst: () => void;
    queryAndVerifyManifestMock.mockImplementationOnce(
      () => new Promise<unknown>((r) => { resolveFirst = () => r({ status: 'no-update', version: '0.1.0' }); }),
    );
    const first = mod.runUpdateCheck();
    // 让第一次 check 起步(进 inflight 锁)
    await new Promise((r) => setImmediate(r));
    // 第二次 — 应直接 skip
    await mod.runUpdateCheck();
    expect(queryAndVerifyManifestMock).toHaveBeenCalledTimes(1);
    // 收尾
    resolveFirst!();
    await first;
  });

  it('state=downloading → skip 不重新查 manifest', async () => {
    const mod = await freshModule();
    mod.initAutoUpdater(makeFakeWindow() as never);
    // 触发一次 download-progress 把 state 推到 downloading
    const cb = autoUpdaterListeners.get('download-progress')!;
    cb({ percent: 30, transferred: 100, total: 333 });
    expect(mod.getUpdaterState().status).toBe('downloading');
    await mod.runUpdateCheck();
    expect(queryAndVerifyManifestMock).not.toHaveBeenCalled();
  });

  it('state=downloaded → skip', async () => {
    const mod = await freshModule();
    mod.initAutoUpdater(makeFakeWindow() as never);
    autoUpdaterListeners.get('update-downloaded')?.({ version: '9.9.9', releaseNotes: '' });
    expect(mod.getUpdaterState().status).toBe('downloaded');
    await mod.runUpdateCheck();
    expect(queryAndVerifyManifestMock).not.toHaveBeenCalled();
  });

  it('queryAndVerifyManifest 抛错 → state=error,inflight 释放', async () => {
    const mod = await freshModule();
    mod.initAutoUpdater(makeFakeWindow() as never);
    queryAndVerifyManifestMock.mockRejectedValueOnce(new Error('boom'));
    await mod.runUpdateCheck();
    expect(mod.getUpdaterState().status).toBe('error');
    // inflight 释放 → 后续 check 应能再进入
    queryAndVerifyManifestMock.mockResolvedValueOnce({ status: 'no-update', version: '0.1.0' });
    await mod.runUpdateCheck();
    expect(queryAndVerifyManifestMock).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────
// 测试:triggerDownload
// ─────────────────────────────────────────────────────

describe('triggerDownload', () => {
  it('未 init → noop', async () => {
    electronMock.app.isPackaged = false;
    const mod = await freshModule();
    mod.initAutoUpdater(makeFakeWindow() as never);
    await mod.triggerDownload();
    expect(downloadUpdateMock).not.toHaveBeenCalled();
  });

  it('state=idle → noop(必须在 available 状态)', async () => {
    const mod = await freshModule();
    mod.initAutoUpdater(makeFakeWindow() as never);
    expect(mod.getUpdaterState().status).toBe('idle');
    await mod.triggerDownload();
    expect(downloadUpdateMock).not.toHaveBeenCalled();
  });

  it('state=available → 调 downloadUpdate', async () => {
    const mod = await freshModule();
    mod.initAutoUpdater(makeFakeWindow() as never);
    // 把 state 推到 available
    queryAndVerifyManifestMock.mockResolvedValueOnce({
      status: 'ok',
      version: '9.9.9',
      mandatory: false,
      stagingPercentage: 100,
    });
    checkForUpdatesMock.mockResolvedValueOnce({ updateInfo: { version: '9.9.9' } });
    await mod.runUpdateCheck({ autoDownload: false });
    expect(mod.getUpdaterState().status).toBe('available');

    downloadUpdateMock.mockResolvedValueOnce(undefined);
    await mod.triggerDownload();
    expect(downloadUpdateMock).toHaveBeenCalled();
  });

  it('triggerDownload 失败 → state=error + rethrow', async () => {
    const mod = await freshModule();
    mod.initAutoUpdater(makeFakeWindow() as never);
    queryAndVerifyManifestMock.mockResolvedValueOnce({
      status: 'ok',
      version: '9.9.9',
      mandatory: false,
      stagingPercentage: 100,
    });
    checkForUpdatesMock.mockResolvedValueOnce({ updateInfo: { version: '9.9.9' } });
    await mod.runUpdateCheck({ autoDownload: false });

    downloadUpdateMock.mockRejectedValueOnce(new Error('net err'));
    await expect(mod.triggerDownload()).rejects.toThrow('net err');
    expect(mod.getUpdaterState().status).toBe('error');
  });

  it('与 runUpdateCheck 并发 → 第二次 trigger 抛 inflight error', async () => {
    const mod = await freshModule();
    mod.initAutoUpdater(makeFakeWindow() as never);
    // 把 state 推到 available
    queryAndVerifyManifestMock.mockResolvedValueOnce({
      status: 'ok',
      version: '9.9.9',
      mandatory: false,
      stagingPercentage: 100,
    });
    checkForUpdatesMock.mockResolvedValueOnce({ updateInfo: { version: '9.9.9' } });
    await mod.runUpdateCheck({ autoDownload: false });

    // 起一个长 inflight 的 trigger
    let resolveFirst: () => void;
    downloadUpdateMock.mockImplementationOnce(
      () => new Promise<void>((r) => { resolveFirst = r; }),
    );
    const first = mod.triggerDownload();
    await new Promise((r) => setImmediate(r));

    // 并发的第二次 trigger 应该 throw inflight 错
    await expect(mod.triggerDownload()).rejects.toThrow(/in progress/);

    // 收尾
    resolveFirst!();
    await first;
  });
});

// ─────────────────────────────────────────────────────
// 测试:autoUpdater 事件处理
// ─────────────────────────────────────────────────────

describe('autoUpdater event handling', () => {
  it('download-progress → state=downloading + percent rounded', async () => {
    const mod = await freshModule();
    mod.initAutoUpdater(makeFakeWindow() as never);
    autoUpdaterListeners.get('download-progress')!({
      percent: 42.7,
      transferred: 1000,
      total: 2347,
    });
    const st = mod.getUpdaterState();
    expect(st.status).toBe('downloading');
    expect(st.percent).toBe(43);
  });

  it('update-downloaded → state=downloaded + mandatory 携带过来', async () => {
    const mod = await freshModule();
    mod.initAutoUpdater(makeFakeWindow() as never);
    // 先走一遍 check 把 mandatory 锁到 pendingMandatory
    queryAndVerifyManifestMock.mockResolvedValueOnce({
      status: 'ok',
      version: '9.9.9',
      mandatory: true,
      stagingPercentage: 100,
    });
    checkForUpdatesMock.mockResolvedValueOnce({ updateInfo: { version: '9.9.9' } });
    downloadUpdateMock.mockResolvedValueOnce(undefined);
    await mod.runUpdateCheck();

    autoUpdaterListeners.get('update-downloaded')!({
      version: '9.9.9',
      releaseNotes: 'release notes here',
    });
    const st = mod.getUpdaterState();
    expect(st.status).toBe('downloaded');
    expect(st.mandatory).toBe(true);  // pendingMandatory 跨过 downloading 中间态保留
  });

  it('update-downloaded releaseNotes 截断到 500 字符', async () => {
    const mod = await freshModule();
    mod.initAutoUpdater(makeFakeWindow() as never);
    const longNotes = 'x'.repeat(1000);
    autoUpdaterListeners.get('update-downloaded')!({
      version: '9.9.9',
      releaseNotes: longNotes,
    });
    const st = mod.getUpdaterState() as { releaseNotes?: string };
    expect(st.releaseNotes!.length).toBe(500);
  });

  it('autoUpdater error in state=downloaded → state=error + resetQuitting 被调', async () => {
    const mod = await freshModule();
    mod.initAutoUpdater(makeFakeWindow() as never);
    // 推 state 到 downloaded
    autoUpdaterListeners.get('update-downloaded')!({ version: '9.9.9', releaseNotes: '' });
    expect(mod.getUpdaterState().status).toBe('downloaded');

    resetQuittingMock.mockClear();
    autoUpdaterListeners.get('error')!(new Error('squirrel failure'));
    expect(mod.getUpdaterState().status).toBe('error');
    expect(resetQuittingMock).toHaveBeenCalled();
  });

  it('autoUpdater error in state=downloading → state=error + resetQuitting 被调', async () => {
    const mod = await freshModule();
    mod.initAutoUpdater(makeFakeWindow() as never);
    autoUpdaterListeners.get('download-progress')!({ percent: 50, transferred: 1, total: 2 });
    expect(mod.getUpdaterState().status).toBe('downloading');

    resetQuittingMock.mockClear();
    autoUpdaterListeners.get('error')!(new Error('net down'));
    expect(mod.getUpdaterState().status).toBe('error');
    expect(resetQuittingMock).toHaveBeenCalled();
  });

  it('autoUpdater error in state=idle → state=error,resetQuitting 不调用', async () => {
    const mod = await freshModule();
    mod.initAutoUpdater(makeFakeWindow() as never);
    resetQuittingMock.mockClear();
    autoUpdaterListeners.get('error')!(new Error('boom'));
    expect(mod.getUpdaterState().status).toBe('error');
    expect(resetQuittingMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────
// 测试:setUpdateChannel
// ─────────────────────────────────────────────────────

describe('setUpdateChannel', () => {
  it('持久化 + apply + 触发后续 check(autoDownload=false)', async () => {
    const mod = await freshModule();
    mod.initAutoUpdater(makeFakeWindow() as never);

    // 把 getUpdateChannel 改为 beta,模拟切换后
    getUpdateChannelMock.mockReturnValueOnce('beta');
    queryAndVerifyManifestMock.mockResolvedValueOnce({ status: 'no-update', version: '0.1.0' });

    await mod.setUpdateChannel('beta');
    expect(persistChannelMock).toHaveBeenCalledWith('beta');
    expect(autoUpdaterMock.allowPrerelease).toBe(true);
    // fire-and-forget — 等一下 microtask 让 .catch / runUpdateCheck 跑完
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(queryAndVerifyManifestMock).toHaveBeenCalled();
  });

  it('未 init 时 setUpdateChannel 只持久化,不 apply,不 check', async () => {
    electronMock.app.isPackaged = false;
    const mod = await freshModule();
    mod.initAutoUpdater(makeFakeWindow() as never);  // dev 模式 skip
    await mod.setUpdateChannel('beta');
    expect(persistChannelMock).toHaveBeenCalledWith('beta');
    // queryAndVerifyManifestMock 不被调
    expect(queryAndVerifyManifestMock).not.toHaveBeenCalled();
  });

  it('持久化失败时 promise rejects(直接 await 传播)', async () => {
    const mod = await freshModule();
    mod.initAutoUpdater(makeFakeWindow() as never);
    persistChannelMock.mockRejectedValueOnce(new Error('fs write fail'));
    await expect(mod.setUpdateChannel('beta')).rejects.toThrow('fs write fail');
  });
});

// ─────────────────────────────────────────────────────
// 测试:installUpdate
// ─────────────────────────────────────────────────────

describe('installUpdate', () => {
  it('未 init → noop', async () => {
    electronMock.app.isPackaged = false;
    const mod = await freshModule();
    mod.initAutoUpdater(makeFakeWindow() as never);
    mod.installUpdate();
    expect(quitAndInstallMock).not.toHaveBeenCalled();
    expect(setQuittingMock).not.toHaveBeenCalled();
  });

  it('state != downloaded → noop', async () => {
    const mod = await freshModule();
    mod.initAutoUpdater(makeFakeWindow() as never);
    expect(mod.getUpdaterState().status).toBe('idle');
    mod.installUpdate();
    expect(quitAndInstallMock).not.toHaveBeenCalled();
  });

  it('state=downloaded → setQuitting + quitAndInstall(false, true)', async () => {
    const mod = await freshModule();
    mod.initAutoUpdater(makeFakeWindow() as never);
    autoUpdaterListeners.get('update-downloaded')!({ version: '9.9.9', releaseNotes: '' });
    mod.installUpdate();
    expect(setQuittingMock).toHaveBeenCalled();
    expect(quitAndInstallMock).toHaveBeenCalledWith(false, true);
  });

  it('quitAndInstall 抛错 → resetQuitting + state=error(F6)', async () => {
    const mod = await freshModule();
    mod.initAutoUpdater(makeFakeWindow() as never);
    autoUpdaterListeners.get('update-downloaded')!({ version: '9.9.9', releaseNotes: '' });
    quitAndInstallMock.mockImplementationOnce(() => { throw new Error('quit fail'); });
    mod.installUpdate();
    expect(resetQuittingMock).toHaveBeenCalled();
    expect(mod.getUpdaterState().status).toBe('error');
    expect(mod.getUpdaterState().message).toBe('install_failed');
  });
});
