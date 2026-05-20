/**
 * 跨平台 secret 存储抽象层。
 *
 * 解决的问题(见 docs/design/keychain-prompt-elimination-2026-05-20.md):
 *   Electron 的 safeStorage 在 macOS 上用 legacy file-based keychain,
 *   每次启动都会弹"允许/始终允许"钥匙串授权窗口,且签名/Electron 升级/Sparkle
 *   更新都可能让信任链失效再次弹窗。
 *
 * 平台策略:
 *   macOS:   走 secure-store-mac native addon → SecItem* + Data Protection Keychain。
 *            必须配合 keychain-access-groups entitlement + embedded provisioning profile,
 *            否则 isAvailable() 返回 false,降级到"不落盘、强制重登"。
 *   Windows: safeStorage 用 DPAPI,无弹窗,保留原路径。
 *   Linux:   safeStorage 用 libsecret/KWallet,无弹窗,保留原路径。
 *
 * 紧急回退:环境变量 TIDEMIND_USE_LEGACY_KEYCHAIN=1 强制所有平台走 safeStorage 路径,
 *   用于线上发现新方案有问题时不发新版本就能撤回。
 *
 * Dev mode:未签名的 `npm run dev` 在 macOS 上 native addon 必然 isAvailable=false
 *   (没 entitlement 没 profile),会变成"每次启动都要重登"。如需在 dev 测试持久化,
 *   设置 TIDEMIND_USE_LEGACY_KEYCHAIN=1 让它走 safeStorage(会弹钥匙串,但能保持登录)。
 */

import fs from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import { createLogger } from '../../../src/utils/logger.js';
import { getDataDir } from '../../../src/config.js';

const log = createLogger('secure-store');

// ----------------------------------------------------------------------------
// Native addon 加载(macOS only)
// ----------------------------------------------------------------------------

interface NativeStore {
  isAvailable(): boolean;
  set(service: string, account: string, value: Buffer): void;
  get(service: string, account: string): Buffer | null;
  delete(service: string, account: string): void;
}

let nativeStore: NativeStore | null = null;
let nativeAvailable = false;

/**
 * 紧急回退开关。宽松匹配:任何非空、非 "0" / "false" / "no" 的值都视为开。
 * 严格 === '1' 会让支持工程师远程救场时写错值(如 "true" / "yes")导致无效——
 * 紧急回退本来就是兜底,语义应该尽量宽容(audit-2 MEDIUM)。
 */
function parseForceLegacy(): boolean {
  const v = process.env.TIDEMIND_USE_LEGACY_KEYCHAIN;
  if (!v) return false;
  const lower = v.toLowerCase().trim();
  return lower !== '' && lower !== '0' && lower !== 'false' && lower !== 'no' && lower !== 'off';
}

const forceLegacy = parseForceLegacy();

if (process.platform === 'darwin' && !forceLegacy) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    nativeStore = require('secure-store-mac') as NativeStore;
    nativeAvailable = nativeStore.isAvailable();
    if (nativeAvailable) {
      log.info('using macOS Data Protection Keychain (no ACL prompts)');
    } else {
      // 未签名 dev build / entitlement / profile 没配好。
      // 不退回 safeStorage——按设计文档 §4.7 这是设计选择:
      //   宁可强制用户重登,也不让弹窗复活。
      log.warn('secure-store-mac native module loaded but isAvailable()=false — auth will NOT persist (likely missing entitlement or provisioning profile; dev builds: set TIDEMIND_USE_LEGACY_KEYCHAIN=1)');
    }
  } catch (err) {
    log.warn(`secure-store-mac native module failed to load: ${(err as Error).message} — auth will NOT persist`);
  }
} else if (forceLegacy) {
  log.warn('TIDEMIND_USE_LEGACY_KEYCHAIN=1 — using safeStorage fallback on all platforms');
}

// ----------------------------------------------------------------------------
// safeStorage + 文件 fallback(Windows / Linux / 紧急回退用)
// ----------------------------------------------------------------------------

