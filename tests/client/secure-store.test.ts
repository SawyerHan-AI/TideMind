/**
 * secure-store.ts + migrateLegacyAuthIfNeeded 单测。
 *
 * 背景:backlog 显式点名"secure-store + migrateLegacyAuthIfNeeded 0 测试,
 * 7-8 个失败分类路径,marker/attempts 文件生命周期完全没覆盖"。
 * 这是一次性"用户升级"事件,跑一次坏了之后不可复现——必须靠单测兜住分类逻辑。
 *
 * Mock 策略关键发现:
 *   - `import 'electron'` from `client/electron/cloud/*` 实际解析到
 *     `client/node_modules/electron/index.js`(electron 包的 path-launcher,
 *     真实文件存在;不含 safeStorage 字段)。
 *   - 仅 `vi.mock('electron', ...)` 注册 bare specifier 不够——vitest 不会自动
 *     把这条 mock 应用到 client/node_modules/electron/index.js 的解析结果上,
 *     导致 secure-store.ts 拿到 undefined 的 safeStorage,所有 legacy 路径 case
 *     都会 `TypeError: Cannot read properties of undefined`(2026-05-21 排查 1.5h)。
 *   - 修复:同时 mock 解析后路径 `'../../client/node_modules/electron/index.js'`,
 *     vitest 才能在 client/electron/cloud/*.ts 导入时拦截到。
 *
 *   - secure-store.ts 在 native 路径(macOS + native available + no forceLegacy)
 *     用 `require('secure-store-mac')` 调用真实 native binary——vitest mock 对
 *     CJS require() 不可靠拦截,本机会真的调系统 keychain。所以**测试一律强制
 *     forceLegacy=1**,把 secure-store.ts 切到 safeStorage 路径,避开 native。
 *
 * 测试覆盖:
 *   - secure-store.ts legacy / safeStorage 路径(set/get/delete + 错误处理)
 *   - parseForceLegacy 宽松匹配(audit-2 MEDIUM 修复)
 *   - migrateLegacyAuthIfNeeded 全部分支:
 *       新用户 / 已迁(marker)/ 新 store 已有数据 /
 *       不可恢复(truncated / decrypt-failed / json-parse-failed / schema-invalid)/
 *       可恢复 attempts 计数(safeStorage/native-set/readFileSync)/
 *       attempts 上限放弃 / 多次启动重试到成功 / marker 写失败容错
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ----------------------------------------------------------------------------
// 共享 mock 状态
// ----------------------------------------------------------------------------

interface MockState {
  tmpDir: string;
  // electron.safeStorage
  isEncryptionAvailable: () => boolean;
  encryptString: (s: string) => Buffer;
  decryptString: (b: Buffer) => string;
  // secure-store.js mock(给 auth-client 用,native vs safeStorage 由这里控制)
  ssIsUsingNative: () => boolean;
  ssIsAvailable: () => boolean;
  ssSet: (service: string, account: string, value: Buffer) => void;
  ssGet: (service: string, account: string) => Buffer | null;
  ssDelete: (service: string, account: string) => void;
  storage: Map<string, Buffer>;
}

const state: MockState = {
  tmpDir: '',
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.concat([Buffer.from('v10'), Buffer.from(s, 'utf-8')]),
  decryptString: (b) => b.subarray(3).toString('utf-8'),
  ssIsUsingNative: () => true,
  ssIsAvailable: () => true,
  ssSet: (s, a, v) => { state.storage.set(`${s}::${a}`, Buffer.from(v)); },
  ssGet: (s, a) => state.storage.get(`${s}::${a}`) ?? null,
  ssDelete: (s, a) => { state.storage.delete(`${s}::${a}`); },
  storage: new Map(),
};

const electronMock = {
  safeStorage: {
    isEncryptionAvailable: () => state.isEncryptionAvailable(),
    encryptString: (s: string) => state.encryptString(s),
    decryptString: (b: Buffer) => state.decryptString(b),
  },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: { isSupported: () => false },
  app: { getPath: () => state.tmpDir },
};

// ⚠️ 同时 mock bare specifier 和实际解析路径:
// - bare 'electron' 让测试文件 import('electron') 拿到 mock
// - 解析路径让 client/electron/cloud/*.ts 的 import 'electron' 也拿到同一个 mock
//   (它们解析到 client/node_modules/electron/index.js)
vi.mock('electron', () => electronMock);
vi.mock('../../client/node_modules/electron/index.js', () => electronMock);

// secure-store.js 整体 mock,migrateLegacyAuthIfNeeded 测试通过这里控制
// isUsingNative / set / get 行为。auth-client.ts 通过 ESM 路径 import,vi.mock 可靠拦截。
vi.mock('../../client/electron/cloud/secure-store.js', () => ({
  secureStore: {
    isUsingNative: () => state.ssIsUsingNative(),
    isAvailable: () => state.ssIsAvailable(),
    set: (s: string, a: string, v: Buffer) => state.ssSet(s, a, v),
    get: (s: string, a: string) => state.ssGet(s, a),
    delete: (s: string, a: string) => state.ssDelete(s, a),
  },
}));

vi.mock('../../src/config.js', () => ({
  getDataDir: () => state.tmpDir,
  getConfig: () => ({ general: { data_dir: state.tmpDir }, cloud: { server_url: 'https://x' } }),
}));

vi.mock('../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

// ----------------------------------------------------------------------------
// 帮助函数
// ----------------------------------------------------------------------------

let originalForceLegacy: string | undefined;

function setForceLegacy(v: string | undefined): void {
  if (v === undefined) delete process.env.TIDEMIND_USE_LEGACY_KEYCHAIN;
  else process.env.TIDEMIND_USE_LEGACY_KEYCHAIN = v;
}

beforeEach(() => {
  originalForceLegacy = process.env.TIDEMIND_USE_LEGACY_KEYCHAIN;
  state.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secure-store-test-'));
  state.isEncryptionAvailable = () => true;
  state.encryptString = (s) => Buffer.concat([Buffer.from('v10'), Buffer.from(s, 'utf-8')]);
  state.decryptString = (b) => b.subarray(3).toString('utf-8');
  state.ssIsUsingNative = () => true;
  state.ssIsAvailable = () => true;
  state.ssSet = (s, a, v) => { state.storage.set(`${s}::${a}`, Buffer.from(v)); };
  state.ssGet = (s, a) => state.storage.get(`${s}::${a}`) ?? null;
  state.ssDelete = (s, a) => { state.storage.delete(`${s}::${a}`); };
  state.storage = new Map();
  setForceLegacy(undefined);
});

afterEach(() => {
  if (originalForceLegacy === undefined) delete process.env.TIDEMIND_USE_LEGACY_KEYCHAIN;
  else process.env.TIDEMIND_USE_LEGACY_KEYCHAIN = originalForceLegacy;
  try { fs.rmSync(state.tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** 加载真实 secure-store.ts(临时 unmock,用完恢复 mock 给后续 auth-client 测试)*/
