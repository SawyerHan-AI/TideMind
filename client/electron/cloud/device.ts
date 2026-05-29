import { createLogger } from '../../../src/utils/logger.js';
import { getCloudBaseUrl, refreshTokenIfNeeded } from './auth-client.js';
import { app } from 'electron';
import os from 'node:os';

const log = createLogger('cloud-device');

let deviceId: string | null = null;

export function getDeviceId(): string | null { return deviceId; }

export async function registerDevice(): Promise<string | null> {
  const base = getCloudBaseUrl();
  try {
    // 走 refreshTokenIfNeeded() 而不是直接读 getCloudAuth(),避免开机/长时间离线后
    // 缓存 access token 已过期还硬发出去 401(本层其他 caller 全走 refresh)。
    // refresh 在 transient 失败时会 throw,刚好被下方 catch 兜住,下次 start() 重注册。
    const token = await refreshTokenIfNeeded();
    if (!token) return null; // 未登录或 refresh 永久失败
    const res = await fetch(`${base}/api/v1/sync/devices`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: os.hostname(),
        device_type: `desktop-${process.platform}`,
        os_version: os.release(),
        app_version: app.getVersion(),
      }),
    });

    if (!res.ok) {
      log.warn(`device registration failed: ${res.status}`);
      return null;
    }

    const data = await res.json();
    deviceId = data.id;
    log.info(`device registered: ${deviceId}`);
    return deviceId;
  } catch (e) {
    log.warn(`device registration error: ${(e as Error).message}`);
    return null;
  }
}
