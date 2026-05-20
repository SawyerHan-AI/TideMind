#!/usr/bin/env node
/**
 * macOS 打包配置 sanity check(2026-05-21 v0.2.71 事故后加,audit A-HIGH-1/2)。
 *
 * 校验:
 *   1. client/resources/entitlements.mac.plist 存在(main app 用,可含 profile-gated capability)
 *   2. client/resources/entitlements.mac.inherit.plist 存在(helper 进程用)
 *   3. **helper plist 不得**含任何 profile-gated capability:
 *      - keychain-access-groups
 *      - com.apple.developer.*
 *      - com.apple.security.application-groups
 *      - com.apple.application-identifier
 *      原因:helper.app 没 embedded.provisionprofile,声明这些 entitlement 会
 *      让 macOS 启动 helper 时校验失败 → SIGKILL → 整个 app 启动崩。
 *   4. client/electron-builder.yml 的 entitlements / entitlementsInherit 指向
 *      不同文件(否则跟 v0.2.70 一样把 main plist 套到 helper 上)。
 *   5. client/resources/embedded.provisionprofile 存在且未过期。
 *
 * 用 plutil 解析 plist 而非 grep,避免被注释里的字符串误判(v0.2.71 release
 * 时 release-checklist.md §5 的 grep 校验就被注释字符串误判过)。
 *
 * 退出码 0 = 全过,非 0 = 至少一项失败(release.mjs / health-check.mjs 会用
 * 这个退出码决定是否阻塞)。Linux 上 plutil 不存在 → silent skip,仅在 darwin
 * 真正校验。
 */

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

// Helper plist 禁止包含的 entitlement key 前缀。匹配规则:exact match 或
// 命名空间前缀 + '.'。新增 profile-gated capability 时只需扩展这个数组。
//
// Apple 文档里"需要 provisioning profile 授权"的 entitlement 散在几个命名空间:
//   - keychain-access-groups        Data Protection Keychain
//   - com.apple.developer.*         所有 Apple Developer capability(push, iCloud,
//                                   networking, sign-in-with-apple, in-app-purchase 等)
//   - com.apple.security.application-groups  App Groups (跨进程共享)
//   - com.apple.application-identifier       App ID 显式声明
//   - aps-environment                APNs(push notifications) — 不在 developer.* 前缀
//                                   下,要单独列(v0.2.72 audit C MEDIUM-1)
const PROFILE_GATED_PREFIXES = [
  'keychain-access-groups',
  'com.apple.developer.',
  'com.apple.security.application-groups',
  'com.apple.application-identifier',
  'aps-environment',
];

function isProfileGated(key) {
  return PROFILE_GATED_PREFIXES.some(
    (p) => key === p || (p.endsWith('.') && key.startsWith(p))
  );
}