async function loadSecureStoreReal(): Promise<typeof import('../../client/electron/cloud/secure-store.js')> {
  vi.resetModules();
  vi.doUnmock('../../client/electron/cloud/secure-store.js');
  const m = await import('../../client/electron/cloud/secure-store.js');
  // 恢复 mock,给后续 auth-client 测试用
  vi.doMock('../../client/electron/cloud/secure-store.js', () => ({
    secureStore: {
      isUsingNative: () => state.ssIsUsingNative(),
      isAvailable: () => state.ssIsAvailable(),
      set: (s: string, a: string, v: Buffer) => state.ssSet(s, a, v),
      get: (s: string, a: string) => state.ssGet(s, a),
      delete: (s: string, a: string) => state.ssDelete(s, a),
    },
  }));
  return m;
}

/** 加载 auth-client.ts(每次都 vi.resetModules 重新 evaluate,清掉 migrationRan)*/
async function loadAuthClient(): Promise<typeof import('../../client/electron/cloud/auth-client.js')> {
  vi.resetModules();
  return await import('../../client/electron/cloud/auth-client.js');
}

// ============================================================================
// 1. secure-store.ts — legacy/safeStorage 路径(强制 forceLegacy=1)
// ============================================================================
//
// 不测 darwin native 路径,理由:
//   - 本机 node_modules/secure-store-mac/build/Release/secure_store.node 实际存在,
//     `require('secure-store-mac')` 会调真实 native binary,vi.mock 拦不住 CJS require。
//   - 若不 mock,测试会修改开发者本机的 Data Protection Keychain,污染真实登录态。
//   - forceLegacy=1 是设计上的紧急回退开关,切到 safeStorage 路径——这条路径**就是**
//     非 darwin / dev 环境的实际跑法,代码量上也是 secure-store.ts 的主要逻辑。

describe('secure-store: legacy path 基础行为', () => {
  it('darwin + forceLegacy=1 → isUsingNative=false, 走 safeStorage', async () => {
    setForceLegacy('1');
    state.isEncryptionAvailable = () => true;
    const m = await loadSecureStoreReal();
    expect(m.secureStore.isUsingNative()).toBe(false);
    expect(m.secureStore.isAvailable()).toBe(true);
  });

  it('darwin + forceLegacy=1 + safeStorage 不可用 → isAvailable=false', async () => {
    setForceLegacy('1');
    state.isEncryptionAvailable = () => false;
    const m = await loadSecureStoreReal();
    expect(m.secureStore.isAvailable()).toBe(false);
  });
});

