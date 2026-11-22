import type Database from 'better-sqlite3';
import { getConfig } from '@server/config.js';
import { readLocalRoleRecord, writeLocalRole } from '@server/metabolism/local-role.js';
import { createLogger } from '@server/utils/logger.js';
import { getCloudBaseUrl, isLoggedIn, refreshTokenIfNeeded } from './auth-client.js';
import {
  INSTALLATION_ID_HEADER, ensureRegisteredOutcome, getInstallationId, getLastRegistration,
  getLastRegistrationOutcome, resetDeviceRegistration,
  type DeviceRegistration, type RegistrationOutcome,
} from './device.js';
import { clearDeferredUploads, releaseParkedUploads } from './upload-deferral.js';
import { noteUnauthorized } from './unauthorized.js';

/**
 * 本机角色（是否承担后台记忆整理）的求值与写入。
 *
 * 设计：docs/design/primary-device-selection-2026-11-20.md §5。
 * 只有桌面端主进程写；调度器、向量运行时、MCP 进程、daemon 读同一个键。
 */
const log = createLogger('primary-device');

let onRoleChanged: ((db: Database.Database) => void) | null = null;

let resolveInitialRole: (() => void) | null = null;
let initialRole: Promise<void> | null = null;
let initialRoleSettled = false;

/** 角色变化时的回调（刷新向量运行时、让代谢 Worker 换代）。由主进程注入，避免循环依赖。 */
export function setLocalRoleChangeListener(listener: ((db: Database.Database) => void) | null): void {
  onRoleChanged = listener;
}

/** 旧的本地开关被用户明确关掉。默认值是开，所以读到 false 即用户显式写入。 */
function legacySwitchOff(): boolean {
  try { return getConfig().metabolism?.background_enabled === false; } catch { return false; }
}

function syncActive(): boolean {
  try { return isLoggedIn() && getConfig().cloud?.sync_enabled === true; } catch { return false; }
}

function commit(db: Database.Database, next: Parameters<typeof writeLocalRole>[1]): void {
  let changed = false;
  try { changed = writeLocalRole(db, next); } catch (error) {
    log.warn(`local role write failed: ${(error as Error).message}`);
    return;
  }
  if (!changed) return;
  // 角色变了，之前因“无法定论”而推迟的上传可以立即重试。
  clearDeferredUploads();
  log.info(`本机后台整理角色: ${next.organizer ? '承担' : '不承担'} (${next.source})`);
  try { onRoleChanged?.(db); } catch (error) { log.warn(`role change hook failed: ${(error as Error).message}`); }
}

/**
 * 不联网的求值。登录状态或同步开关发生任何变化时调用。
 * - 未登录或未开同步：本机承担整理。
 * - 已登录且开启同步：沿用云端给过的角色；从未取得过则先不承担，等 syncRoleWithServer。
 */
export function evaluateLocalRole(db: Database.Database): void {
  if (!syncActive()) {
    resetDeviceRegistration();
    commit(db, { organizer: true, revision: null, source: 'local' });
    return;
  }
  let current = null;
  try { current = readLocalRoleRecord(db); } catch { /* 视为从未取得 */ }
  if (current && current.source !== 'local') return;
  commit(db, { organizer: false, revision: null, source: 'local' });
}

function applyRegistration(db: Database.Database, registration: DeviceRegistration): void {
  if (!syncActive()) return;
  if (registration.cloudNotUpgraded) {
    commit(db, { organizer: !legacySwitchOff(), revision: null, source: 'legacy' });
    return;
  }
  commit(db, { organizer: registration.isPrimary, revision: registration.revision, source: 'server' });
}

/** 通道通知、接口返回的主设备状态。需要已知本机的设备 ID。 */
export function applyPrimaryState(
  db: Database.Database,
  state: { primaryDeviceId: string | null; revision: number },
): void {
  if (!syncActive()) return;
  const deviceId = getLastRegistration()?.id;
  if (!deviceId) {
    // 还不知道本机的设备 ID（注册未完成或失败过）：改为向云端注册并取回当前状态。
    void syncRoleWithServer(db, { force: true });
    return;
  }
  commit(db, { organizer: state.primaryDeviceId === deviceId, revision: state.revision, source: 'server' });
}

/**
 * 向云端注册（或刷新）本机并按返回写入角色。失败时保持已写入的值。
 * 首次调用结束（无论成败）后，waitForInitialRole 放行。
 */
export async function syncRoleWithServer(
  db: Database.Database,
  options: { force?: boolean; userInitiated?: boolean } = {},
): Promise<DeviceRegistration | null> {
  const outcome = await syncRoleOutcome(db, options);
  return outcome.status === 'registered' ? outcome.registration : null;
}

/** 同 syncRoleWithServer，但返回带状态的注册结果。 */
export async function syncRoleOutcome(
  db: Database.Database,
  options: { force?: boolean; userInitiated?: boolean } = {},
): Promise<RegistrationOutcome> {
  try {
    if (!syncActive()) return { status: 'not_signed_in' };
    const before = getLastRegistrationOutcome()?.status;
    const outcome = await ensureRegisteredOutcome(db, {
      force: options.force,
      userInitiated: options.userInitiated,
      claimsPrimary: legacySwitchOff() ? false : undefined,
    });
    if (outcome.status === 'registered') {
      applyRegistration(db, outcome.registration);
      // 设备数超限期间暂存的整理结果在注册成功后放行。不依赖“上一次结果”：
      // 计划变化会先清掉超限状态，重启后内存里也没有上一次结果。
      try {
        const released = syncActive() ? releaseParkedUploads(db) : 0;
        if (released > 0) log.info(`设备已注册：放行 ${released} 条暂存的上传记录`);
      } catch (error) { log.warn(`release of parked uploads failed: ${(error as Error).message}`); }
      // 由问不到变为已注册：之前推迟的上传可以立即重试。已注册状态下的重复复核不清，
      // 否则退避会被每一次复核打断。
      if (before !== undefined && before !== 'registered') clearDeferredUploads();
    } else if (outcome.status === 'device_limit' && syncActive()) {
      // 没有在云端注册的设备不可能是主设备。
      commit(db, { organizer: false, revision: null, source: 'local' });
    }
    return outcome;
  } catch (error) {
    log.warn(`role sync failed: ${(error as Error).message}`);
    return { status: 'transient', detail: (error as Error).message };
  } finally {
    initialRoleSettled = true;
    resolveInitialRole?.();
  }
}

