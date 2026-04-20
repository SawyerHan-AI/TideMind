import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { safeStorage } from 'electron';
import { createLogger } from '../../../src/utils/logger.js';
import { getConfig, getDataDir } from '../../../src/config.js';

const log = createLogger('cloud-auth');

export interface CloudAuth {
  accessToken: string;
  refreshToken: string;
  userId: string;
  email: string;
  plan: string | null;
  expiresAt: number; // Unix timestamp ms
  lastSyncedAt: string | null;
}

let cachedAuth: CloudAuth | null = null;
let pendingOAuthState: string | null = null;

// ---- Persistent storage ----

function getTokenPath(): string {
  return path.join(getDataDir(), 'cloud-auth.json');
}

function saveAuthToDisk(): void {
  if (!cachedAuth) {
    try { fs.unlinkSync(getTokenPath()); } catch { /* ignore */ }
    return;
  }
  try {
    const json = JSON.stringify(cachedAuth);
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(json);
      fs.writeFileSync(getTokenPath(), encrypted, { mode: 0o600 });
    } else {
      fs.writeFileSync(getTokenPath(), json, { mode: 0o600 });
    }
  } catch (err) {
    log.warn(`failed to persist auth: ${(err as Error).message}`);
  }
}

function loadAuthFromDisk(): void {
  try {
    const filePath = getTokenPath();
    const raw = fs.readFileSync(filePath);
    let json: string;
    if (safeStorage.isEncryptionAvailable()) {
      try {
        // Try decrypting (new encrypted format)
        json = safeStorage.decryptString(raw);
      } catch {
        // Fall back to plaintext (migration from old format)
        json = raw.toString('utf-8');
        // Re-save in encrypted format
        try {
          cachedAuth = JSON.parse(json);
          saveAuthToDisk();
          log.info('migrated auth to encrypted storage');
          return;
        } catch {
          cachedAuth = null;
          return;
        }
      }
    } else {
      json = raw.toString('utf-8');
    }
    cachedAuth = JSON.parse(json);
    log.info('restored auth session from disk');
  } catch {
    cachedAuth = null;
  }
}

/** Call once at startup to restore previous session */
export function initAuth(): void {
  loadAuthFromDisk();
}

// ---- Public API ----

export function getCloudBaseUrl(): string {
  return getConfig().cloud?.server_url ?? 'https://cloud.tidemind.ai';
}

export function isLoggedIn(): boolean { return cachedAuth !== null; }
export function getCloudAuth(): CloudAuth | null { return cachedAuth; }

/** Get the URL to open in the browser for login */
export function getLoginUrl(): string {
  const base = getCloudBaseUrl();
  pendingOAuthState = crypto.randomBytes(16).toString('hex');
  // state 必须嵌入 redirect URL 本身，而非作为登录页面的独立 query 参数——
  // 服务器只会把 redirect URL 原样传回，不会提取并转发外部的 state 参数
  const redirect = `tidemind://auth/callback?state=${pendingOAuthState}`;
  return `${base}/auth/login?redirect=${encodeURIComponent(redirect)}`;
}

/** Get the URL to open in the browser for registration */
export function getRegisterUrl(): string {
  const base = getCloudBaseUrl();
  pendingOAuthState = crypto.randomBytes(16).toString('hex');
  const redirect = `tidemind://auth/callback?state=${pendingOAuthState}`;
  return `${base}/auth/register?redirect=${encodeURIComponent(redirect)}`;
}

/**
 * Handle OAuth callback from tidemind:// protocol.
 * Called when the browser redirects back after login.
 */