describe('secure-store: parseForceLegacy 宽松匹配 (audit-2 MEDIUM 修复)', () => {
  // 来自 secure-store.ts L48-56:支持工程师远程救场写错值 ("true" / "yes") 也得能开启。
  // 严格 === '1' 是设计上放弃的——紧急回退应该尽量宽容。

  it('"1" / "true" / "yes" / "TRUE" / "On" → 视为开启 legacy', async () => {
    const { parseForceLegacy } = await loadSecureStoreReal();
    for (const v of ['1', 'true', 'yes', 'TRUE', 'On']) {
      expect(parseForceLegacy(v), `forceLegacy=${v} should enable legacy`).toBe(true);
    }
  });

  it('"0" / "false" / "no" / "off" / "" → 不视为开启 legacy(空字符串等价未设置)', async () => {
    const { parseForceLegacy } = await loadSecureStoreReal();
    for (const v of ['0', 'false', 'no', 'off', '']) {
      expect(parseForceLegacy(v), `forceLegacy=${v} should not enable legacy`).toBe(false);
    }
    expect(parseForceLegacy(undefined)).toBe(false);
  });
});

describe('secure-store: legacy set/get/delete (forceLegacy=1)', () => {
  beforeEach(() => { setForceLegacy('1'); });

  it('(TideMind, cloud-auth) → hardcode 老路径 cloud-auth.json(向后兼容)', async () => {
    state.isEncryptionAvailable = () => true;
    const m = await loadSecureStoreReal();

    m.secureStore.set('TideMind', 'cloud-auth', Buffer.from('payload-x'));
    expect(fs.existsSync(path.join(state.tmpDir, 'cloud-auth.json'))).toBe(true);
  });

  it('其他 (service, account) → 新路径 .<service>-<account>.bin', async () => {
    state.isEncryptionAvailable = () => true;
    const m = await loadSecureStoreReal();

    m.secureStore.set('Other', 'thing', Buffer.from('y'));
    expect(fs.existsSync(path.join(state.tmpDir, '.Other-thing.bin'))).toBe(true);
  });

  it('set + get 往返(safeStorage encrypt/decrypt)', async () => {
    state.isEncryptionAvailable = () => true;
    const m = await loadSecureStoreReal();

    const payload = Buffer.from('round-trip', 'utf-8');
    m.secureStore.set('TideMind', 'cloud-auth', payload);

    const got = m.secureStore.get('TideMind', 'cloud-auth');
    expect(got).not.toBeNull();
    expect(got!.toString('utf-8')).toBe('round-trip');
  });

  it('set + safeStorage 不可用 → 抛错(不静默落明文)', async () => {
    state.isEncryptionAvailable = () => false;
    const m = await loadSecureStoreReal();

    expect(() => m.secureStore.set('TideMind', 'cloud-auth', Buffer.from('x')))
      .toThrow('safeStorage encryption unavailable');
  });

  it('get + safeStorage 不可用 → 返回 null 但**不删**文件(瞬态保留,audit-2 MEDIUM 修复)', async () => {
    state.isEncryptionAvailable = () => true;
    let m = await loadSecureStoreReal();
    m.secureStore.set('TideMind', 'cloud-auth', Buffer.from('x'));
    const legacyFile = path.join(state.tmpDir, 'cloud-auth.json');
    expect(fs.existsSync(legacyFile)).toBe(true);

    // 改成不可用,重新 load
    state.isEncryptionAvailable = () => false;
    m = await loadSecureStoreReal();
    expect(m.secureStore.get('TideMind', 'cloud-auth')).toBeNull();
    // 文件留着,等下次启动 keyring 恢复时再试
    expect(fs.existsSync(legacyFile)).toBe(true);
  });

  it('get + 文件不存在(ENOENT) → 返回 null', async () => {
    state.isEncryptionAvailable = () => true;
    const m = await loadSecureStoreReal();
    expect(m.secureStore.get('TideMind', 'cloud-auth')).toBeNull();
  });

  it('get + 空文件(length=0) → 返回 null', async () => {
    state.isEncryptionAvailable = () => true;
    fs.writeFileSync(path.join(state.tmpDir, 'cloud-auth.json'), '');
    const m = await loadSecureStoreReal();
    expect(m.secureStore.get('TideMind', 'cloud-auth')).toBeNull();
  });

  it('get + decryptString 抛错 → 返回 null(不冒泡到 caller)', async () => {
    state.isEncryptionAvailable = () => true;
    state.decryptString = () => { throw new Error('decrypt-broken'); };
    fs.writeFileSync(path.join(state.tmpDir, 'cloud-auth.json'), Buffer.from('garbage'));
    const m = await loadSecureStoreReal();
    expect(m.secureStore.get('TideMind', 'cloud-auth')).toBeNull();
  });

  it('delete 文件不存在 → no-op,不抛', async () => {
    state.isEncryptionAvailable = () => true;
    const m = await loadSecureStoreReal();
    expect(() => m.secureStore.delete('TideMind', 'cloud-auth')).not.toThrow();
  });

  it('legacy 文件 mode = 0o600(只本人可读写)', async () => {
    state.isEncryptionAvailable = () => true;
    const m = await loadSecureStoreReal();
    m.secureStore.set('TideMind', 'cloud-auth', Buffer.from('x'));
    const st = fs.statSync(path.join(state.tmpDir, 'cloud-auth.json'));
    expect(st.mode & 0o777).toBe(0o600);
  });

  // HIGH 3 (audit-10, 2026-05-21):预先存在 0o644 文件 → legacySet 后必须变成
  // 0o600。验证 unlink + writeFileSync(mode) + chmod 三步兜底:之前直接
  // writeFileSync 在已存在文件上 truncate 不改 mode,旧的世界可读文件升级后
  // 仍然世界可读。
  it('HIGH 3: 预存 mode=0o644 文件 + legacySet → mode 升级为 0o600', async () => {
    state.isEncryptionAvailable = () => true;
    const filePath = path.join(state.tmpDir, 'cloud-auth.json');
    // 先写一个 0o644 的"老文件"模拟 v0.2.69 留下的状态
    fs.writeFileSync(filePath, Buffer.from('legacy-stuff'), { mode: 0o644 });
    fs.chmodSync(filePath, 0o644); // 显式确认初始 mode
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o644);

    const m = await loadSecureStoreReal();
    m.secureStore.set('TideMind', 'cloud-auth', Buffer.from('new-payload'));

    const st = fs.statSync(filePath);
    expect(st.mode & 0o777, '老 0o644 文件升级 set 后应变成 0o600').toBe(0o600);
  });

  it('完整生命周期:set → get → delete → get(null)', async () => {
    state.isEncryptionAvailable = () => true;
    const m = await loadSecureStoreReal();
    m.secureStore.set('TideMind', 'cloud-auth', Buffer.from('x'));
    expect(m.secureStore.get('TideMind', 'cloud-auth')).not.toBeNull();
    m.secureStore.delete('TideMind', 'cloud-auth');
    expect(m.secureStore.get('TideMind', 'cloud-auth')).toBeNull();
  });
});