/**
 * 把 (service, account) 映射到磁盘文件路径。
 * 只用于 non-macOS 或 forceLegacy 路径——macOS 默认走 keychain,不落盘。
 *
 * **向后兼容(关键!)**:v0.2.69 及之前的 cloud-auth 落盘路径是 `cloud-auth.json`,
 * 不是新约定的 `.TideMind-cloud-auth.bin`。Windows / Linux 用户升级到 v0.2.70 时
 * 没有 native 路径触发迁移逻辑,如果这里改了路径全员会被静默重登。
 * 把 (TideMind, cloud-auth) 这一组合 hardcode 回老路径,保持升级路径无感。
 *
 * 其他 (service, account) 组合走新约定。未来加新 service 用新约定即可。
 */
function legacyFilePath(service: string, account: string): string {
  // service/account 都是我们自己控制的常量,不做转义。如果未来变成用户输入需要 sanitize。
  if (service === 'TideMind' && account === 'cloud-auth') {
    return path.join(getDataDir(), 'cloud-auth.json');
  }
  return path.join(getDataDir(), `.${service}-${account}.bin`);
}

function legacyIsAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

function legacySet(service: string, account: string, value: Buffer): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage encryption unavailable');
  }
  const encrypted = safeStorage.encryptString(value.toString('utf-8'));
  fs.writeFileSync(legacyFilePath(service, account), encrypted, { mode: 0o600 });
}

function legacyGet(service: string, account: string): Buffer | null {
  const filePath = legacyFilePath(service, account);
  if (!safeStorage.isEncryptionAvailable()) {
    // 无 keyring 时**不删**文件。常见瞬态:Linux 用户重启 GNOME Keyring daemon、
    // macOS 钥匙串临时锁定、系统升级中等(audit-2 MEDIUM)。删文件 = 这些可恢复场景
    // 也变成"被强制重登",违反"宁可重试也不丢登录态"的迁移原则。
    // 文件留着,等下次启动 keyring 恢复时再试。
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath);
    if (raw.length === 0) return null;  // 空文件,等同于不存在
    const json = safeStorage.decryptString(raw);
    return Buffer.from(json, 'utf-8');
  } catch (err) {
    const msg = (err as Error).message;
    // ENOENT 是预期(等同于 not found),返回 null。
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    log.warn(`legacy decrypt failed for ${service}/${account}: ${msg}`);
    return null;
  }
}

function legacyDelete(service: string, account: string): void {
  try { fs.unlinkSync(legacyFilePath(service, account)); } catch { /* ignore */ }
}

// ----------------------------------------------------------------------------
// 公共 API
// ----------------------------------------------------------------------------

function useNative(): boolean {
  return !forceLegacy && nativeAvailable && nativeStore !== null;
}

export const secureStore = {
  /**
   * 后续 set/get/delete 是否能成功持久化。
   *   - true:  有可用后端(macOS Data Protection Keychain 或 safeStorage)
   *   - false: 调用方应跳过持久化,登录态只保留在内存
   */
  isAvailable(): boolean {
    if (useNative()) return true;
    if (process.platform !== 'darwin' || forceLegacy) return legacyIsAvailable();
    // macOS native 不可用且没强制 legacy → 不持久化
    return false;
  },

  set(service: string, account: string, value: Buffer): void {
    if (useNative()) {
      nativeStore!.set(service, account, value);
      return;
    }
    legacySet(service, account, value);
  },

  get(service: string, account: string): Buffer | null {
    if (useNative()) {
      return nativeStore!.get(service, account);
    }
    return legacyGet(service, account);
  },

  delete(service: string, account: string): void {
    if (useNative()) {
      nativeStore!.delete(service, account);
      return;
    }
    legacyDelete(service, account);
  },

  /**
   * 暴露给迁移逻辑用:当前是不是走 native 路径。
   * auth-client 的 migrateLegacyAuthIfNeeded() 用这个决定要不要把老的
   * safeStorage 加密文件迁到 Data Protection Keychain。
   */
  isUsingNative(): boolean {
    return useNative();
  },
};