/**
 * daemon 启动前等待首次角色同步：只在已登录且开启同步时等待，最多 timeoutMs。
 * 超时按已写入的值启动。
 */
export async function waitForInitialRole(timeoutMs: number): Promise<void> {
  if (!syncActive()) return;
  if (initialRoleSettled || getLastRegistration()) return;
  initialRole ??= new Promise<void>((resolve) => { resolveInitialRole = resolve; });
  let timer: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([
    initialRole,
    new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
  ]);
  if (timer) clearTimeout(timer);
}

async function authorizedFetch(db: Database.Database, path: string, init: RequestInit): Promise<Response | null> {
  const token = await refreshTokenIfNeeded();
  if (!token) return null;
  const res = await fetch(`${getCloudBaseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      [INSTALLATION_ID_HEADER]: getInstallationId(db),
      ...(init.headers as Record<string, string> | undefined),
    },
    signal: AbortSignal.timeout(15_000),
  });
  noteUnauthorized(res.status);
  return res;
}

/**
 * 主设备登出或关闭同步之前释放身份，让其他设备可以接管。尽力而为，失败不阻塞。
 */
export async function releasePrimaryIfHeld(db: Database.Database): Promise<void> {
  try {
    const current = readLocalRoleRecord(db);
    if (!current || current.source !== 'server' || !current.organizer) return;
    await authorizedFetch(db, '/api/v1/sync/primary-device', { method: 'DELETE' });
  } catch (error) {
    log.warn(`primary device release failed (continuing): ${(error as Error).message}`);
  }
}

export interface DeviceListItem {
  id: string;
  name: string;
  device_type: string | null;
  app_version: string | null;
  last_seen: string | null;
  is_primary: boolean;
  online: boolean;
}

export interface DeviceListResult {
  devices: DeviceListItem[];
  thisDeviceId: string | null;
  primaryDeviceId: string | null;
  cloudNotUpgraded: boolean;
  /** 本机在云端的注册状态。device_limit = 账号的设备数已达上限，本机没有注册。 */
  registration: 'registered' | 'device_limit' | 'unavailable';
  /** 设备数上限；只在 device_limit 且云端给出数值时有值。 */
  deviceLimit: number | null;
}

export async function fetchDeviceList(db: Database.Database): Promise<DeviceListResult> {
  // 打开账号页或点“重试”是用户主动操作：设备数超限时也重新注册一次（至多每 30 秒）。
  const outcome = await syncRoleOutcome(db, { userInitiated: getLastRegistrationOutcome()?.status === 'device_limit' });
  const registration = outcome.status === 'registered' ? outcome.registration : null;
  const res = await authorizedFetch(db, '/api/v1/sync/devices', { method: 'GET' });
  if (!res) throw new Error('not_logged_in');
  if (!res.ok) throw new Error(`devices ${res.status}`);
  const data = await res.json() as {
    devices?: Array<Record<string, unknown>>; primary_device_id?: unknown; primary_device_revision?: unknown;
  };
  const upgraded = typeof data.primary_device_revision === 'number';
  const primaryDeviceId = typeof data.primary_device_id === 'string' ? data.primary_device_id : null;
  if (upgraded) applyPrimaryState(db, { primaryDeviceId, revision: data.primary_device_revision as number });
  return {
    devices: (data.devices ?? []).map(d => ({
      id: String(d.id),
      name: String(d.name ?? ''),
      device_type: typeof d.device_type === 'string' ? d.device_type : null,
      app_version: typeof d.app_version === 'string' ? d.app_version : null,
      last_seen: typeof d.last_seen === 'string' ? d.last_seen : null,
      is_primary: d.is_primary === true,
      online: d.online === true,
    })),
    thisDeviceId: registration?.id ?? getLastRegistration()?.id ?? null,
    primaryDeviceId,
    cloudNotUpgraded: !upgraded,
    registration: outcome.status === 'registered' ? 'registered' : outcome.status === 'device_limit' ? 'device_limit' : 'unavailable',
    deviceLimit: outcome.status === 'device_limit' ? outcome.limit : null,
  };
}

export async function setPrimaryDevice(db: Database.Database, deviceId: string): Promise<void> {
  // 确保本机设备 ID 已知，才能判断切换后本机是不是主设备。
  await syncRoleWithServer(db);
  const res = await authorizedFetch(db, '/api/v1/sync/primary-device', {
    method: 'PUT', body: JSON.stringify({ device_id: deviceId }),
  });
  if (!res) throw new Error('not_logged_in');
  if (!res.ok) throw new Error(`primary-device ${res.status}`);
  const data = await res.json() as { primary_device_id?: unknown; primary_device_revision?: unknown };
  if (typeof data.primary_device_revision !== 'number') throw new Error('cloud_not_upgraded');
  applyPrimaryState(db, {
    primaryDeviceId: typeof data.primary_device_id === 'string' ? data.primary_device_id : null,
    revision: data.primary_device_revision,
  });
}