// ============================================================================
// 2. migrateLegacyAuthIfNeeded — mock secure-store.js 模块控制 isUsingNative/set/get
// ============================================================================

const MARKER = '.cloud-auth.migrated-v0.2.70';
const ATTEMPTS = '.cloud-auth.migration-attempts';
const LEGACY = 'cloud-auth.json';

function markerPath(): string { return path.join(state.tmpDir, MARKER); }
function attemptsPath(): string { return path.join(state.tmpDir, ATTEMPTS); }
function legacyPath(): string { return path.join(state.tmpDir, LEGACY); }

/** 写一个"合法"的 safeStorage blob,长度 ≥ 64 字节,decrypt 后是合法 JSON */
function writeValidLegacy(authObj?: object): void {
  const auth = authObj ?? {
    accessToken: 'access-token-' + 'A'.repeat(100),
    refreshToken: 'refresh-token-' + 'R'.repeat(100),
    userId: 'u1',
    email: 'a@b.com',
    plan: null,
    expiresAt: Date.now() + 3600_000,
    lastSyncedAt: null,
  };
  const json = JSON.stringify(auth);
  const blob = state.encryptString(json);
  const padded = blob.length >= 64
    ? blob
    : Buffer.concat([blob, Buffer.alloc(64 - blob.length, 0xff)]);
  fs.writeFileSync(legacyPath(), padded);
}

describe('migrateLegacyAuthIfNeeded: 路径选择', () => {
  it('isUsingNative=false → 整个 migrate 跳过,不动文件不写 marker', async () => {
    state.ssIsUsingNative = () => false;
    fs.writeFileSync(legacyPath(), Buffer.from('whatever'));
    const m = await loadAuthClient();
    m.initAuth();
    expect(fs.existsSync(markerPath())).toBe(false);
    expect(fs.existsSync(legacyPath())).toBe(true);
  });
});

describe('migrateLegacyAuthIfNeeded: 新用户路径', () => {
  it('isUsingNative=true + 无 legacy 文件 + 无 marker → 写 marker(no-legacy-file)', async () => {
    state.ssIsUsingNative = () => true;
    const m = await loadAuthClient();
    m.initAuth();
    expect(fs.existsSync(markerPath())).toBe(true);
    expect(fs.readFileSync(markerPath(), 'utf-8')).toContain('no-legacy-file');
  });
});

describe('migrateLegacyAuthIfNeeded: 幂等性 (marker)', () => {
  it('marker 已存在 → skip,不读老文件(不调 decrypt)', async () => {
    state.ssIsUsingNative = () => true;
    fs.writeFileSync(markerPath(), '2026-05-20T00:00:00Z migrated\n', { mode: 0o600 });
    let decryptCalled = false;
    state.decryptString = (b) => { decryptCalled = true; return b.subarray(3).toString('utf-8'); };
    writeValidLegacy();
    const m = await loadAuthClient();
    m.initAuth();
    expect(decryptCalled).toBe(false);
  });

  it('marker 已存在 + 老文件重新出现(TimeMachine 还原)→ 顺手清掉老文件', async () => {
    state.ssIsUsingNative = () => true;
    fs.writeFileSync(markerPath(), '2026-05-20T00:00:00Z migrated\n', { mode: 0o600 });
    writeValidLegacy();
    expect(fs.existsSync(legacyPath())).toBe(true);
    const m = await loadAuthClient();
    m.initAuth();
    expect(fs.existsSync(legacyPath())).toBe(false);
  });

  it('migrationRan 单进程内只跑一次:第二次 initAuth() 不再写 marker', async () => {
    state.ssIsUsingNative = () => true;
    const m = await loadAuthClient();
    m.initAuth();
    // 删 marker 模拟"中间状态",观察第二次是否会重写
    fs.unlinkSync(markerPath());
    m.initAuth();
    // migrationRan=true,跳过所有逻辑,marker 不会被重建
    expect(fs.existsSync(markerPath())).toBe(false);
  });
});

