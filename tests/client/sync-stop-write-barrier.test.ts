import { afterEach, describe, expect, it, vi } from 'vitest';
import { seedNode, setupTestDb } from '../helpers/test-db.js';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  Notification: { isSupported: () => false },
}));
vi.mock('../../client/electron/cloud/auth-client.js', () => ({
  getCloudBaseUrl: () => 'https://cloud.test.example',
  refreshTokenIfNeeded: async () => 'token',
}));

import { CloudSyncClient } from '../../client/electron/cloud/sync-client.js';
import { Reconciler } from '../../client/electron/cloud/reconciler.js';
import { pumpUplink } from '../../client/electron/cloud/uplink.js';
import { runExclusive } from '../../client/electron/cloud/reconcile-lock.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('cloud stop write barrier', () => {
  it.each(['fetch', 'body'] as const)('drops pull response stopped during %s without advancing cursor', async stage => {
    const db = setupTestDb();
    const client = new CloudSyncClient(db);
    const response = deferred<Response>();
    const body = deferred<unknown>();
    vi.stubGlobal('fetch', vi.fn(() => stage === 'fetch' ? response.promise : Promise.resolve({ ok: true, json: () => body.promise })));
    const pending = client.pullChanges('token');
    // Let fetch resolve so the body case suspends at json().
    await Promise.resolve();
    client.stop();
    response.resolve(new Response(JSON.stringify({ changes: [{ table: 'nodes', action: 'upsert', sync_version: 7, data: { id: 'late-node', type: 'fact', content: 'synthetic', created: '2026-11-08T00:00:00Z' } }], has_more: false })));
    body.resolve({ changes: [{ table: 'nodes', sync_version: 7, data: { id: 'late-node' } }], has_more: false });
    expect(await pending).toBe(0);
    expect(db.prepare("SELECT value FROM metadata WHERE key = 'cloud_last_synced_version'").get()).toBeUndefined();
    expect(db.prepare("SELECT id FROM nodes WHERE id = 'late-node'").get()).toBeUndefined();
    db.close();
  });

  it('applies a normal pull and advances cursor', async () => {
    const db = setupTestDb();
    const client = new CloudSyncClient(db);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ changes: [{ table: 'nodes', action: 'upsert', sync_version: 7, data: { id: 'normal-node', type: 'fact', content: 'synthetic', created: '2026-11-08T00:00:00Z' } }], has_more: false }))));
    expect(await client.pullChanges('token')).toBe(1);
    expect(db.prepare("SELECT id FROM nodes WHERE id = 'normal-node'").get()).toBeDefined();
    expect(db.prepare("SELECT value FROM metadata WHERE key = 'cloud_last_synced_version'").get()).toEqual({ value: '7' });
    client.stop(); db.close();
  });

  it('does not store generation parameters after stop while response body is pending', async () => {
    const db = setupTestDb();
    const client = new CloudSyncClient(db);
    const body = deferred<unknown>();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: () => body.promise })));
    const pending = (client as unknown as { recomputeMetabolismGeneration: (token: string) => Promise<void> }).recomputeMetabolismGeneration('token');
    await Promise.resolve();
    client.stop();
    body.resolve({ decay_generation: 7, decay_base: 0.8, decay_damping: 0.4 });
    await pending;
    expect(db.prepare("SELECT key FROM metadata WHERE key IN ('cloud.decay_base', 'cloud.decay_damping')").all()).toEqual([]);
    db.close();
  });

  it.each(['response', 'failure'] as const)('stop synchronously restores uplink dirty IDs before DB close and ignores late %s', async outcome => {
    const db = setupTestDb();
    const client = new CloudSyncClient(db);
    const node = seedNode(db, { content: 'synthetic shutdown memory' });
    const network = deferred<Response>();
    const fetchMock = vi.fn(() => network.promise);
    vi.stubGlobal('fetch', fetchMock);
    const pending = pumpUplink(db);
    await Promise.resolve();
    expect(db.prepare("SELECT id FROM cloud_dirty WHERE tbl='nodes' AND id=?").get(node.id)).toBeUndefined();
    client.stop();
    expect(db.prepare("SELECT id FROM cloud_dirty WHERE tbl='nodes' AND id=?").get(node.id)).toEqual({ id: node.id });
    const prepare = vi.spyOn(db, 'prepare');
    const transaction = vi.spyOn(db, 'transaction');
    db.close();
    network.resolve(outcome === 'response' ? new Response(JSON.stringify({ processed: 1 })) : new Response('failure', { status: 500 }));
    expect(await pending).toBe(0);
    expect(prepare).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stop aborts an active reconcile before its pending download or metadata can write', async () => {
    const db = setupTestDb();
    const client = new CloudSyncClient(db);
    const reconciler = new Reconciler(db);
    const download = deferred<Array<Record<string, unknown>>>();
    const entered = deferred<void>();
    const internals = reconciler as unknown as {
      fetchServerManifest: () => Promise<unknown[]>;
      bulkFetch: () => Promise<Array<Record<string, unknown>>>;
    };
    vi.spyOn(internals, 'fetchServerManifest').mockResolvedValue([{ id: 'late-node', updated: '2026-11-08T00:00:00Z', sync_version: 1, archived: false }]);
    vi.spyOn(internals, 'bulkFetch').mockImplementation(() => { entered.resolve(); return download.promise; });
    const pending = runExclusive(async register => { register(reconciler); return reconciler.runAll(false); });
    await entered.promise;
    client.stop();
    // Closing DB makes any later metadata write a test failure too.
    db.close();
    download.resolve([{ id: 'late-node', type: 'fact', content: 'synthetic' }]);
    const result = await pending;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.flatMap(r => r.errors)).toContain('aborted');
  });
});
