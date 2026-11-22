import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

const env = vi.hoisted(() => ({ loggedIn: true, syncEnabled: true, legacyOff: false, token: 'tk' as string | null }));
vi.mock('../../client/electron/cloud/auth-client.js', () => ({
  isLoggedIn: () => env.loggedIn,
  refreshTokenIfNeeded: async () => env.token,
  getCloudBaseUrl: () => 'https://cloud.test',
}));
vi.mock('@server/config.js', () => ({
  getConfig: () => ({ cloud: { sync_enabled: env.syncEnabled }, metabolism: { background_enabled: !env.legacyOff } }),
}));
const mockApp = { getVersion: () => '0.0.0-test' };
vi.mock('electron', () => ({ app: mockApp, default: { app: mockApp } }));
vi.mock('../../client/node_modules/electron/index.js', () => ({ app: mockApp, default: { app: mockApp } }));

import { createTestDb } from '../../src/db/connection.js';
import { readLocalRoleRecord, writeLocalRole } from '../../src/metabolism/local-role.js';

let db: Database.Database;
let fetchSpy: ReturnType<typeof vi.spyOn>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
async function load() {
  vi.resetModules();
  const role = await import('../../client/electron/cloud/primary-device.js');
  const device = await import('../../client/electron/cloud/device.js');
  return { role, device };
}

beforeEach(() => {
  db = createTestDb();
  Object.assign(env, { loggedIn: true, syncEnabled: true, legacyOff: false, token: 'tk' });
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});
afterEach(() => { fetchSpy.mockRestore(); db.close(); });

