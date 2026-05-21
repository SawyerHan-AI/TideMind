/**
 * Audit-3 F3 + F6 回归覆盖:
 *
 * F3: pendingMandatory 在 runUpdateCheck / triggerDownload 的 catch 路径里**不应**被清。
 *     之前 catch 清掉 pendingMandatory 会让"download 一旦失败 → 强制升级标记被吞" — 网络一抖
 *     绕过 mandatory。修复后:catch 不清 pendingMandatory,下次 check 真拿到服务端 mandatory=false
 *     再清。
 *
 * F6: installUpdate 调 setQuitting 但 quitAndInstall 抛错时没 reset isQuitting。
 *     卡死状态:下次用户关窗口走 mac tray pattern 时,close handler 看到 isQuitting=true 就放行
 *     真退出,而本来应该只是 hide。修复后:catch 调 resetQuitting。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
// client/electron/*.ts 解析路径
vi.mock('../../client/node_modules/electron-updater/out/main.js', () => electronUpdaterMock);

const electronMock = {
  app: {
    isPackaged: true,
    getVersion: () => '0.1.0',
  },
  BrowserWindow: { getAllWindows: () => [] },
};
vi.mock('electron', () => electronMock);
// client/electron/*.ts 实际解析路径
vi.mock('../../client/node_modules/electron/index.js', () => electronMock);

const queryAndVerifyManifestMock = vi.fn();
vi.mock('../../client/electron/updater/verifier.js', () => ({
  queryAndVerifyManifest: queryAndVerifyManifestMock,
}));

vi.mock('../../client/electron/updater/staging.js', () => ({
  isInStagingBatch: () => true,
}));

vi.mock('../../client/electron/updater/channel.js', () => ({
  getUpdateChannel: () => 'stable',
  setUpdateChannel: vi.fn(),
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

function makeFakeWindow(): unknown {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
  };
}

describe('F3 — pendingMandatory not cleared on catch', () => {
  beforeEach(() => {
    downloadUpdateMock.mockReset();
    checkForUpdatesMock.mockReset();
    quitAndInstallMock.mockReset();
    queryAndVerifyManifestMock.mockReset();
    setQuittingMock.mockReset();
    resetQuittingMock.mockReset();
    autoUpdaterListeners.clear();
  });

  it('runUpdateCheck mandatory=true 后 catch 不清 pendingMandatory → 下轮 check 仍能弹强制', async () => {
    // 因 init 标记是 module-level,只 init 一次后多 case 共用是 OK 的;但首次 init 时
    // dynamic import 同 module 实例已注册过 → require cache 命中,initialized=true 一直保留。
    const mod = await import('../../client/electron/updater/index.js');
    mod.initAutoUpdater(makeFakeWindow() as never);

    // download 抛错
    queryAndVerifyManifestMock.mockResolvedValueOnce({
      status: 'ok',
      version: '9.9.9',
      mandatory: true,
      stagingPercentage: 100,
      releaseNotes: '',
    });
    checkForUpdatesMock.mockResolvedValueOnce({ updateInfo: { version: '9.9.9' } });
    downloadUpdateMock.mockRejectedValueOnce(new Error('network drop'));

    await mod.runUpdateCheck({ autoDownload: true });
    expect(mod.getUpdaterState().status).toBe('error');

    // 下一轮 check mandatory=true 仍能弹 available + mandatory=true
    queryAndVerifyManifestMock.mockResolvedValueOnce({
      status: 'ok',
      version: '9.9.9',
      mandatory: true,
      stagingPercentage: 100,
      releaseNotes: '',
    });
    checkForUpdatesMock.mockResolvedValueOnce({ updateInfo: { version: '9.9.9' } });
    downloadUpdateMock.mockResolvedValueOnce(undefined);

    await mod.runUpdateCheck({ autoDownload: false });

    const st = mod.getUpdaterState();
    expect(st.status).toBe('available');
    expect((st as { mandatory?: boolean }).mandatory).toBe(true);
  });
});

describe('F6 — installUpdate quitAndInstall throws → resetQuitting', () => {
  beforeEach(() => {
    quitAndInstallMock.mockReset();
    setQuittingMock.mockReset();
    resetQuittingMock.mockReset();
  });

  it('installUpdate 在 quitAndInstall 抛错时 → resetQuitting 被调,state → error', async () => {
    const mod = await import('../../client/electron/updater/index.js');
    // init 已经被前 describe 的 case 调过(模块单例);但 listeners 是按 on() 调用顺序记录的
    mod.initAutoUpdater(makeFakeWindow() as never);

    // 模拟 update-downloaded 事件触发(把 state 推到 'downloaded')
    const cb = autoUpdaterListeners.get('update-downloaded');
    expect(cb).toBeDefined();
    cb?.({ version: '9.9.9', releaseNotes: '' });

    expect(mod.getUpdaterState().status).toBe('downloaded');

    // installUpdate 调 quitAndInstall,抛错
    quitAndInstallMock.mockImplementationOnce(() => {
      throw new Error('quit failed');
    });

    mod.installUpdate();

    expect(setQuittingMock).toHaveBeenCalledTimes(1);
    expect(resetQuittingMock).toHaveBeenCalledTimes(1);
    expect(mod.getUpdaterState().status).toBe('error');
  });
});
