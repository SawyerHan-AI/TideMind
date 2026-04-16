import { createLogger } from '../../../src/utils/logger.js';
import { getCloudBaseUrl, getCloudAuth } from './auth-client.js';
import { app } from 'electron';
import os from 'node:os';

const log = createLogger('cloud-device');

let deviceId: string | null = null;

export function getDeviceId(): string | null { return deviceId; }

export async function registerDevice(): Promise<string | null> {
  const auth = getCloudAuth();
  if (!auth) return null;

  const base = getCloudBaseUrl();
  try {
    const res = await fetch(`${base}/api/v1/sync/devices`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${auth.accessToken}`,
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