describe('migrateLegacyAuthIfNeeded: 新 store 已有数据(残留老文件)', () => {
  it('新 store 已存数据 + 老文件存在 → 清老文件 + 写 marker(new-store-already-has-data)', async () => {
    state.ssIsUsingNative = () => true;
    state.ssGet = () => Buffer.from(JSON.stringify({
      accessToken: 'a', refreshToken: 'r', userId: 'u', email: 'e', plan: null,
      expiresAt: Date.now() + 3600_000, lastSyncedAt: null,
    }));
    writeValidLegacy();
    const m = await loadAuthClient();
    m.initAuth();
    expect(fs.existsSync(legacyPath())).toBe(false);
    expect(fs.existsSync(markerPath())).toBe(true);
    expect(fs.readFileSync(markerPath(), 'utf-8')).toContain('new-store-already-has-data');
  });

  it('secureStore.get 探测抛错 → 保留老文件,不写 marker,不增 attempts(audit-3 HIGH #5)', async () => {
    state.ssIsUsingNative = () => true;
    state.ssGet = () => { throw new Error('keychain locked'); };
    writeValidLegacy();
    const m = await loadAuthClient();
    m.initAuth();
    expect(fs.existsSync(legacyPath())).toBe(true);
    expect(fs.existsSync(markerPath())).toBe(false);
    // attempts 不应该增加(注释明确说"探测不算迁移尝试")
    expect(fs.existsSync(attemptsPath())).toBe(false);
  });
});

describe('migrateLegacyAuthIfNeeded: 不可恢复失败 → marker 标记永久放弃', () => {
  it('legacy 文件截断(< 64 字节)→ 立刻放弃,写 marker(failed:truncated) (audit-3 HIGH #6)', async () => {
    state.ssIsUsingNative = () => true;
    fs.writeFileSync(legacyPath(), Buffer.from('short'));
    const m = await loadAuthClient();
    m.initAuth();
    expect(fs.existsSync(legacyPath())).toBe(false);
    expect(fs.readFileSync(markerPath(), 'utf-8')).toContain('failed:truncated');
  });

  it('decryptString 抛错 → 不可恢复,写 marker(failed:decrypt-failed),不重试', async () => {
    state.ssIsUsingNative = () => true;
    state.decryptString = () => { throw new Error('Decryption failed'); };
    writeValidLegacy();
    const m = await loadAuthClient();
    m.initAuth();
    expect(fs.existsSync(legacyPath())).toBe(false);
    expect(fs.readFileSync(markerPath(), 'utf-8')).toContain('failed:decrypt-failed');
    expect(fs.existsSync(attemptsPath())).toBe(false);
  });

  it('JSON 解析失败 → 不可恢复,写 marker(failed:json-parse-failed)', async () => {
    state.ssIsUsingNative = () => true;
    state.decryptString = () => 'not-a-json';
    writeValidLegacy();
    const m = await loadAuthClient();
    m.initAuth();
    expect(fs.existsSync(legacyPath())).toBe(false);
    expect(fs.readFileSync(markerPath(), 'utf-8')).toContain('failed:json-parse-failed');
  });

  it('schema 校验:缺少 accessToken → marker(failed:schema-invalid) (audit-3 MEDIUM 修复)', async () => {
    state.ssIsUsingNative = () => true;
    state.decryptString = () => JSON.stringify({ refreshToken: 'r', expiresAt: 1 });
    writeValidLegacy();
    const m = await loadAuthClient();
    m.initAuth();
    expect(fs.existsSync(legacyPath())).toBe(false);
    expect(fs.readFileSync(markerPath(), 'utf-8')).toContain('failed:schema-invalid');
  });

  it('schema 校验:expiresAt 是字符串而非数字 → 不可恢复', async () => {
    state.ssIsUsingNative = () => true;
    state.decryptString = () => JSON.stringify({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: '1234567890', // 应该是 number 而不是 string
    });
    writeValidLegacy();
    const m = await loadAuthClient();
    m.initAuth();
    expect(fs.readFileSync(markerPath(), 'utf-8')).toContain('failed:schema-invalid');
  });

  it('schema 校验:refreshToken 缺失 → 不可恢复', async () => {
    state.ssIsUsingNative = () => true;
    state.decryptString = () => JSON.stringify({
      accessToken: 'a',
      expiresAt: 1234567890,
    });
    writeValidLegacy();
    const m = await loadAuthClient();
    m.initAuth();
    expect(fs.readFileSync(markerPath(), 'utf-8')).toContain('failed:schema-invalid');
  });
});