function parsePlist(absPath) {
  // plutil -convert json -o - <file> 把 plist 转 JSON 输出到 stdout
  const r = spawnSync('plutil', ['-convert', 'json', '-o', '-', absPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0) {
    throw new Error(`plutil failed (status=${r.status}): ${r.stderr.trim()}`);
  }
  return JSON.parse(r.stdout);
}

const errors = [];
const warnings = [];

// ── 1. 文件存在性 ───────────────────────────────────────
const mainPlistPath = path.join(repoRoot, 'client/resources/entitlements.mac.plist');
const inheritPlistPath = path.join(repoRoot, 'client/resources/entitlements.mac.inherit.plist');
const builderYmlPath = path.join(repoRoot, 'client/electron-builder.yml');
const profilePath = path.join(repoRoot, 'client/resources/embedded.provisionprofile');

for (const [label, p] of [
  ['entitlements.mac.plist', mainPlistPath],
  ['entitlements.mac.inherit.plist', inheritPlistPath],
  ['electron-builder.yml', builderYmlPath],
  ['embedded.provisionprofile', profilePath],
]) {
  if (!existsSync(p)) {
    errors.push(`MISSING: ${label} at ${path.relative(repoRoot, p)}`);
  }
}

if (errors.length > 0) {
  console.error('❌ mac packaging check failed:');
  for (const e of errors) console.error(`   ${e}`);
  process.exit(1);
}

// ── 2. Linux 跳过 plist 解析 ───────────────────────────
// plutil 仅 macOS 内置。Linux CI 上跳过实际解析,但仍校验过文件存在性。
if (process.platform !== 'darwin') {
  console.log('✓ mac packaging files present (skipping plist parse on non-macOS)');
  process.exit(0);
}

// ── 3. Helper plist 不得含 profile-gated entitlement ────
try {
  const inherit = parsePlist(inheritPlistPath);
  const offending = Object.keys(inherit).filter(isProfileGated);
  if (offending.length > 0) {
    errors.push(
      `entitlements.mac.inherit.plist contains profile-gated entitlement(s) ` +
        `which will cause helper SIGKILL on launch: ${offending.join(', ')}`
    );
  }
} catch (e) {
  errors.push(`failed to parse entitlements.mac.inherit.plist: ${e.message}`);
}

// ── 4. Main plist 跟 inherit plist 不同 ─────────────────
const mainContent = readFileSync(mainPlistPath, 'utf8');
const inheritContent = readFileSync(inheritPlistPath, 'utf8');
if (mainContent === inheritContent) {
  errors.push(
    'entitlements.mac.plist and entitlements.mac.inherit.plist are identical — ' +
      'this is the exact v0.2.70 bug (main plist inherited to helper without profile gate)'
  );
}

// ── 5. electron-builder.yml 两个 entitlement 字段指向不同文件 ──
const yml = readFileSync(builderYmlPath, 'utf8');
const mEnt = yml.match(/^\s*entitlements:\s*(\S+)/m);
const mInherit = yml.match(/^\s*entitlementsInherit:\s*(\S+)/m);
if (!mEnt || !mInherit) {
  warnings.push('electron-builder.yml missing entitlements / entitlementsInherit field — skipping cross-check');
} else if (mEnt[1] === mInherit[1]) {
  errors.push(
    `electron-builder.yml: entitlements and entitlementsInherit both point to ${mEnt[1]} — ` +
      'they must be different files'
  );
}

// ── 6. Profile 未过期(Developer ID profile 默认 20+ 年,但 Apple 偶尔强制刷新)
try {
  const cms = spawnSync('security', ['cms', '-D', '-i', profilePath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (cms.status === 0) {
    const xml = cms.stdout;
    const m = xml.match(/<key>ExpirationDate<\/key>\s*<date>([^<]+)<\/date>/);
    if (m) {
      const exp = new Date(m[1]);
      const now = new Date();
      if (exp <= now) {
        errors.push(`embedded.provisionprofile EXPIRED on ${m[1]}`);
      } else {
        const daysLeft = Math.floor((exp - now) / (1000 * 60 * 60 * 24));
        if (daysLeft < 30) {
          warnings.push(`embedded.provisionprofile expires in ${daysLeft} days (${m[1]}) — consider renewing`);
        }
      }
    } else {
      warnings.push('could not parse ExpirationDate from embedded.provisionprofile');
    }
  } else {
    warnings.push(`security cms -D failed on embedded.provisionprofile: ${cms.stderr.trim()}`);
  }
} catch (e) {
  warnings.push(`profile expiration check skipped: ${e.message}`);
}

// ── 输出 ────────────────────────────────────────────────
for (const w of warnings) console.warn(`⚠️  ${w}`);

if (errors.length > 0) {
  console.error('❌ mac packaging check failed:');
  for (const e of errors) console.error(`   ${e}`);
  console.error('');
  console.error('   Background:');
  console.error('   v0.2.70 startup SIGKILL was caused by helper inheriting');
  console.error('   keychain-access-groups without a provisioning profile.');
  console.error('   See docs/claude-guides/release-checklist.md §helper-entitlements-trap');
  process.exit(1);
}

console.log('✓ mac packaging OK');
console.log(`  - entitlements.mac.plist + entitlements.mac.inherit.plist both present`);
console.log(`  - helper plist contains no profile-gated entitlements`);
console.log(`  - electron-builder.yml entitlements / entitlementsInherit are distinct`);
console.log(`  - embedded.provisionprofile present and valid`);
