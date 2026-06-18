import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { safeStorage } from 'electron';
import { createLogger } from '../../../src/utils/logger.js';
import { getConfig, getDataDir } from '../../../src/config.js';
import { secureStore } from './secure-store.js';

const log = createLogger('cloud-auth');

// secureStore 里 cloud-auth 的服务/账号命名。一旦定下不要改——改了等于丢
// 所有现存用户的 keychain 数据,他们要重登。
const STORE_SERVICE = 'TideMind';
const STORE_ACCOUNT = 'cloud-auth';

// 老格式的磁盘文件路径(safeStorage 加密的 cloud-auth.json),用于一次性迁移
function getLegacyTokenPath(): string {
  return path.join(getDataDir(), 'cloud-auth.json');
}

// 迁移完成 marker:写一个空文件标记"这台机器已经处理过 v0.2.69 → v0.2.70 迁移"。
// 防御 TimeMachine 部分还原、用户手工拷贝老文件等场景下重复触发迁移逻辑。
function getMigrationMarkerPath(): string {
  return path.join(getDataDir(), '.cloud-auth.migrated-v0.2.70');
}

// 迁移失败计数:连续失败超过阈值才放弃,给系统升级/钥匙串临时锁定等瞬态留出恢复窗口。
function getMigrationAttemptsPath(): string {
  return path.join(getDataDir(), '.cloud-auth.migration-attempts');
}

const MIGRATION_MAX_ATTEMPTS = 3;
// safeStorage 加密的最小开销:Chromium 实现是 3 字节版本前缀("v10"/"v11") +
// 16 字节 IV + 16 字节 GCM tag = 35 字节就算载荷为 0。真实 cloud-auth.json 有
// access_token+refresh_token 两个 JWT,实际大小 1-2KB。低于 64 字节必定是
// 损坏/截断,跳过 decrypt 直接当不可恢复,避免无意义的钥匙串弹窗。
const SAFE_STORAGE_MIN_BLOB_BYTES = 64;

/**
 * auth HTTP fetch 超时。undici 默认 ~300s,established-but-silent 连接会让
 * /auth/token、/auth/me、/auth/login 挂数分钟;经 inflightRefresh 复用后所有并发
 * caller 一起卡(sync / mcp / strategy-push / device / reconciler)。15s 后 abort,
 * refresh 失败归 transient(保留登录态,下次重试),login/me 失败按既有分支处理。
 */
const AUTH_FETCH_TIMEOUT_MS = 15_000;

// 客户端日志写本地 logs/,但仍按 PII 卫生掩码邮箱(避免日志被分享/上报泄漏)
function maskEmail(email: string | null | undefined): string {
  if (!email) return '';
  return email.replace(/(.{3}).*@/, '$1***@');
}

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
/**
 * 迁移逻辑单次保护。`initAuth()` 理论上只在 Electron 主进程启动时调用一次,
 * 但加这个 boolean 防御 hot-reload / 测试场景下的二次调用——避免出现"两次最后弹窗"。
 */
let migrationRan = false;
/**
 * PKCE verifier for the current in-flight OAuth. 与 pendingOAuthState 一对一关联。
 * 流程开始(getLoginUrl / getRegisterUrl)时生成并存内存;handleOAuthCallback
 * 成功或失败(state 不匹配)后清空,one-time use。
 *
 * 为什么 verifier 只在内存:PKCE 的全部价值在于"verifier 不离开设备"。
 * 即便 token 存 safeStorage 也没用——verifier 只在发起登录的那台机器、
 * 那次会话有效,重启 app 或 OAuth 超时后自动作废。
 */
let pendingPkceVerifier: string | null = null;

// ---- Persistent storage ----

/**
 * 持久化当前 cachedAuth(或在 cachedAuth=null 时清掉)。
 *
 * 返回:
 *   true  — 持久化成功(或后端不可用属于"已知拒绝落盘"的设计意图)
 *   false — 持久化**失败**,意味着内存 cachedAuth 跟磁盘不一致。caller 看到 false
 *           应该考虑回滚 cachedAuth(尤其是 refresh_token 旋转场景),避免下次启动
 *           读到老 token、被服务端 reject 后强制重登(audit-2 HIGH #3)。
 */