describe('migrateLegacyAuthIfNeeded: 可恢复失败 (attempts 计数与 MAX 上限)', () => {
  it('safeStorage 不可用 + attempts=0 → 写 attempts=1,保留老文件', async () => {
    state.ssIsUsingNative = () => true;
    state.isEncryptionAvailable = () => false;
    writeValidLegacy();
    const m = await loadAuthClient();
    m.initAuth();
    expect(fs.existsSync(legacyPath())).toBe(true);
    expect(fs.existsSync(markerPath())).toBe(false);
    expect(fs.readFileSync(attemptsPath(), 'utf-8').trim()).toBe('1');
  });

  it('safeStorage 不可用 + on-disk attempts=1 → 写 attempts=2,仍保留(未达 MAX)', async () => {
    state.ssIsUsingNative = () => true;
    state.isEncryptionAvailable = () => false;
    fs.writeFileSync(attemptsPath(), '1');
    writeValidLegacy();
    const m = await loadAuthClient();
    m.initAuth();
    expect(fs.existsSync(legacyPath())).toBe(true);
    expect(fs.existsSync(markerPath())).toBe(false);
    // readMigrationAttempts() + 1 = 2,2 < 3,仍重试
    expect(fs.readFileSync(attemptsPath(), 'utf-8').trim()).toBe('2');
  });

  it('safeStorage 不可用 + attempts ≥ MAX(3) → 放弃,写 marker(failed:safestorage-unavailable-permanent)', async () => {
    state.ssIsUsingNative = () => true;
    state.isEncryptionAvailable = () => false;
    fs.writeFileSync(attemptsPath(), '3'); // attempts+1 = 4 >= MAX(3)
    writeValidLegacy();
    const m = await loadAuthClient();
    m.initAuth();
    expect(fs.existsSync(legacyPath())).toBe(false);
    expect(fs.readFileSync(markerPath(), 'utf-8')).toContain('failed:safestorage-unavailable-permanent');
    expect(fs.existsSync(attemptsPath())).toBe(false);
  });

  it('secureStore.set 失败 + attempts=0 → attempts=1,保留', async () => {
    state.ssIsUsingNative = () => true;
    state.ssSet = () => { throw new Error('temporary write fail'); };
    writeValidLegacy();
    const m = await loadAuthClient();
    m.initAuth();
    expect(fs.existsSync(legacyPath())).toBe(true);
    expect(fs.readFileSync(attemptsPath(), 'utf-8').trim()).toBe('1');
  });

  it('secureStore.set 失败 + attempts ≥ MAX → 放弃,写 marker(failed:native-set-failed-permanent)', async () => {
    state.ssIsUsingNative = () => true;
    state.ssSet = () => { throw new Error('persistent write fail'); };
    fs.writeFileSync(attemptsPath(), '3');
    writeValidLegacy();
    const m = await loadAuthClient();
    m.initAuth();
    expect(fs.existsSync(legacyPath())).toBe(false);
    expect(fs.readFileSync(markerPath(), 'utf-8')).toContain('failed:native-set-failed-permanent');
  });

  it('legacy fs.readFileSync 抛错 → 可恢复,attempts+1,保留老文件', async () => {
    state.ssIsUsingNative = () => true;
    const origRead = fs.readFileSync.bind(fs);
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...rest) => {
      if (typeof p === 'string' && p.endsWith(LEGACY)) {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      }
      return (origRead as any)(p, ...rest);
    });
    writeValidLegacy();
    try {
      const m = await loadAuthClient();
      m.initAuth();
    } finally {
      spy.mockRestore();
    }
    expect(fs.existsSync(legacyPath())).toBe(true);
    expect(fs.readFileSync(attemptsPath(), 'utf-8').trim()).toBe('1');
  });

  it('attempts 文件内容是非数字 → 视为 0,继续重试到 1', async () => {
    state.ssIsUsingNative = () => true;
    state.isEncryptionAvailable = () => false;
    fs.writeFileSync(attemptsPath(), 'not-a-number\n');
    writeValidLegacy();
    const m = await loadAuthClient();
    m.initAuth();
    expect(fs.readFileSync(attemptsPath(), 'utf-8').trim()).toBe('1');
  });

  it('attempts 文件内容是负数 → 视为 0,继续重试到 1', async () => {
    state.ssIsUsingNative = () => true;
    state.isEncryptionAvailable = () => false;
    fs.writeFileSync(attemptsPath(), '-5');
    writeValidLegacy();
    const m = await loadAuthClient();
    m.initAuth();
    expect(fs.readFileSync(attemptsPath(), 'utf-8').trim()).toBe('1');
  });
});

