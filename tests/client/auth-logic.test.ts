import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Inlined from client/electron/cloud/auth-client.ts ──

function isTokenExpired(
  expiresAt: number,
  bufferMs: number = 5 * 60 * 1000,
): boolean {
  return Date.now() >= expiresAt - bufferMs;
}

function parseOAuthCallback(urlString: string): {
  accessToken: string | null;
  refreshToken: string | null;
  expiresIn: number;
  error: string | null;
} {
  const parsed = new URL(urlString);
  return {
    accessToken: parsed.searchParams.get('access_token'),
    refreshToken: parsed.searchParams.get('refresh_token'),
    expiresIn: parseInt(parsed.searchParams.get('expires_in') || '3600', 10),
    error: parsed.searchParams.get('error'),
  };
}

function getCloudBaseUrl(configUrl?: string): string {
  return configUrl ?? 'https://cloud.tidemind.ai';
}

function getLoginUrl(baseUrl: string): string {
  const redirect = 'tidemind://auth/callback';
  return `${baseUrl}/auth/login?redirect=${encodeURIComponent(redirect)}`;
}

function getRegisterUrl(baseUrl: string): string {
  const redirect = 'tidemind://auth/callback';
  return `${baseUrl}/auth/register?redirect=${encodeURIComponent(redirect)}`;
}

// ── Tests ──

describe('isTokenExpired', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const now = new Date('2026-01-15T12:00:00Z').getTime();

  it('token expiring in 10 minutes → not expired (with 5min buffer)', () => {
    const expiresAt = now + 10 * 60 * 1000;
    expect(isTokenExpired(expiresAt)).toBe(false);
  });

  it('token expiring in 4 minutes → expired (within 5min buffer)', () => {
    const expiresAt = now + 4 * 60 * 1000;
    expect(isTokenExpired(expiresAt)).toBe(true);
  });

  it('token expiring in exactly 5 minutes → expired (boundary)', () => {
    const expiresAt = now + 5 * 60 * 1000;
    expect(isTokenExpired(expiresAt)).toBe(true);
  });

  it('token already expired → expired', () => {
    const expiresAt = now - 60 * 1000;
    expect(isTokenExpired(expiresAt)).toBe(true);
  });

  it('token expiring in 1 hour → not expired', () => {
    const expiresAt = now + 60 * 60 * 1000;
    expect(isTokenExpired(expiresAt)).toBe(false);
  });

  it('custom buffer: 1 minute buffer with 2 min remaining → not expired', () => {
    const expiresAt = now + 2 * 60 * 1000;
    const bufferMs = 1 * 60 * 1000;
    expect(isTokenExpired(expiresAt, bufferMs)).toBe(false);
  });
});

describe('parseOAuthCallback', () => {
  it('valid callback with all params', () => {
    const url =
      'tidemind://auth/callback?access_token=abc123&refresh_token=ref456&expires_in=7200';
    const result = parseOAuthCallback(url);
    expect(result).toEqual({
      accessToken: 'abc123',
      refreshToken: 'ref456',
      expiresIn: 7200,
      error: null,
    });
  });

  it('missing access_token → null', () => {
    const url = 'tidemind://auth/callback?refresh_token=ref456&expires_in=7200';
    const result = parseOAuthCallback(url);
    expect(result.accessToken).toBeNull();
  });

  it('missing refresh_token → null', () => {
    const url = 'tidemind://auth/callback?access_token=abc123&expires_in=7200';
    const result = parseOAuthCallback(url);
    expect(result.refreshToken).toBeNull();
  });

  it('default expires_in when not provided → 3600', () => {
    const url =
      'tidemind://auth/callback?access_token=abc123&refresh_token=ref456';
    const result = parseOAuthCallback(url);
    expect(result.expiresIn).toBe(3600);
  });

  it('custom expires_in parsed correctly', () => {
    const url = 'tidemind://auth/callback?expires_in=1800';
    const result = parseOAuthCallback(url);
    expect(result.expiresIn).toBe(1800);
  });

  it('error parameter present', () => {
    const url = 'tidemind://auth/callback?error=access_denied';
    const result = parseOAuthCallback(url);
    expect(result.error).toBe('access_denied');
  });

  it('both tokens and error present', () => {
    const url =
      'tidemind://auth/callback?access_token=abc&refresh_token=ref&error=some_error';
    const result = parseOAuthCallback(url);
    expect(result.accessToken).toBe('abc');
    expect(result.refreshToken).toBe('ref');
    expect(result.error).toBe('some_error');
  });

  it('tidemind:// protocol URL works', () => {
    const url = 'tidemind://auth/callback?access_token=tok123';
    const result = parseOAuthCallback(url);
    expect(result.accessToken).toBe('tok123');
  });

  it('URL with extra params preserves token params', () => {
    const url =
      'tidemind://auth/callback?access_token=abc&refresh_token=ref&state=xyz&nonce=123';
    const result = parseOAuthCallback(url);
    expect(result.accessToken).toBe('abc');
    expect(result.refreshToken).toBe('ref');
  });
});

describe('getCloudBaseUrl', () => {
  it('default when no config → https://cloud.tidemind.ai', () => {
    expect(getCloudBaseUrl()).toBe('https://cloud.tidemind.ai');
  });

  it('custom URL from config → returns as-is', () => {
    expect(getCloudBaseUrl('https://custom.example.com')).toBe(
      'https://custom.example.com',
    );
  });

  it('undefined config → default', () => {
    expect(getCloudBaseUrl(undefined)).toBe('https://cloud.tidemind.ai');
  });
});

describe('getLoginUrl', () => {
  it('correct path appended', () => {
    const url = getLoginUrl('https://cloud.tidemind.ai');
    expect(url).toContain('/auth/login');
  });

  it('redirect param is URL-encoded', () => {
    const url = getLoginUrl('https://cloud.tidemind.ai');
    expect(url).toContain(
      `redirect=${encodeURIComponent('tidemind://auth/callback')}`,
    );
  });

  it('works with custom base URL', () => {
    const url = getLoginUrl('https://custom.example.com');
    expect(url).toBe(
      `https://custom.example.com/auth/login?redirect=${encodeURIComponent('tidemind://auth/callback')}`,
    );
  });
});

describe('getRegisterUrl', () => {
  it('correct path appended', () => {
    const url = getRegisterUrl('https://cloud.tidemind.ai');
    expect(url).toContain('/auth/register');
  });

  it('redirect param is URL-encoded', () => {
    const url = getRegisterUrl('https://cloud.tidemind.ai');
    expect(url).toContain(
      `redirect=${encodeURIComponent('tidemind://auth/callback')}`,
    );
  });

  it('works with custom base URL', () => {
    const url = getRegisterUrl('https://custom.example.com');
    expect(url).toBe(
      `https://custom.example.com/auth/register?redirect=${encodeURIComponent('tidemind://auth/callback')}`,
    );
  });
});
