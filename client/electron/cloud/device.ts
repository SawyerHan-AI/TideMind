import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../../../src/utils/logger.js';
import { getCloudBaseUrl, refreshTokenIfNeeded } from './auth-client.js';
import { app } from 'electron';
import { noteUnauthorized } from './unauthorized.js';
import os from 'node:os';

const log = createLogger('cloud-device');

export const INSTALLATION_ID_HEADER = 'X-TideMind-Installation-Id';
const INSTALLATION_KEY = 'cloud.installation_id';
const INSTALLATION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export interface DeviceRegistration {
  id: string;
  isPrimary: boolean;
  primaryDeviceId: string | null;
  /** null = 云端尚未升级（响应里没有主设备字段）。 */
  revision: number | null;
  cloudNotUpgraded: boolean;
}

/**
 * 一次注册的结果。调用方要能区分“暂时问不到”和“云端明确拒绝”：
 * 前者保持现状稍后重试，后者（设备数超限）不能反复重试，也不能当作断网处理。
 */
export type RegistrationOutcome =
  | { status: 'registered'; registration: DeviceRegistration }
  | { status: 'not_signed_in' }
  | { status: 'device_limit'; limit: number | null }
  | { status: 'unauthorized' }
  | { status: 'transient'; detail: string };

const FIRST_REGISTERED_KEY = 'cloud.first_registered_at';
/** 设备数超限后，后台调用与用户主动操作各自的最短重试间隔。 */
const DEVICE_LIMIT_BACKGROUND_RETRY_MS = 10 * 60 * 1000;
const DEVICE_LIMIT_USER_RETRY_MS = 30 * 1000;

let deviceId: string | null = null;
let lastRegistration: DeviceRegistration | null = null;
let lastOutcome: RegistrationOutcome | null = null;
let deviceLimitAt = 0;
let inflight: Promise<RegistrationOutcome> | null = null;

export function getDeviceId(): string | null { return deviceId; }
export function getLastRegistration(): DeviceRegistration | null { return lastRegistration; }
export function getLastRegistrationOutcome(): RegistrationOutcome | null { return lastOutcome; }

/** 本机首次注册成功的时间；从未注册成功过为 null。 */
export function getFirstRegisteredAt(db: Database.Database): number | null {
  try {
    const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(FIRST_REGISTERED_KEY) as { value: string } | undefined;
    const time = row ? Date.parse(row.value) : NaN;
    return Number.isFinite(time) ? time : null;
  } catch { return null; }
}

export function clearFirstRegisteredAt(db: Database.Database): void {
  try { db.prepare('DELETE FROM metadata WHERE key = ?').run(FIRST_REGISTERED_KEY); } catch { /* 不阻塞登出 */ }
}

/**
 * 本机的安装标识：首次需要时生成，之后不变。云端按它识别设备，不再依赖主机名
 * （改名会产生新设备、两台同名设备会共用身份）。不随账号变化。
 */
export function getInstallationId(db: Database.Database): string {
  const read = (): string | null => {
    const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(INSTALLATION_KEY) as { value: string } | undefined;
    return row && INSTALLATION_ID_RE.test(row.value) ? row.value : null;
  };
  const existing = read();
  if (existing) return existing;
  // INSERT OR IGNORE + 回读：多个进程同时首次生成时都采用先写入的那个。
  db.prepare('INSERT OR IGNORE INTO metadata (key, value) VALUES (?, ?)').run(INSTALLATION_KEY, randomUUID());
  const stored = read();
  if (stored) return stored;
  const fresh = randomUUID();
  db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(INSTALLATION_KEY, fresh);
  return fresh;
}

async function register(
  db?: Database.Database,
  options: { claimsPrimary?: boolean } = {},
): Promise<RegistrationOutcome> {
  const outcome = await requestRegistration(db, options);
  lastOutcome = outcome;
  if (outcome.status === 'device_limit') deviceLimitAt = Date.now();
  if (outcome.status === 'unauthorized') noteUnauthorized(401);
  if (outcome.status === 'registered' && db) {
    try {
      db.prepare('INSERT OR IGNORE INTO metadata (key, value) VALUES (?, ?)').run(FIRST_REGISTERED_KEY, new Date().toISOString());
    } catch { /* 只影响首次同步豁免的判断，不阻塞注册 */ }
  }
  return outcome;
}