describe('migrateLegacyAuthIfNeeded: 成功路径', () => {
  it('完整迁移成功 → 删老文件 + 删 attempts + 写 marker(migrated)', async () => {
    state.ssIsUsingNative = () => true;
    fs.writeFileSync(attemptsPath(), '1');
    writeValidLegacy();
    const m = await loadAuthClient();
    m.initAuth();
    expect(fs.existsSync(legacyPath())).toBe(false);
    expect(fs.existsSync(attemptsPath())).toBe(false);
    expect(fs.readFileSync(markerPath(), 'utf-8')).toContain('migrated');
    // 验证数据真的写入了 ssSet 默认存储
    const data = state.storage.get('TideMind::cloud-auth');
    expect(data).toBeDefined();
    const parsed = JSON.parse(data!.toString('utf-8'));
    expect(parsed.accessToken).toMatch(/^access-token-/);
    expect(parsed.refreshToken).toMatch(/^refresh-token-/);
  });

  it('迁移成功后 initAuth() 调 loadAuthFromDisk → cachedAuth 被恢复(isLoggedIn=true)', async () => {
    state.ssIsUsingNative = () => true;
    state.ssIsAvailable = () => true;
    writeValidLegacy();
    const m = await loadAuthClient();
    m.initAuth();
    expect(m.isLoggedIn()).toBe(true);
    const auth = m.getCloudAuth();
    expect(auth).not.toBeNull();
    expect(auth!.userId).toBe('u1');
    expect(auth!.email).toBe('a@b.com');
  });

  it('email/userId 可空(null) → 仍 pass schema 校验', async () => {
    state.ssIsUsingNative = () => true;
    const auth = {
      accessToken: 'a' + 'A'.repeat(100),
      refreshToken: 'r' + 'R'.repeat(100),
      userId: null,
      email: null,
      plan: null,
      expiresAt: Date.now() + 3600_000,
      lastSyncedAt: null,
    };
    writeValidLegacy(auth);
    const m = await loadAuthClient();
    m.initAuth();
    expect(fs.readFileSync(markerPath(), 'utf-8')).toContain('migrated');
  });
});

describe('migrateLegacyAuthIfNeeded: 多次启动重试到成功(audit-3 CRITICAL #1 修复)', () => {
  it('第一次 safeStorage 不可用 → attempts=1;第二次 safeStorage 恢复 → 迁成功', async () => {
    state.ssIsUsingNative = () => true;
    state.isEncryptionAvailable = () => false;
    writeValidLegacy();
    let m = await loadAuthClient();
    m.initAuth();
    expect(fs.readFileSync(attemptsPath(), 'utf-8').trim()).toBe('1');
    expect(fs.existsSync(legacyPath())).toBe(true);
    expect(fs.existsSync(markerPath())).toBe(false);

    // 第二次启动:safeStorage 恢复
    state.isEncryptionAvailable = () => true;
    m = await loadAuthClient();
    m.initAuth();
    expect(fs.existsSync(legacyPath())).toBe(false);
    expect(fs.existsSync(attemptsPath())).toBe(false);
    expect(fs.readFileSync(markerPath(), 'utf-8')).toContain('migrated');
  });

  it('第一次 secureStore.set 失败 + 第二次恢复 → 第二次迁成功', async () => {
    state.ssIsUsingNative = () => true;
    let setCallCount = 0;
    state.ssSet = (s, a, v) => {
      setCallCount++;
      if (setCallCount === 1) throw new Error('first-fail');
      state.storage.set(`${s}::${a}`, Buffer.from(v));
    };
    writeValidLegacy();

    let m = await loadAuthClient();
    m.initAuth();
    expect(fs.existsSync(legacyPath())).toBe(true);
    expect(fs.readFileSync(attemptsPath(), 'utf-8').trim()).toBe('1');

    m = await loadAuthClient();
    m.initAuth();
    expect(fs.existsSync(legacyPath())).toBe(false);
    expect(fs.readFileSync(markerPath(), 'utf-8')).toContain('migrated');
  });
});