export async function handleOAuthCallback(url: string): Promise<CloudAuth> {
  const parsed = new URL(url);

  // CSRF validation: verify state parameter matches what we sent
  const callbackState = parsed.searchParams.get('state');
  if (pendingOAuthState === null || callbackState !== pendingOAuthState) {
    pendingOAuthState = null;
    log.error('OAuth state mismatch — possible CSRF attack, ignoring callback');
    throw new Error('OAuth state mismatch');
  }
  pendingOAuthState = null;

  const accessToken = parsed.searchParams.get('access_token');
  const refreshToken = parsed.searchParams.get('refresh_token');
  const expiresIn = parseInt(parsed.searchParams.get('expires_in') || '3600', 10);

  if (!accessToken || !refreshToken) {
    const error = parsed.searchParams.get('error') || 'Missing tokens in callback';
    throw new Error(error);
  }

  cachedAuth = {
    accessToken,
    refreshToken,
    userId: '',
    email: '',
    plan: null,
    expiresAt: Date.now() + (expiresIn * 1000),
    lastSyncedAt: null,
  };

  // Fetch user info
  const base = getCloudBaseUrl();
  try {
    const meRes = await fetch(`${base}/auth/me`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    if (meRes.ok) {
      const body = await meRes.json() as { user: { id: string; email: string; plan?: string } };
      cachedAuth.userId = body.user.id;
      cachedAuth.email = body.user.email;
      if (body.user.plan) cachedAuth.plan = body.user.plan;
    } else {
      log.warn(`/auth/me returned ${meRes.status}: ${await meRes.text().catch(() => '')}`);
    }
  } catch (err) {
    log.warn(`/auth/me fetch failed: ${(err as Error).message}`);
  }

  saveAuthToDisk();
  log.info(`logged in via OAuth callback as ${cachedAuth.email}`);
  return cachedAuth;
}

/** Login with email/password (direct API call, kept for backward compat) */
export async function login(email: string, password: string): Promise<CloudAuth> {
  const base = getCloudBaseUrl();
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `Login failed (${res.status})` }));
    throw new Error(err.error ?? `Login failed (${res.status})`);
  }
  const data = await res.json() as { access_token: string; refresh_token: string; expires_in: number; plan?: string };
  cachedAuth = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    userId: '',
    email,
    plan: data.plan ?? null,
    expiresAt: Date.now() + (data.expires_in * 1000),
    lastSyncedAt: null,
  };
  // Get user info
  try {
    const meRes = await fetch(`${base}/auth/me`, {
      headers: { 'Authorization': `Bearer ${data.access_token}` },
    });
    if (meRes.ok) {
      const me = await meRes.json() as { id: string; plan?: string };
      cachedAuth.userId = me.id;
      if (me.plan) cachedAuth.plan = me.plan;
    }
  } catch { /* ignore */ }

  saveAuthToDisk();
  log.info(`logged in as ${email}`);
  return cachedAuth;
}

export async function logout(): Promise<void> {
  cachedAuth = null;
  saveAuthToDisk();
  log.info('logged out');
}

/**
 * 按需刷新 access token。
 *
 * 返回值语义:
 *  - string:拿到可用 token(旧的或刚刷的)
 *  - null:**永久性失败**,已清除登录态。常见于:refresh token 真的过期/被撤销(400/401),
 *    或本地根本没登录过。调用方应提示用户重新登录。
 *
 * 抛异常:**临时性失败**(网络错误、5xx、超时)。登录态保留,调用方可以选择稍后重试
 * 而不是把用户"无声登出"——否则网络一抖用户的 outbox 就永久卡住。
 *
 * 额外:5xx 有一次短暂退避重试,避开边缘波动。
 */
export async function refreshTokenIfNeeded(): Promise<string | null> {
  if (!cachedAuth) return null;
  if (Date.now() < cachedAuth.expiresAt - 5 * 60 * 1000) {
    return cachedAuth.accessToken; // Still valid
  }
  const base = getCloudBaseUrl();
  const body = JSON.stringify({ grant_type: 'refresh_token', refresh_token: cachedAuth.refreshToken });

  const attempt = async (): Promise<Response> => fetch(`${base}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  let res: Response;
  try {
    res = await attempt();
    // 5xx 给一次短退避重试
    if (res.status >= 500 && res.status < 600) {
      await new Promise(r => setTimeout(r, 500));
      res = await attempt();
    }
  } catch (err) {
    // 网络层错误 = 临时失败,保留登录态
    log.warn(`refreshToken network failure: ${(err as Error).message} — keeping session`);
    throw new Error(`refresh_token transient: ${(err as Error).message}`);
  }

  if (res.ok) {
    const data = await res.json() as { access_token: string; refresh_token: string; expires_in: number };
    cachedAuth.accessToken = data.access_token;
    cachedAuth.refreshToken = data.refresh_token;
    cachedAuth.expiresAt = Date.now() + (data.expires_in * 1000);
    saveAuthToDisk();
    return cachedAuth.accessToken;
  }

  // 400 / 401 / 403 = 凭据真的坏了,清除。其他非 2xx(包括重试后仍 5xx)保留并抛异常。
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    log.error(`refreshToken permanent failure: ${res.status} — logging out`);
    cachedAuth = null;
    saveAuthToDisk();
    return null;
  }

  const bodyText = await res.text().catch(() => '');
  log.warn(`refreshToken unexpected status ${res.status}: ${bodyText.slice(0, 200)} — keeping session`);
  throw new Error(`refresh_token transient: HTTP ${res.status}`);
}