function saveAuthToDisk(): boolean {
  if (!cachedAuth) {
    try {
      secureStore.delete(STORE_SERVICE, STORE_ACCOUNT);
      return true;
    } catch (err) {
      // logout 是 trust boundary——delete 失败意味着 keychain 里还留着 token,
      // 下次启动会"自动登回去"。这对共享设备(家人/同事)是安全侵蚀(audit-2 MEDIUM)。
      // 不是 true(没真的清掉),也不是直接抛——抛会让 logout() flow 崩,反而更糟。
      // 返回 false 让 caller 决定要不要给用户错误提示。
      log.error(`failed to clear persisted auth on logout: ${(err as Error).message} — keychain item may remain`);
      return false;
    }
  }
  if (!secureStore.isAvailable()) {
    // 没有可用后端时拒绝落盘:refresh_token 是 long-lived 凭据,明文落盘风险高于
    // "用户重启后要重新登录"。这条 invariant 从 safeStorage 时代就有,本次迁移到
    // Data Protection Keychain 后保留——出错就强制重登,绝不让明文/弱加密的 token
    // 留在磁盘上。返回 true 因为这是设计意图(并非"持久化失败")。
    log.warn('secureStore unavailable — not persisting auth; re-login required after restart');
    return true;
  }
  try {
    const json = JSON.stringify(cachedAuth);
    secureStore.set(STORE_SERVICE, STORE_ACCOUNT, Buffer.from(json, 'utf-8'));
    return true;
  } catch (err) {
    log.error(`failed to persist auth: ${(err as Error).message} — cachedAuth in-memory may diverge from disk`);
    return false;
  }
}

function loadAuthFromDisk(): void {
  if (!secureStore.isAvailable()) {
    cachedAuth = null;
    return;
  }
  let buf: Buffer | null;
  try {
    buf = secureStore.get(STORE_SERVICE, STORE_ACCOUNT);
  } catch (err) {
    log.warn(`secureStore.get failed: ${(err as Error).message} — treating as logged out`);
    cachedAuth = null;
    return;
  }
  if (!buf) {
    cachedAuth = null;
    return;
  }
  try {
    cachedAuth = JSON.parse(buf.toString('utf-8'));
    // Audit-3 F5 修复:Parse 成功 != 数据合法。需要 schema 校验,防止畸形数据
    // (TimeMachine 半还原 / 手工修改 / 老 schema 残留)被加载后下游访问 accessToken
    // / refreshToken / expiresAt 字段时 undefined 触发崩溃。校验失败 → 清掉 + warn,
    // 等同于"未登录",让用户重登。
    if (!isValidCloudAuthShape(cachedAuth)) {
      log.warn('auth shape invalid after parse — clearing and treating as logged out');
      try { secureStore.delete(STORE_SERVICE, STORE_ACCOUNT); } catch { /* ignore */ }
      cachedAuth = null;
      return;
    }
    log.info('restored auth session from disk');
  } catch (err) {
    // 数据损坏:清掉,让用户重登。比静默挂死好。
    log.warn(`auth JSON parse failed: ${(err as Error).message} — clearing`);
    try { secureStore.delete(STORE_SERVICE, STORE_ACCOUNT); } catch { /* ignore */ }
    cachedAuth = null;
  }
}

/**
 * 一次性迁移:老用户磁盘上有 safeStorage 加密的 cloud-auth.json,
 * 把它读出来写到 Data Protection Keychain,然后删除老文件。
 *
 * 这一次会触发**最后一次** safeStorage 钥匙串弹窗——用户点允许后即完成迁移,
 * 之后所有读写都走 native 路径,永久无弹窗。
 *
 * **失败处理策略**(audit-3 CRITICAL #1 修复后的版本):
 *   原版本无条件 finally 删老文件,把所有失败(包括 macOS 升级中钥匙串临时锁定、
 *   secureStore.set 一次性 entitlement 探测失败等可恢复的瞬态错误)都当成永久失败,
 *   全量老用户在升级时遭遇瞬态故障 = refresh_token 一次性销毁。
 *
 *   修后:
 *     - 可恢复失败(safeStorage 临时不可用、native set 暂时失败) → 保留老文件,
 *       不写 marker,下次启动重试。最多重试 MIGRATION_MAX_ATTEMPTS 次。
 *     - 不可恢复失败(decryptString 抛"Decryption failed"、文件截断、JSON schema 错)
 *       → 写 marker,删老文件,提示重登。
 *
 * **幂等性**:
 *   迁移成功或永久失败后写一个 marker 文件,后续启动看到 marker 直接 skip,
 *   不论 cloud-auth.json 是否因为 TimeMachine 还原 / 手工拷贝而重新出现。
 *
 * 只在使用 native(macOS Data Protection Keychain)路径时跑——其他平台/紧急
 * 回退路径仍然用 safeStorage,跟历史数据格式一致,不需要迁移。
 */