async function requestRegistration(
  db?: Database.Database,
  options: { claimsPrimary?: boolean } = {},
): Promise<RegistrationOutcome> {
  const base = getCloudBaseUrl();
  try {
    // 走 refreshTokenIfNeeded() 而不是直接读 getCloudAuth(),避免开机/长时间离线后
    // 缓存 access token 已过期还硬发出去 401(本层其他 caller 全走 refresh)。
    // refresh 在 transient 失败时会 throw,刚好被下方 catch 兜住,下次 start() 重注册。
    const token = await refreshTokenIfNeeded();
    if (!token) return { status: 'not_signed_in' }; // 未登录或 refresh 永久失败
    const body: Record<string, unknown> = {
      name: os.hostname(),
      device_type: `desktop-${process.platform}`,
      os_version: os.release(),
      app_version: app.getVersion(),
    };
    if (db) body.installation_id = getInstallationId(db);
    // 迁移：旧的本地开关明确为“关”的设备不应在账号尚无主设备时被自动选为主设备。
    if (options.claimsPrimary === false) body.claims_primary = false;
    const res = await fetch(`${base}/api/v1/sync/devices`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      // undici 默认 ~300s;device 注册是 fire-and-forget 但黑洞网络下也别挂半小时。
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      log.warn(`device registration failed: ${res.status}`);
      if (res.status === 401) return { status: 'unauthorized' };
      if (res.status === 403) {
        // 只有能解析为设备配额的 403 才算“设备数超限”；其余 403 一律按暂时失败处理。
        const body = await res.json().catch(() => null) as { error?: unknown; resource?: unknown; limit?: unknown } | null;
        if (body?.error === 'quota_exceeded' && body.resource === 'device') {
          return { status: 'device_limit', limit: typeof body.limit === 'number' ? body.limit : null };
        }
      }
      return { status: 'transient', detail: `HTTP ${res.status}` };
    }

    const data = await res.json() as {
      id: string; is_primary?: unknown; primary_device_id?: unknown; primary_device_revision?: unknown;
    };
    deviceId = data.id;
    const upgraded = typeof data.primary_device_revision === 'number';
    lastRegistration = {
      id: data.id,
      isPrimary: upgraded && data.is_primary === true,
      primaryDeviceId: typeof data.primary_device_id === 'string' ? data.primary_device_id : null,
      revision: upgraded ? data.primary_device_revision as number : null,
      cloudNotUpgraded: !upgraded,
    };
    log.info(`device registered: ${deviceId}`);
    return { status: 'registered', registration: lastRegistration };
  } catch (e) {
    log.warn(`device registration error: ${(e as Error).message}`);
    return { status: 'transient', detail: (e as Error).message };
  }
}

export async function registerDevice(db?: Database.Database): Promise<string | null> {
  const outcome = await register(db);
  return outcome.status === 'registered' ? outcome.registration.id : null;
}

/**
 * 注册（或刷新）本机设备并取回账号的主设备状态。并发调用共用同一次请求。
 * force=false 时，本进程已注册过就直接返回上次结果。
 */
export async function ensureRegistered(
  db: Database.Database,
  options: { force?: boolean; claimsPrimary?: boolean } = {},
): Promise<DeviceRegistration | null> {
  const outcome = await ensureRegisteredOutcome(db, options);
  return outcome.status === 'registered' ? outcome.registration : null;
}

/**
 * 同 ensureRegistered，但返回带状态的结果。
 * 设备数超限是云端的明确拒绝：之后不带 force 的调用不再发请求；带 force 的后台调用
 * 至多每 10 分钟一次，用户主动操作（userInitiated）至多每 30 秒一次。
 */
export function ensureRegisteredOutcome(
  db: Database.Database,
  options: { force?: boolean; claimsPrimary?: boolean; userInitiated?: boolean } = {},
): Promise<RegistrationOutcome> {
  if (inflight) return inflight;
  if (lastOutcome?.status === 'device_limit') {
    const wait = options.userInitiated ? DEVICE_LIMIT_USER_RETRY_MS : DEVICE_LIMIT_BACKGROUND_RETRY_MS;
    if ((!options.force && !options.userInitiated) || Date.now() - deviceLimitAt < wait) return Promise.resolve(lastOutcome);
  } else if (!options.force && !options.userInitiated && lastRegistration) {
    return Promise.resolve({ status: 'registered', registration: lastRegistration });
  }
  const current = register(db, { claimsPrimary: options.claimsPrimary }).finally(() => {
    if (inflight === current) inflight = null;
  });
  inflight = current;
  return current;
}

/** 计划变化等情况下解除“设备数超限”的记忆，下一次调用会重新注册。 */
export function clearDeviceLimit(): void {
  if (lastOutcome?.status === 'device_limit') lastOutcome = null;
  deviceLimitAt = 0;
}

/** 登出 / 换账号后丢弃上一个账号的注册结果。 */
export function resetDeviceRegistration(): void {
  deviceId = null;
  lastRegistration = null;
  lastOutcome = null;
  deviceLimitAt = 0;
}