describe('migrateLegacyAuthIfNeeded: marker 写失败容错', () => {
  it('writeMigrationMarker 抛错(磁盘满)→ 不冒泡崩主流程', async () => {
    state.ssIsUsingNative = () => true;
    const origWrite = fs.writeFileSync.bind(fs);
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation((p, data, opts) => {
      if (typeof p === 'string' && p.endsWith(MARKER)) {
        throw new Error('ENOSPC');
      }
      return (origWrite as any)(p, data, opts);
    });
    try {
      const m = await loadAuthClient();
      expect(() => m.initAuth()).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});

// ============================================================================
// Audit-3 F5: loadAuthFromDisk schema validation
// ============================================================================
//
// initAuth → loadAuthFromDisk 在 JSON.parse 成功后必须做 schema 校验,
// 否则畸形数据(TimeMachine 半还原 / 手工修改 / 老版本 schema 残留)被加载后
// 下游访问 accessToken/refreshToken/expiresAt 字段会 undefined 触发崩溃。
describe('loadAuthFromDisk schema validation (Audit-3 F5)', () => {
  // 跳过 migrate 路径:写 marker 后 loadAuthFromDisk 直接被调
  function setMarkerSoMigrateSkipped(): void {
    fs.writeFileSync(markerPath(), '2026-05-21T00:00:00Z test\n', { mode: 0o600 });
  }

  it('secureStore.get 返回 {} (non-conforming) → loadAuthFromDisk 清掉 + isLoggedIn=false', async () => {
    state.ssIsUsingNative = () => true;
    state.ssIsAvailable = () => true;
    setMarkerSoMigrateSkipped();
    // 直接预填 storage 一个不合格的 blob
    state.storage.set('TideMind::cloud-auth', Buffer.from('{}', 'utf-8'));

    const m = await loadAuthClient();
    m.initAuth();
    expect(m.isLoggedIn()).toBe(false);
    expect(m.getCloudAuth()).toBeNull();
    // 清掉:secureStore.delete 被调,storage 应空
    expect(state.storage.has('TideMind::cloud-auth')).toBe(false);
  });

  it('合法 schema → loadAuthFromDisk 成功恢复', async () => {
    state.ssIsUsingNative = () => true;
    state.ssIsAvailable = () => true;
    setMarkerSoMigrateSkipped();
    const valid = {
      accessToken: 'a' + 'A'.repeat(100),
      refreshToken: 'r' + 'R'.repeat(100),
      userId: 'u1',
      email: 'x@y',
      plan: null,
      expiresAt: Date.now() + 3600_000,
      lastSyncedAt: null,
    };
    state.storage.set('TideMind::cloud-auth', Buffer.from(JSON.stringify(valid), 'utf-8'));

    const m = await loadAuthClient();
    m.initAuth();
    expect(m.isLoggedIn()).toBe(true);
    const a = m.getCloudAuth();
    expect(a!.userId).toBe('u1');
  });

  it('部分字段缺失(accessToken 没有)→ 视作畸形,清掉', async () => {
    state.ssIsUsingNative = () => true;
    state.ssIsAvailable = () => true;
    setMarkerSoMigrateSkipped();
    const partial = {
      refreshToken: 'r' + 'R'.repeat(100),
      userId: 'u1',
      email: 'x@y',
      plan: null,
      expiresAt: Date.now() + 3600_000,
      lastSyncedAt: null,
    };
    state.storage.set('TideMind::cloud-auth', Buffer.from(JSON.stringify(partial), 'utf-8'));

    const m = await loadAuthClient();
    m.initAuth();
    expect(m.isLoggedIn()).toBe(false);
    expect(state.storage.has('TideMind::cloud-auth')).toBe(false);
  });
});

// ============================================================================
// Audit-3 F8: getCloudAuth() 返回 shallow clone,updateCloudAuth 受控更新
// ============================================================================
describe('getCloudAuth + updateCloudAuth (Audit-3 F8)', () => {
  function setMarkerSoMigrateSkipped(): void {
    fs.writeFileSync(markerPath(), '2026-05-21T00:00:00Z test\n', { mode: 0o600 });
  }

  function seedAuth(): void {
    state.ssIsUsingNative = () => true;
    state.ssIsAvailable = () => true;
    setMarkerSoMigrateSkipped();
    const valid = {
      accessToken: 'a' + 'A'.repeat(100),
      refreshToken: 'r' + 'R'.repeat(100),
      userId: 'u1',
      email: 'x@y',
      plan: null,
      expiresAt: Date.now() + 3600_000,
      lastSyncedAt: null,
    };
    state.storage.set('TideMind::cloud-auth', Buffer.from(JSON.stringify(valid), 'utf-8'));
  }

  it('getCloudAuth 返回 shallow clone:caller 改返回对象不影响内部 cachedAuth', async () => {
    seedAuth();
    const m = await loadAuthClient();
    m.initAuth();

    const a1 = m.getCloudAuth();
    expect(a1).not.toBeNull();
    // 篡改字段
    a1!.email = 'evil@example.com';
    a1!.accessToken = 'evil-token';

    // 再次取,值应未变
    const a2 = m.getCloudAuth();
    expect(a2!.email).toBe('x@y');
    expect(a2!.accessToken).toBe('a' + 'A'.repeat(100));
  });

  it('updateCloudAuth 更新 lastSyncedAt → 内存 + 磁盘都被更新', async () => {
    seedAuth();
    const m = await loadAuthClient();
    m.initAuth();

    const now = '2026-05-21T10:00:00.000Z';
    m.updateCloudAuth({ lastSyncedAt: now });

    expect(m.getCloudAuth()!.lastSyncedAt).toBe(now);
    // 磁盘也更新
    const onDisk = JSON.parse(state.storage.get('TideMind::cloud-auth')!.toString('utf-8'));
    expect(onDisk.lastSyncedAt).toBe(now);
  });

  it('updateCloudAuth 在 cachedAuth=null 时 → no-op,不抛', async () => {
    setMarkerSoMigrateSkipped();
    const m = await loadAuthClient();
    m.initAuth();
    expect(m.isLoggedIn()).toBe(false);
    // not logged in,调 update 应无操作
    expect(() => m.updateCloudAuth({ lastSyncedAt: 'whatever' })).not.toThrow();
    expect(m.getCloudAuth()).toBeNull();
  });
});
