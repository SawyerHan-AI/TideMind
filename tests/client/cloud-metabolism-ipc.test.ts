import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const state = vi.hoisted(() => ({ dir: '', handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(), push: vi.fn(), reload: vi.fn(), notify: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: { handle: (key: string, fn: (...args: unknown[]) => Promise<unknown>) => state.handlers.set(key, fn) }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../client/node_modules/electron/index.js', () => ({ ipcMain: { handle: (key: string, fn: (...args: unknown[]) => Promise<unknown>) => state.handlers.set(key, fn) }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../client/electron/cloud/auth-client.js', () => ({ isLoggedIn: () => true }));
vi.mock('../../client/electron/cloud/sync-client.js', () => ({ destroySyncClient: vi.fn() }));
vi.mock('../../src/config.js', () => ({ getDataDir: () => state.dir, getConfig: () => ({ cloud: { sync_enabled: true, metabolism_enabled: false } }), reloadConfig: state.reload }));
vi.mock('../../client/electron/cloud/metabolism-settings.js', () => ({ pushCloudMetabolismEnabled: state.push }));
vi.mock('../../client/electron/workers/metabolism-worker-runtime-mutations.js', () => ({ notifyMetabolismWorkerRuntimeMutation: state.notify }));
vi.mock('../../client/electron/cloud/outbox.js', () => ({ getOutboxDiagnostics: vi.fn() }));
import { registerCloudHandlers } from '../../client/electron/ipc/cloud.js';
beforeEach(() => { state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-cloud-settings-')); state.push.mockReset(); state.reload.mockClear(); state.notify.mockClear(); registerCloudHandlers(); });
afterEach(() => { fs.rmSync(state.dir, { recursive: true, force: true }); });
const invoke = (enabled: boolean) => state.handlers.get('cloud:set-metabolism-enabled')!(null, enabled);
describe('cloud metabolism setting IPC coordination', () => {
  it('does not overwrite local preference when server confirmation fails', async () => {
    const p = path.join(state.dir, 'config.toml'); const original = '[cloud]\nmetabolism_enabled = false\n'; fs.writeFileSync(p, original);
    state.push.mockRejectedValue(new Error('synthetic network error'));
    expect(await invoke(true)).toMatchObject({ success: false, error: 'sync_error' });
    expect(fs.readFileSync(p, 'utf8')).toBe(original); expect(state.reload).not.toHaveBeenCalled();
  });
  it('preserves config symlink and unrelated edits made while awaiting server confirmation', async () => {
    const target = path.join(state.dir, 'actual.toml'); const entry = path.join(state.dir, 'config.toml'); fs.writeFileSync(target, '[cloud]\nmetabolism_enabled = false\n'); fs.symlinkSync(target, entry);
    state.push.mockImplementation(async () => { fs.writeFileSync(target, 'name = "synthetic"\n[cloud]\nmetabolism_enabled = false\n'); });
    expect(await invoke(true)).toEqual({ success: true });
    expect(fs.lstatSync(entry).isSymbolicLink()).toBe(true); const content = fs.readFileSync(target, 'utf8');
    expect(content).toContain('synthetic'); expect(content).toContain('metabolism_enabled = true'); expect(state.notify).toHaveBeenCalledWith('config');
  });
  it('persists sync off before a pending cloud notification and stays off after failure', async () => {
    const entry = path.join(state.dir, 'config.toml'); fs.writeFileSync(entry, '[cloud]\nsync_enabled = true\nenabled = true\n');
    let fail!: (error: Error) => void; state.push.mockReturnValue(new Promise<void>((_r, reject) => { fail = reject; }));
    const pending = state.handlers.get('cloud:set-sync-enabled')!(null, false);
    await vi.waitFor(() => expect(state.push).toHaveBeenCalledWith(false));
    expect(fs.readFileSync(entry, 'utf8')).toContain('sync_enabled = false');
    fail(new Error('synthetic offline')); expect(await pending).toMatchObject({ success: false, error: 'sync_error' });
    expect(fs.readFileSync(entry, 'utf8')).toContain('sync_enabled = false');
  });
  it('rejects damaged config before changing the server', async () => {
    fs.writeFileSync(path.join(state.dir, 'config.toml'), '[invalid');
    expect(await invoke(false)).toMatchObject({ success: false }); expect(state.push).not.toHaveBeenCalled();
  });
});
