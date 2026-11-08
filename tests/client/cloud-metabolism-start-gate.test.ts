import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb } from '../helpers/test-db.js';
const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, Notification: { isSupported: () => false } }));
vi.mock('../../client/electron/cloud/metabolism-settings.js', () => ({ pushCloudMetabolismEnabled: push }));
import { CloudSyncClient } from '../../client/electron/cloud/sync-client.js';
afterEach(() => { vi.useRealTimers(); push.mockReset(); });
describe('cloud metabolism startup gate', () => {
  it('does not begin data sync or schedule background work before server preference acknowledgement', async () => {
    vi.useFakeTimers(); const db = setupTestDb(); const client = new CloudSyncClient(db);
    let reject!: (e: Error) => void;
    push.mockReturnValue(new Promise((_resolve, r) => { reject = r; }));
    const sync = vi.spyOn(client, 'syncOnce').mockResolvedValue();
    const pending = client.start();
    expect(sync).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    reject(new Error('preference unavailable'));
    await expect(pending).rejects.toThrow('preference unavailable');
    expect(client.getStatus()).toBe('error'); expect(sync).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(1);
    client.stop(); db.close();
  });
  it('stop while preference is pending prevents late startup', async () => {
    vi.useFakeTimers(); const db = setupTestDb(); const client = new CloudSyncClient(db);
    let resolve!: () => void; push.mockReturnValue(new Promise<void>(r => { resolve = r; }));
    const sync = vi.spyOn(client, 'syncOnce').mockResolvedValue(); const pending = client.start();
    client.stop(); resolve(); await pending;
    expect(sync).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0); db.close();
  });
});
