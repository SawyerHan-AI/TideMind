import { getConfig } from '../../../src/config.js';
import { getCloudBaseUrl, refreshTokenIfNeeded } from './auth-client.js';

let preferenceQueue: Promise<void> = Promise.resolve();

/** Explicit opt-in must reach the server before any data sync starts. */
export function pushCloudMetabolismEnabled(enabled?: boolean): Promise<void> {
  const config = getConfig();
  const desired = enabled ?? (config.cloud?.metabolism_enabled === true && config.cloud?.sync_enabled === true);
  const pending = preferenceQueue.then(() => sendCloudMetabolismEnabled(desired));
  preferenceQueue = pending.catch(() => {});
  return pending;
}

async function sendCloudMetabolismEnabled(desired: boolean): Promise<void> {
  const token = await refreshTokenIfNeeded();
  if (!token) throw new Error('not_logged_in');
  const res = await fetch(`${getCloudBaseUrl()}/api/v1/sync/metabolism`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: desired }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Cloud metabolism preference failed (HTTP ${res.status})`);
  const result = await res.json() as { enabled?: unknown };
  if (result.enabled !== desired) throw new Error('Cloud metabolism preference was not confirmed');
}