describe('local role evaluation', () => {
  it('not signed in or sync off: this device organizes', async () => {
    const { role } = await load();
    writeLocalRole(db, { organizer: false, revision: 4, source: 'server' });
    env.loggedIn = false;
    role.evaluateLocalRole(db);
    expect(readLocalRoleRecord(db)).toEqual({ organizer: true, revision: null, source: 'local' });
    env.loggedIn = true; env.syncEnabled = false;
    writeLocalRole(db, { organizer: false, revision: 4, source: 'server' });
    role.evaluateLocalRole(db);
    expect(readLocalRoleRecord(db)?.organizer).toBe(true);
  });

  it('signed in with sync on: stands by until the server answers, keeps a known server role', async () => {
    const { role } = await load();
    role.evaluateLocalRole(db);
    expect(readLocalRoleRecord(db)).toEqual({ organizer: false, revision: null, source: 'local' });
    writeLocalRole(db, { organizer: true, revision: 2, source: 'server' });
    role.evaluateLocalRole(db);
    expect(readLocalRoleRecord(db)).toEqual({ organizer: true, revision: 2, source: 'server' });
  });

  it('registration decides the role and notifies only on change', async () => {
    const { role } = await load();
    const changed = vi.fn();
    role.setLocalRoleChangeListener(changed);
    role.evaluateLocalRole(db);
    changed.mockClear();
    fetchSpy.mockResolvedValueOnce(json({ id: 'dev-1', is_primary: true, primary_device_id: 'dev-1', primary_device_revision: 1 }));
    await role.syncRoleWithServer(db);
    expect(readLocalRoleRecord(db)).toEqual({ organizer: true, revision: 1, source: 'server' });
    expect(changed).toHaveBeenCalledTimes(1);
    role.applyPrimaryState(db, { primaryDeviceId: 'dev-1', revision: 1 });
    expect(changed).toHaveBeenCalledTimes(1);
    role.applyPrimaryState(db, { primaryDeviceId: 'dev-2', revision: 2 });
    expect(readLocalRoleRecord(db)).toEqual({ organizer: false, revision: 2, source: 'server' });
    expect(changed).toHaveBeenCalledTimes(2);
    // a late notification with an older revision is ignored
    role.applyPrimaryState(db, { primaryDeviceId: 'dev-1', revision: 1 });
    expect(readLocalRoleRecord(db)?.organizer).toBe(false);
  });

  it('sends the installation id, and claims_primary=false only when the legacy switch was off', async () => {
    let { role, device } = await load();
    fetchSpy.mockResolvedValueOnce(json({ id: 'dev-1', is_primary: true, primary_device_id: 'dev-1', primary_device_revision: 1 }));
    await role.syncRoleWithServer(db);
    const first = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(first.installation_id).toBe(device.getInstallationId(db));
    expect('claims_primary' in first).toBe(false);
    env.legacyOff = true;
    ({ role, device } = await load());
    fetchSpy.mockResolvedValueOnce(json({ id: 'dev-1', is_primary: false, primary_device_id: null, primary_device_revision: 0 }));
    await role.syncRoleWithServer(db);
    const second = JSON.parse((fetchSpy.mock.calls[1][1] as RequestInit).body as string);
    expect(second.claims_primary).toBe(false);
    expect(second.installation_id).toBe(first.installation_id);
  });

  it('a cloud that was not upgraded keeps the legacy switch behaviour', async () => {
    const { role } = await load();
    fetchSpy.mockResolvedValueOnce(json({ id: 'dev-1', updated: true }));
    await role.syncRoleWithServer(db);
    expect(readLocalRoleRecord(db)).toEqual({ organizer: true, revision: null, source: 'legacy' });
    env.legacyOff = true;
    fetchSpy.mockResolvedValueOnce(json({ id: 'dev-1', updated: true }));
    await role.syncRoleWithServer(db, { force: true });
    expect(readLocalRoleRecord(db)?.organizer).toBe(false);
  });

  it('a failed registration keeps the written role and still releases the startup wait', async () => {
    const { role } = await load();
    role.evaluateLocalRole(db);
    const waiting = role.waitForInitialRole(30_000);
    fetchSpy.mockRejectedValueOnce(new Error('offline'));
    await role.syncRoleWithServer(db);
    await waiting;
    expect(readLocalRoleRecord(db)).toEqual({ organizer: false, revision: null, source: 'local' });
  }, 30_000);

  it('startup wait: skipped when sync is off, bounded by the timeout otherwise', async () => {
    const { role } = await load();
    env.syncEnabled = false;
    await role.waitForInitialRole(60_000);
    env.syncEnabled = true;
    const started = Date.now();
    await role.waitForInitialRole(150);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  }, 30_000);

  it('concurrent registrations share one request', async () => {
    const { device } = await load();
    fetchSpy.mockResolvedValue(json({ id: 'dev-1', is_primary: true, primary_device_id: 'dev-1', primary_device_revision: 1 }));
    await Promise.all([device.ensureRegistered(db), device.ensureRegistered(db), device.ensureRegistered(db)]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await device.ensureRegistered(db);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await device.ensureRegistered(db, { force: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('releases the primary role only when this device holds it', async () => {
    const { role } = await load();
    writeLocalRole(db, { organizer: false, revision: 2, source: 'server' });
    await role.releasePrimaryIfHeld(db);
    expect(fetchSpy).not.toHaveBeenCalled();
    writeLocalRole(db, { organizer: true, revision: 3, source: 'server' });
    fetchSpy.mockResolvedValueOnce(json({ primary_device_id: null, primary_device_revision: 4, changed: true }));
    await role.releasePrimaryIfHeld(db);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://cloud.test/api/v1/sync/primary-device');
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>)['X-TideMind-Installation-Id']).toBeTruthy();
  });

  it('setPrimaryDevice applies the server answer to this device', async () => {
    const { role } = await load();
    fetchSpy
      .mockResolvedValueOnce(json({ id: 'dev-2', is_primary: false, primary_device_id: 'dev-1', primary_device_revision: 1 }))
      .mockResolvedValueOnce(json({ primary_device_id: 'dev-2', primary_device_revision: 2, changed: true }));
    await role.setPrimaryDevice(db, 'dev-2');
    expect(readLocalRoleRecord(db)).toEqual({ organizer: true, revision: 2, source: 'server' });
  });
});

describe('registration outcomes', () => {
  const limit = () => json({ error: 'quota_exceeded', resource: 'device', limit: 2, current: 2 }, 403);
  const registered = () => json({ id: 'dev-9', is_primary: false, primary_device_id: 'dev-1', primary_device_revision: 4 });

  it('classifies every way a registration can end', async () => {
    const { role } = await load();
    env.token = null;
    expect(await role.syncRoleOutcome(db, { force: true })).toEqual({ status: 'not_signed_in' });
    env.token = 'tk';
    fetchSpy.mockResolvedValueOnce(json({ error: 'Token revoked' }, 401));
    expect((await role.syncRoleOutcome(db, { force: true })).status).toBe('unauthorized');
    fetchSpy.mockResolvedValueOnce(json({ error: 'forbidden' }, 403));           // 认不出的 403 不算设备数超限
    expect((await role.syncRoleOutcome(db, { force: true })).status).toBe('transient');
    fetchSpy.mockResolvedValueOnce(json({ error: 'boom' }, 500));
    expect((await role.syncRoleOutcome(db, { force: true })).status).toBe('transient');
    fetchSpy.mockRejectedValueOnce(new Error('offline'));
    expect((await role.syncRoleOutcome(db, { force: true })).status).toBe('transient');
    fetchSpy.mockResolvedValueOnce(limit());
    expect(await role.syncRoleOutcome(db, { force: true })).toEqual({ status: 'device_limit', limit: 2 });
  });

  it('device limit: this device stands by and stops re-registering in the background', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-11-20T00:00:00Z'));
      const { role } = await load();
      writeLocalRole(db, { organizer: true, revision: 3, source: 'server' });
      fetchSpy.mockImplementation(async () => limit());
      await role.syncRoleOutcome(db, { force: true });
      expect(readLocalRoleRecord(db)).toEqual({ organizer: false, revision: null, source: 'local' });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      await role.syncRoleOutcome(db);                         // 不带 force：不发请求
      await role.syncRoleOutcome(db, { force: true });        // 后台 force：10 分钟内不发
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      await role.syncRoleOutcome(db, { userInitiated: true }); // 用户操作：30 秒内不发
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      vi.setSystemTime(new Date('2026-11-20T00:00:31Z'));
      await role.syncRoleOutcome(db, { userInitiated: true });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      vi.setSystemTime(new Date('2026-11-20T00:05:00Z'));
      await role.syncRoleOutcome(db, { force: true });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      vi.setSystemTime(new Date('2026-11-20T00:11:00Z'));
      await role.syncRoleOutcome(db, { force: true });
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  }, 30_000);

  it('registering after a device limit releases the parked uploads; clearing the limit retries at once', async () => {
    const { role, device } = await load();
    fetchSpy.mockResolvedValueOnce(limit());
    await role.syncRoleOutcome(db, { force: true });
    db.prepare("INSERT INTO cloud_sync_excluded (tbl, id, reason, created) VALUES ('nodes', 'n1', 'device_not_registered', 't'), ('nodes', 'n2', 'not_primary_device', 't')").run();
    device.clearDeviceLimit();
    fetchSpy.mockResolvedValueOnce(registered());
    expect((await role.syncRoleOutcome(db)).status).toBe('registered');
    expect(db.prepare('SELECT id FROM cloud_sync_excluded').all()).toEqual([{ id: 'n2' }]);
    expect(db.prepare("SELECT id FROM cloud_dirty WHERE tbl = 'nodes'").all()).toEqual([{ id: 'n1' }]);
    expect(db.prepare("SELECT 1 AS x FROM metadata WHERE key = 'cloud.upload_release_at'").get()).toEqual({ x: 1 });
  });

  it('records the first successful registration once and keeps it across later registrations', async () => {
    const { role, device } = await load();
    expect(device.getFirstRegisteredAt(db)).toBeNull();
    fetchSpy.mockImplementation(async () => registered());
    await role.syncRoleOutcome(db, { force: true });
    const first = device.getFirstRegisteredAt(db);
    expect(first).not.toBeNull();
    await new Promise(r => setTimeout(r, 5));
    await role.syncRoleOutcome(db, { force: true });
    expect(device.getFirstRegisteredAt(db)).toBe(first);
    device.clearFirstRegisteredAt(db);
    expect(device.getFirstRegisteredAt(db)).toBeNull();
  });
});

describe('fetchDeviceList', () => {
  const devices = { devices: [{ id: 'dev-1', name: 'starsea-mac', is_primary: true, online: true }], primary_device_id: 'dev-1', primary_device_revision: 2 };
  const route = (register: () => Response) => fetchSpy.mockImplementation(async (_url, init) =>
    (init as RequestInit).method === 'POST' ? register() : json(devices));

  it('registered: marks this device', async () => {
    const { role } = await load();
    route(() => json({ id: 'dev-2', is_primary: false, primary_device_id: 'dev-1', primary_device_revision: 2 }));
    expect(await role.fetchDeviceList(db)).toMatchObject({ thisDeviceId: 'dev-2', primaryDeviceId: 'dev-1', registration: 'registered', deviceLimit: null, cloudNotUpgraded: false });
  });

  it('device limit: reports it with the limit and no row for this device', async () => {
    const { role } = await load();
    route(() => json({ error: 'quota_exceeded', resource: 'device', limit: 2, current: 2 }, 403));
    expect(await role.fetchDeviceList(db)).toMatchObject({ thisDeviceId: null, registration: 'device_limit', deviceLimit: 2 });
  });

  it('registration could not be checked: unavailable, not a device limit', async () => {
    const { role } = await load();
    route(() => json({ error: 'boom' }, 500));
    expect(await role.fetchDeviceList(db)).toMatchObject({ thisDeviceId: null, registration: 'unavailable', deviceLimit: null });
  });
});

