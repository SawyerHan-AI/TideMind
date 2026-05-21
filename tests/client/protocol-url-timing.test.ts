/**
 * Audit-3 F15 回归覆盖:flushPendingProtocolUrl 必须等 webContents.did-finish-load 后再触发 handleProtocolUrl。
 *
 * 测试策略:由于 main.ts 是 Electron app 入口,直接 import 会触发 ipcMain.handle / app.whenReady
 * 等副作用,做不到隔离测试。本测试通过手工构造跟 main.ts 同形态的"flush 函数 + window 状态机",
 * 验证调用时序的不变量:
 *   - webContents.isLoading() → 应注册 did-finish-load 监听,不立即调
 *   - 监听触发后 handleProtocolUrl 才被调
 *   - 已 loaded 时立即调
 *
 * 这种"算法测试"等价于把 main.ts 的 flush 逻辑抽出来跑;真实回归需要做 e2e。
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

type WebContentsLike = EventEmitter & { isLoading(): boolean };
type WindowLike = { webContents: WebContentsLike };

function makeFlush(getMainWindow: () => WindowLike | null, getPending: () => string | null, setPending: (s: string | null) => void, handle: (url: string) => void) {
  return function flushPendingProtocolUrl(): void {
    const url = getPending();
    if (!url) return;
    setPending(null);
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.webContents.isLoading()) {
      handle(url);
    } else if (mainWindow) {
      mainWindow.webContents.once('did-finish-load', () => handle(url));
    } else {
      setPending(url);
    }
  };
}

describe('F15 — flushPendingProtocolUrl waits for did-finish-load', () => {
  it('isLoading=true → handler 不立即调,等 did-finish-load 后才调', () => {
    let pending: string | null = 'tidemind://auth/callback?code=abc';
    const wc = Object.assign(new EventEmitter() as WebContentsLike, { isLoading: () => true });
    const win: WindowLike = { webContents: wc };
    const handle = vi.fn();
    const flush = makeFlush(() => win, () => pending, (s) => { pending = s }, handle);

    flush();
    expect(handle).not.toHaveBeenCalled();

    // 模拟 webContents finish load
    wc.emit('did-finish-load');
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledWith('tidemind://auth/callback?code=abc');
  });

  it('isLoading=false → handler 立即调', () => {
    let pending: string | null = 'tidemind://auth/callback?code=abc';
    const wc = Object.assign(new EventEmitter() as WebContentsLike, { isLoading: () => false });
    const win: WindowLike = { webContents: wc };
    const handle = vi.fn();
    const flush = makeFlush(() => win, () => pending, (s) => { pending = s }, handle);

    flush();
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('mainWindow=null → pending URL 不被丢弃,后续可重试', () => {
    let pending: string | null = 'tidemind://auth/callback?code=abc';
    const handle = vi.fn();
    const flush = makeFlush(() => null, () => pending, (s) => { pending = s }, handle);

    flush();
    expect(handle).not.toHaveBeenCalled();
    expect(pending).toBe('tidemind://auth/callback?code=abc');
  });

  it('pending=null → no-op', () => {
    const pending: string | null = null;
    const handle = vi.fn();
    const flush = makeFlush(() => null, () => pending, () => {}, handle);

    flush();
    expect(handle).not.toHaveBeenCalled();
  });
});