function migrateLegacyAuthIfNeeded(): void {
  if (migrationRan) return;
  migrationRan = true;

  if (!secureStore.isUsingNative()) return;
  const legacyPath = getLegacyTokenPath();
  const markerPath = getMigrationMarkerPath();

  // 幂等 marker:已经处理过,什么都不做
  if (fs.existsSync(markerPath)) {
    // 如果不知道什么时候老文件又出现了,也顺手清一下(已经迁过/已经放弃过)
    if (fs.existsSync(legacyPath)) {
      try { fs.unlinkSync(legacyPath); } catch { /* ignore */ }
      log.info('legacy cloud-auth.json reappeared post-migration — removed (TimeMachine restore?)');
    }
    return;
  }

  if (!fs.existsSync(legacyPath)) {
    // 没有老文件 + 没有 marker = 新用户。写 marker 跳过未来检查。
    writeMigrationMarker('no-legacy-file');
    return;
  }

  log.info(`legacy cloud-auth.json detected — attempting migration to Data Protection Keychain (path=${legacyPath})`);

  // 新 store 已有数据 → 老文件是残留(可能是 TimeMachine 选择性还原),直接清掉
  let existing: Buffer | null;
  try {
    existing = secureStore.get(STORE_SERVICE, STORE_ACCOUNT);
  } catch (err) {
    // 探测失败 = 可恢复瞬态(audit-3 HIGH #5)。**保留老文件**,下次启动重试。
    // 不增加 attempts 计数:这是 probe 而不是真的迁移尝试。
    log.warn(`secureStore probe during migration failed: ${(err as Error).message} — will retry next launch`);
    return;
  }
  if (existing) {
    try { fs.unlinkSync(legacyPath); } catch { /* ignore */ }
    writeMigrationMarker('new-store-already-has-data');
    log.info('legacy file found but new store has data — removed legacy file');
    return;
  }

  // 真正的迁移:读老文件 → 写新 store。区分可恢复 vs 不可恢复失败。
  const attempts = readMigrationAttempts() + 1;

  // size 校验:safeStorage 加密 blob 不可能比 SAFE_STORAGE_MIN_BLOB_BYTES 短。
  // 截断/空文件直接当作不可恢复,避免无意义的钥匙串弹窗(audit-3 HIGH #6)。
  let raw: Buffer;
  try {
    raw = fs.readFileSync(legacyPath);
  } catch (err) {
    log.warn(`reading legacy file failed: ${(err as Error).message} — recoverable, will retry`);
    writeMigrationAttempts(attempts);
    return;
  }
  if (raw.length < SAFE_STORAGE_MIN_BLOB_BYTES) {
    log.warn(`legacy file truncated (${raw.length}B) — discarding without decrypt attempt`);
    finalizeMigrationFailure(legacyPath, 'truncated');
    return;
  }

  // safeStorage 可用性是可恢复瞬态。系统升级中钥匙串可能短暂未 unlock。
  if (!safeStorage.isEncryptionAvailable()) {
    if (attempts >= MIGRATION_MAX_ATTEMPTS) {
      log.error(`safeStorage unavailable after ${attempts} attempts — giving up, user must re-login`);
      finalizeMigrationFailure(legacyPath, 'safestorage-unavailable-permanent');
    } else {
      log.warn(`safeStorage unavailable (attempt ${attempts}/${MIGRATION_MAX_ATTEMPTS}) — will retry next launch`);
      writeMigrationAttempts(attempts);
    }
    return;
  }

  let json: string;
  try {
    json = safeStorage.decryptString(raw);  // ← 最后一次钥匙串弹窗
  } catch (err) {
    // decryptString 失败 = 密钥/密文不匹配(证书续期破坏了 ACL、用户在弹窗上点拒绝等)。
    // 这是不可恢复的——再试也是同样的错。
    log.error(`safeStorage.decryptString failed: ${(err as Error).message} — unrecoverable, user must re-login`);
    finalizeMigrationFailure(legacyPath, 'decrypt-failed');
    return;
  }

  // schema 校验:防止把畸形对象迁进新 store 后下游崩溃(audit-3 MEDIUM)
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    log.error(`legacy JSON parse failed: ${(err as Error).message} — unrecoverable`);
    finalizeMigrationFailure(legacyPath, 'json-parse-failed');
    return;
  }
  if (!isValidCloudAuthShape(parsed)) {
    log.error('legacy auth schema invalid (missing/wrong-type fields) — unrecoverable');
    finalizeMigrationFailure(legacyPath, 'schema-invalid');
    return;
  }

  // 写入新 store。set 失败 = 可恢复(entitlement 探测一过、磁盘满等)。
  try {
    secureStore.set(STORE_SERVICE, STORE_ACCOUNT, Buffer.from(json, 'utf-8'));
  } catch (err) {
    if (attempts >= MIGRATION_MAX_ATTEMPTS) {
      log.error(`secureStore.set failed after ${attempts} attempts: ${(err as Error).message} — giving up`);
      finalizeMigrationFailure(legacyPath, 'native-set-failed-permanent');
    } else {
      log.warn(`secureStore.set failed (attempt ${attempts}/${MIGRATION_MAX_ATTEMPTS}): ${(err as Error).message} — will retry`);
      writeMigrationAttempts(attempts);
    }
    return;
  }

  // 成功:删老文件、写 marker、清 attempts。
  try { fs.unlinkSync(legacyPath); } catch { /* ignore */ }
  try { fs.unlinkSync(getMigrationAttemptsPath()); } catch { /* ignore */ }
  writeMigrationMarker('migrated');
  log.info('migrated cloud-auth from safeStorage to Data Protection Keychain');
}

