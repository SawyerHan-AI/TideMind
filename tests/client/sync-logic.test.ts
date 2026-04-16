import { describe, it, expect } from 'vitest';

// ── Inlined from client/electron/cloud/sync-client.ts ──

type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline';

const WS_RECONNECT_BASE_MS = 1_000;
const WS_RECONNECT_MAX_MS = 30_000;

function calculateReconnectDelay(attempts: number): number {
  return Math.min(
    WS_RECONNECT_BASE_MS * Math.pow(2, attempts),
    WS_RECONNECT_MAX_MS,
  );
}

/** Simulates the error handling logic in syncOnce() */
function handleSyncError(errorMessage: string): {
  status: SyncStatus;
  cloudNotAvailable: boolean;
} {
  if (errorMessage === 'cloud_not_available') {
    return { status: 'offline', cloudNotAvailable: true };
  }
  return { status: 'error', cloudNotAvailable: false };
}

/** Simulates the pull error detection in pullChanges() */
async function detectPullError(
  statusCode: number,
  body: Record<string, unknown>,
): Promise<string> {
  if (statusCode === 403 && body.error === 'cloud_not_available') {
    return 'cloud_not_available';
  }
  return `Pull failed: ${statusCode}`;
}

// ── Tests ──

describe('calculateReconnectDelay', () => {
  it('attempt 0 → 1000ms', () => {
    expect(calculateReconnectDelay(0)).toBe(1000);
  });

  it('attempt 1 → 2000ms', () => {
    expect(calculateReconnectDelay(1)).toBe(2000);
  });

  it('attempt 2 → 4000ms', () => {
    expect(calculateReconnectDelay(2)).toBe(4000);
  });

  it('attempt 3 → 8000ms', () => {
    expect(calculateReconnectDelay(3)).toBe(8000);
  });

  it('attempt 4 → 16000ms', () => {
    expect(calculateReconnectDelay(4)).toBe(16000);
  });

  it('attempt 5 → capped at 30000ms', () => {
    expect(calculateReconnectDelay(5)).toBe(30000);
  });

  it('attempt 10 → still capped at 30000ms', () => {
    expect(calculateReconnectDelay(10)).toBe(30000);
  });

  it('exponential growth follows 2^n pattern', () => {
    for (let n = 0; n < 5; n++) {
      expect(calculateReconnectDelay(n)).toBe(
        WS_RECONNECT_BASE_MS * Math.pow(2, n),
      );
    }
  });
});

describe('handleSyncError', () => {
  it('cloud_not_available → offline status with cloudNotAvailable true', () => {
    const result = handleSyncError('cloud_not_available');
    expect(result).toEqual({ status: 'offline', cloudNotAvailable: true });
  });

  it('Pull failed: 403 → error status with cloudNotAvailable false', () => {
    const result = handleSyncError('Pull failed: 403');
    expect(result).toEqual({ status: 'error', cloudNotAvailable: false });
  });

  it('Pull failed: 500 → error status with cloudNotAvailable false', () => {
    const result = handleSyncError('Pull failed: 500');
    expect(result).toEqual({ status: 'error', cloudNotAvailable: false });
  });

  it('network error → error status with cloudNotAvailable false', () => {
    const result = handleSyncError('network error');
    expect(result).toEqual({ status: 'error', cloudNotAvailable: false });
  });

  it('empty string → error status with cloudNotAvailable false', () => {
    const result = handleSyncError('');
    expect(result).toEqual({ status: 'error', cloudNotAvailable: false });
  });
});

describe('detectPullError', () => {
  it('403 with cloud_not_available → returns cloud_not_available', async () => {
    const result = await detectPullError(403, {
      error: 'cloud_not_available',
    });
    expect(result).toBe('cloud_not_available');
  });

  it('403 with other error → returns Pull failed: 403', async () => {
    const result = await detectPullError(403, {
      error: 'forbidden',
    });
    expect(result).toBe('Pull failed: 403');
  });

  it('401 → returns Pull failed: 401', async () => {
    const result = await detectPullError(401, {});
    expect(result).toBe('Pull failed: 401');
  });

  it('500 → returns Pull failed: 500', async () => {
    const result = await detectPullError(500, {
      error: 'internal_server_error',
    });
    expect(result).toBe('Pull failed: 500');
  });

  it('200 → returns Pull failed: 200', async () => {
    const result = await detectPullError(200, {});
    expect(result).toBe('Pull failed: 200');
  });
});