/** schema guard:防止把畸形 JSON 迁进新 store 后下游崩溃。 */
function isValidCloudAuthShape(x: unknown): x is CloudAuth {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return typeof o.accessToken === 'string'
    && typeof o.refreshToken === 'string'
    && typeof o.expiresAt === 'number'
    && (typeof o.userId === 'string' || o.userId == null)
    && (typeof o.email === 'string' || o.email == null);
}

function writeMigrationMarker(reason: string): void {
  try {
    fs.writeFileSync(getMigrationMarkerPath(), `${new Date().toISOString()} ${reason}\n`, { mode: 0o600 });
  } catch (err) {
    log.warn(`failed to write migration marker: ${(err as Error).message}`);
  }
}

function readMigrationAttempts(): number {
  try {
    const raw = fs.readFileSync(getMigrationAttemptsPath(), 'utf-8');
    const n = parseInt(raw.trim(), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeMigrationAttempts(n: number): void {
  try {
    fs.writeFileSync(getMigrationAttemptsPath(), String(n), { mode: 0o600 });
  } catch (err) {
    log.warn(`failed to persist migration attempts counter: ${(err as Error).message}`);
  }
}

function finalizeMigrationFailure(legacyPath: string, reason: string): void {
  try { fs.unlinkSync(legacyPath); } catch { /* ignore */ }
  try { fs.unlinkSync(getMigrationAttemptsPath()); } catch { /* ignore */ }
  writeMigrationMarker(`failed:${reason}`);
}

/** Call once at startup to restore previous session */
export function initAuth(): void {
  // 先尝试从老格式迁移(只对 macOS native 路径有意义,内部自判)
  migrateLegacyAuthIfNeeded();
  loadAuthFromDisk();
}

// ---- Public API ----

export function getCloudBaseUrl(): string {
  return getConfig().cloud?.server_url ?? 'https://cloud.tidemind.ai';
}

export function isLoggedIn(): boolean { return cachedAuth !== null; }

/**
 * Audit-3 F8 修复:返回 shallow clone 而非内部 cachedAuth 引用。
 * 之前 sync-client.ts 等模块直接 `auth.lastSyncedAt = ...` 修改返回对象,
 * 而该对象就是模块内部的 cachedAuth → 跳过 saveAuthToDisk,内存与磁盘漂移。
 * 现在 caller 拿到的是副本,改也不会回写;状态变更必须走 updateCloudAuth。
 */
export function getCloudAuth(): CloudAuth | null {
  return cachedAuth ? { ...cachedAuth } : null;
}

/**
 * Audit-3 F8:受控更新接口。所有需要修改 cachedAuth 字段的地方(lastSyncedAt 等)
 * 都应该通过这里 — 保证 in-memory 与 secureStore 持久化同步。
 */
export function updateCloudAuth(patch: Partial<CloudAuth>): void {
  if (!cachedAuth) return;
  cachedAuth = { ...cachedAuth, ...patch };
  saveAuthToDisk();
}

/**
 * 生成 PKCE S256 pair (RFC 7636)。
 *   - verifier: 43 字符 URL-safe base64(32 随机字节)
 *   - challenge: BASE64URL(SHA256(verifier))
 */
function generatePkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** 构造带 PKCE + state 的登录/注册 URL。PKCE verifier 存到内存,challenge 进 query。*/
function buildAuthUrl(kind: 'login' | 'register'): string {
  const base = getCloudBaseUrl();
  // P2-NEW-H: 连点两次 Login 时，第二次会无声覆盖第一次的 state/verifier —— 第一次
  // flow 回来做 CSRF 校验会失败。这里放弃第一次流是可接受的（用户意图就是新一次
  // 登录），仅记一条 warn 便于 ops 排查"登录一次失败" 的投诉。
  if (pendingOAuthState !== null) {
    log.warn('in-progress OAuth flow overwritten by new buildAuthUrl call');
  }
  pendingOAuthState = crypto.randomBytes(16).toString('hex');
  const pkce = generatePkce();
  pendingPkceVerifier = pkce.verifier;
  // state 必须嵌入 redirect URL 本身，而非作为登录页面的独立 query 参数——
  // 服务器只会把 redirect URL 原样传回，不会提取并转发外部的 state 参数
  const redirect = `tidemind://auth/callback?state=${pendingOAuthState}`;
  const params = new URLSearchParams({
    redirect,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
  });
  return `${base}/auth/${kind}?${params.toString()}`;
}

/** Get the URL to open in the browser for login */
export function getLoginUrl(): string {
  return buildAuthUrl('login');
}

/** Get the URL to open in the browser for registration */
export function getRegisterUrl(): string {
  return buildAuthUrl('register');
}

/**
 * Handle OAuth callback from tidemind:// protocol.
 * Called when the browser redirects back after login.
 *
 * 支持两种 callback 形态(服务端双协议并存期):
 *   1. Legacy:  ?access_token=...&refresh_token=...&expires_in=...
 *      → 直接使用 tokens(老协议,v0.2.37 及之前;v0.2.38 仍会在 fallback 路径遇到)
 *   2. PKCE:    ?code=...
 *      → POST /auth/token 带 code_verifier 换 tokens(OAuth 2.1)
 *
 * state 校验在 form 选择之前先做,verifier 不论走哪条路径都会清掉。
 */
export async function handleOAuthCallback(url: string): Promise<CloudAuth> {
  const parsed = new URL(url);

  // CSRF validation: verify state parameter matches what we sent
  const callbackState = parsed.searchParams.get('state');
  if (pendingOAuthState === null || callbackState !== pendingOAuthState) {
    pendingOAuthState = null;
    pendingPkceVerifier = null;
    log.error('OAuth state mismatch — possible CSRF attack, ignoring callback');
    throw new Error('OAuth state mismatch');
  }
  pendingOAuthState = null;
  // 保留 verifier 给 PKCE 交换用,但在两条路径结束前都会被清
  const verifier = pendingPkceVerifier;
  pendingPkceVerifier = null;

  const base = getCloudBaseUrl();
  let accessToken: string;
  let refreshToken: string;
  let expiresIn: number;

  const code = parsed.searchParams.get('code');
  if (code) {
    // PKCE 路径:用 code + verifier 换 tokens
    if (!verifier) {
      throw new Error('Missing PKCE verifier for authorization_code callback');
    }
    const redirectUri = `tidemind://auth/callback?state=${callbackState}`;
    const tokRes = await fetch(`${base}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }),
      signal: AbortSignal.timeout(AUTH_FETCH_TIMEOUT_MS),
    });
    if (!tokRes.ok) {
      const body = await tokRes.json().catch(() => ({ error: `token exchange failed (${tokRes.status})` }));
      throw new Error(body.error_description || body.error || `token exchange failed (${tokRes.status})`);
    }
    const data = await tokRes.json() as { access_token: string; refresh_token: string; expires_in: number };
    accessToken = data.access_token;
    refreshToken = data.refresh_token;
    expiresIn = data.expires_in;
  } else {
    // Legacy 路径:tokens 直接在 URL 里
    const at = parsed.searchParams.get('access_token');
    const rt = parsed.searchParams.get('refresh_token');
    if (!at || !rt) {
      const error = parsed.searchParams.get('error') || 'Missing tokens in callback';
      throw new Error(error);
    }
    accessToken = at;
    refreshToken = rt;
    expiresIn = parseInt(parsed.searchParams.get('expires_in') || '3600', 10);
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
  try {
    const meRes = await fetch(`${base}/auth/me`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(AUTH_FETCH_TIMEOUT_MS),
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
  log.info(`logged in via OAuth callback as ${maskEmail(cachedAuth.email)} (pkce=${code ? 'yes' : 'no'})`);
  return cachedAuth;
}

/** Login with email/password (direct API call, kept for backward compat) */
export async function login(email: string, password: string): Promise<CloudAuth> {
  const base = getCloudBaseUrl();
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(AUTH_FETCH_TIMEOUT_MS),
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
      signal: AbortSignal.timeout(AUTH_FETCH_TIMEOUT_MS),
    });
    if (meRes.ok) {
      // /auth/me 返回 { user: { id, email, plan, ... } }（见 account-routes.ts:41）。
      // 原代码读扁平 me.id / me.plan → 恒 undefined，userId 一直是空串、plan 不更新。
      // 与 handleOAuthCallback 的解析保持一致。
      const me = await meRes.json() as { user: { id: string; email: string; plan?: string } };
      if (me.user?.id) cachedAuth.userId = me.user.id;
      if (me.user?.email) cachedAuth.email = me.user.email;
      if (me.user?.plan) cachedAuth.plan = me.user.plan;
    }
  } catch { /* ignore */ }

  saveAuthToDisk();
  log.info(`logged in as ${maskEmail(email)}`);
  return cachedAuth;
}

/**
 * 从 /auth/me 重新拉取 plan 写回 cachedAuth。fire-and-forget 语义，失败静默（下次再试）。
 * 背景：Creem 升级/降级发生在服务端，客户端只在 login / OAuth 回调时取过 plan，
 * 之后从不重取 → 升级后 cloud:status / memory-usage 读到的 plan 永远是旧值（Free）。
 */
async function refreshPlanFromServer(): Promise<void> {
  if (!cachedAuth) return;
  const base = getCloudBaseUrl();
  try {
    // 先走 refreshTokenIfNeeded 拿可用 token,而不是直接用可能已过期的
    // cachedAuth.accessToken。背景:用户登录但**未开云同步**时没有 30s 轮询替它刷
    // token,access token TTL 1h 后过期,直接打 /auth/me 恒 401 → plan 永远停在登录时
    // 的旧值(Creem 升级后 memory-usage 面板继续按 free/500 显示"已满")。
    // transient 失败 throw 被下方 catch 兜住(plan 收敛是 best-effort,下次再试)。
    const token = await refreshTokenIfNeeded().catch(() => null);
    if (!token) return;
    const meRes = await fetch(`${base}/auth/me`, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(AUTH_FETCH_TIMEOUT_MS),
    });
    if (!meRes.ok) return;
    const body = await meRes.json() as { user?: { plan?: string } };
    if (body.user?.plan && cachedAuth && body.user.plan !== cachedAuth.plan) {
      cachedAuth.plan = body.user.plan;
      saveAuthToDisk();
    }
  } catch { /* transient — 下次 refresh 再收敛 */ }
}

/** 供 IPC / UI 主动触发 plan 收敛（如用户从 Creem 升级页返回后）。返回收敛后的 plan。 */
export async function refreshPlanNow(): Promise<string | null> {
  await refreshPlanFromServer();
  return cachedAuth?.plan ?? null;
}

export async function logout(): Promise<void> {
  // Best-effort 调服务端 /auth/logout 撤销 token(tokens_revoked_at = NOW())。
  // 客户端原来只清内存 + keychain,从不通知服务端 → 已签发的 access(≤1h)/ refresh
  // (30 天)token 在云端继续有效;若 token 此前泄漏(或 keychain delete 失败),
  // 登出不提供任何服务端保护。服务端已实现撤销语义(account-routes /logout),
  // 客户端这条主登出路径补上调用。
  // best-effort:失败(网络/超时/服务端错误)不阻塞本地登出——本地清理必须照常进行。
  // 在清 cachedAuth 之前抓取 token(清空后就拿不到了)。
  const token = cachedAuth?.accessToken ?? null;
  if (token) {
    try {
      const base = getCloudBaseUrl();
      await fetch(`${base}/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(AUTH_FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      log.warn(`server-side logout failed (continuing local logout): ${(err as Error).message}`);
    }
  }

  cachedAuth = null;
  const cleared = saveAuthToDisk();
  if (!cleared) {
    // saveAuthToDisk 已经 log.error 过详情。这里再升一档,确保 ops 看日志时
    // 能立刻发现"用户点了登出但 keychain item 没真清掉"的情况(共享设备下
    // 下次启动会自动登回去——安全 boundary 失效,Round 4 audit CONCERN)。
    log.error('logout: persistent storage cleanup failed — keychain may still contain auth data; next launch may auto-restore login');
  }
  log.info('logged out');
}

/**
 * 把 refresh-token HTTP 响应分类为 ok / permanent / transient。
 *
 * 设计语义:
 *   - networkError = true        → transient(网络抖动,保留登录态)
 *   - status 200-299             → ok(成功)
 *   - status 400 / 401 / 403     → permanent(凭据真坏,清除登录态)
 *   - 其他 status(含 5xx / 408 / 429 / 解析失败等) → transient
 *
 * 抽出为纯函数 + export 是为了让单元测试可以直接 import 真源
 * (替代 inline-copy 测试)。refreshTokenIfNeeded 仍是上面分类规则的
 * **唯一**消费者,内部 5xx 重试逻辑不在此函数范围内。
 */
export function classifyRefreshResult(args: {
  networkError: boolean;
  status?: number;
}): 'ok' | 'permanent' | 'transient' {
  if (args.networkError) return 'transient';
  const s = args.status ?? 0;
  if (s >= 200 && s < 300) return 'ok';
  if (s === 400 || s === 401 || s === 403) return 'permanent';
  return 'transient';
}

/**
 * 同一时刻只允许一个真正的 refresh 请求在飞。
 *
 * 背景:6+ 处 fire-and-forget caller(sync-client / strategy-push /
 * reconciler 各路)会近乎同时发现 access_token 过期、并发调用 refreshTokenIfNeeded()。
 * OAuth 2.1 rotating refresh-token 语义下,服务端只接受第一个 refresh_token,
 * 之后再来的请求拿的是已作废的老 refresh_token,会被 400 拒绝。老逻辑会把这种 400
 * 判作 permanent → cachedAuth 清空 → 用户被**无声登出**(CRITICAL bug)。
 *
 * 修复:加 inflight Promise mutex,所有并发 caller 复用同一个 Promise,
 * 只发一次网络请求,大家拿到同一个新 access_token。模式与 embedding.ts
 * 的 inflightAvailabilityCheck / auth-codes.ts 的 inflightCleanup 一致。
 *
 * 注意:**只 mutex 真正发 refresh 请求的那段**,而不是整个 function。因为快路径
 *("token 还有效,直接返回"和"cachedAuth=null,直接 null")是纯内存读,
 * 没必要排队。
 */
let inflightRefresh: Promise<string | null> | null = null;

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
 * 并发安全:同一时刻只发一次真实 refresh 网络请求,所有并发 caller 复用结果。
 * 见 inflightRefresh 注释。
 *
 * 额外:5xx 有一次短暂退避重试,避开边缘波动。
 */
export async function refreshTokenIfNeeded(): Promise<string | null> {
  if (!cachedAuth) return null;
  if (Date.now() < cachedAuth.expiresAt - 5 * 60 * 1000) {
    return cachedAuth.accessToken; // Still valid
  }

  // 已有刷新在飞 → 复用,避免 OAuth 2.1 rotating refresh-token 下的"第二个 caller
  // 拿已作废 refresh_token 去刷 → 400 → cachedAuth 清空 → 无声登出"。
  if (inflightRefresh) return inflightRefresh;

  inflightRefresh = doRefreshToken();
  // .finally 链清空槽位,异常路径也释放(不然下次永远不刷)。
  // 注意:不能用 await + try/finally 写法,因为我们要立刻把 inflightRefresh 设上让
  // 并发 caller 拿到,而不是等 await 完才设。
  inflightRefresh.finally(() => { inflightRefresh = null; }).catch(() => { /* 已被 caller await */ });
  return inflightRefresh;
}

/**
 * 带登录态请求一个会 302 重定向的云端端点(/billing/checkout、/billing/portal),
 * 返回重定向目标(Creem 托管 URL)或 null。
 *
 * 用途(B3):app 内"升级"/"管理订阅"——主进程持有 access token,带 Bearer 请求
 * /checkout,服务端 optionalAuth 见到 token → 用 metadata.user_id 建 Creem checkout
 * → 302 跳 Creem。我们读 Location 拿到**已绑 user_id** 的 Creem URL,交给浏览器打开
 * (浏览器本身没有我们的登录态,所以不能让它直接访问需鉴权的云端 URL)。
 *
 * - `redirect: 'manual'` 在 Node/undici(主进程)下返回真实 3xx 响应、Location 可读
 *   (非浏览器的 opaque 响应)。
 * - 仅接受**绝对 http(s) URL**:防御性挡住相对重定向(如 BILLING_ENABLED=false 时的
 *   /billing/coming-soon),那种情况返回 null,由调用方降级到公开定价页。
 * - 刷新 token 临时失败时退用现有 token(服务端 optionalAuth 对失效 token 也只降级匿名,
 *   不报错);永久失败 / 未登录 → null。
 */
export async function authedRedirectLocation(path: string): Promise<string | null> {
  if (!cachedAuth) return null;
  let token: string | null;
  try {
    token = await refreshTokenIfNeeded();
  } catch {
    token = cachedAuth?.accessToken ?? null; // 临时刷新失败:用现有 token 尽力一搏
  }
  if (!token) return null;
  try {
    const res = await fetch(`${getCloudBaseUrl()}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'manual',
    });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc && /^https?:\/\//i.test(loc)) {
      return loc;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 实际执行 refresh 的内部函数。从 refreshTokenIfNeeded 抽出来,
 * 让 mutex 包装层 (inflightRefresh) 写法干净——只关心"已经在飞了吗"。
 *
 * cachedAuth 在调用进来前已经确认非空(快路径已 return),但为防止竞态
 * (logout 中途清空 cachedAuth)在内部再读一次。
 */
async function doRefreshToken(): Promise<string | null> {
  if (!cachedAuth) return null; // 防御:进入 await 链时被 logout 清空
  const base = getCloudBaseUrl();
  const body = JSON.stringify({ grant_type: 'refresh_token', refresh_token: cachedAuth.refreshToken });

  const attempt = async (): Promise<Response> => fetch(`${base}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(AUTH_FETCH_TIMEOUT_MS),
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
    if (!cachedAuth) return null; // 防御:并发 logout
    // 内存里换上新 token。
    cachedAuth.accessToken = data.access_token;
    cachedAuth.refreshToken = data.refresh_token;
    cachedAuth.expiresAt = Date.now() + (data.expires_in * 1000);
    if (!saveAuthToDisk()) {
      // 持久化失败的取舍(audit-2 HIGH #3 再修正):
      //
      // 旧实现"回滚到旧 token + throw transient"在服务端上线 A-3 rotation
      // reuse-detection 后变成了**更危险**的行为:服务端已把旧 refresh_token 的 jti
      // 标记 consumed,客户端下次拿这个已作废的旧 token 去刷 → 被判定为 token 被盗 →
      // 服务端 `UPDATE users SET tokens_revoked_at = NOW()` 吊销该用户**所有设备**的
      // token → 全设备强制重登。单机一次钥匙串写失败被放大成账户级事故。
      //
      // 改为:**不回滚**,保留刚拿到的新 token 在内存继续用(它在服务端是有效的、
      // 未 consumed 的),并重试一次持久化。代价是若持久化始终失败,下次启动本机
      // 读不到 token、需重登本机——这远小于"重放 consumed token 触发全设备吊销"。
      // (服务端 same-client 宽限期由 cloud-server 负责人另做,不在客户端取舍范围。)
      log.warn('persist new tokens failed; keeping new tokens in memory, retrying persist once');
      if (!saveAuthToDisk()) {
        log.error('persist new tokens failed again; in-memory tokens valid this session, re-login likely after restart');
      }
    }
    return cachedAuth.accessToken;
  }

  // 400 / 401 / 403 = 凭据真的坏了,清除。其他非 2xx(包括重试后仍 5xx)保留并抛异常。
  // 走 classifyRefreshResult 保持源码与测试同源。
  const classification = classifyRefreshResult({ networkError: false, status: res.status });
  if (classification === 'permanent') {
    log.error(`refreshToken permanent failure: ${res.status} — logging out`);
    cachedAuth = null;
    saveAuthToDisk();
    return null;
  }

  const bodyText = await res.text().catch(() => '');
  log.warn(`refreshToken unexpected status ${res.status}: ${bodyText.slice(0, 200)} — keeping session`);
  throw new Error(`refresh_token transient: HTTP ${res.status}`);
}
