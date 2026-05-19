#!/usr/bin/env node
/**
 * 补签已发布的 GitHub release(release.mjs 中 signReleaseAssets 步骤的独立版本)。
 *
 * 用法:
 *   SIGNING_PRIVATE_KEY="$(cat ~/key.tmp.pem)" \
 *     node scripts/sign-existing-release.mjs --version 0.2.62 --oss-repo ~/Projects/tidemind
 *
 * 或者用 1Password CLI(需先 brew install 1password-cli 并 op signin):
 *   SIGNING_PRIVATE_KEY="$(op read 'op://Private/TideMind Release Signing/private-key')" \
 *     node scripts/sign-existing-release.mjs --version 0.2.62 --oss-repo ~/Projects/tidemind
 *
 * 行为:
 *   对每个 (platform, arch) 的 DMG asset 签名 "${version}\n${dmgUrl}",
 *   把签名(base64)作为独立 asset 上传到 release(命名 update-manifest-{platform}-{arch}.sig)。
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function parseArgs(argv) {
  const opts = { version: null, ossRepo: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--version') opts.version = argv[++i];
    else if (argv[i] === '--oss-repo') opts.ossRepo = path.resolve(argv[++i]);
  }
  if (!opts.version) throw new Error('--version 必填');
  if (!opts.ossRepo) throw new Error('--oss-repo 必填(开源仓库本地路径,如 ~/Projects/tidemind)');
  if (!fs.existsSync(path.join(opts.ossRepo, '.git'))) {
    throw new Error(`OSS repo 不是 git repo: ${opts.ossRepo}`);
  }
  return opts;
}

function captureJson(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: 'pipe', env: process.env });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stderr}`);
  return JSON.parse(r.stdout);
}

function run(cmd, args, cwd) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', env: process.env });
  if (r.status !== 0) throw new Error(`${cmd} 失败 exit=${r.status}`);
}

/**
 * PEM 规范化:macOS Keychain 的 `security add-generic-password -w "$value"` 在
 * 某些 zsh / locale 配置下会把多行 PEM 折叠成一行(BEGIN/body/END 用空格连接),
 * 导致 OpenSSL 报 DECODER routines::unsupported。这里把任何"包含 BEGIN/END
 * 但缺标准换行"的输入修复成标准 PEM(BEGIN 一行 + 每 64 字符 base64 一行 + END 一行)。
 */
function normalizePEM(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  // 已经是合法多行 PEM(BEGIN 后面紧跟换行)直接返回
  if (/-----BEGIN [^\n-]+-----\n/.test(raw)) return raw;
  const m = raw.match(/^[\s]*(-----BEGIN [^-]+-----)\s*(.+?)\s*(-----END [^-]+-----)\s*$/s);
  if (!m) return raw;
  const [, begin, body, end] = m;
  const clean = body.replace(/\s+/g, ''); // 去掉所有空格/换行
  const lines = clean.match(/.{1,64}/g) || [];
  return `${begin}\n${lines.join('\n')}\n${end}\n`;
}

function loadKeychainKey() {
  if (process.platform !== 'darwin') return null;
  const r = spawnSync('security', [
    'find-generic-password',
    '-a', 'tidemind',
    '-s', 'tidemind-signing-key',
    '-w',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status === 0 && r.stdout && r.stdout.includes('-----BEGIN')) {
    return normalizePEM(r.stdout);
  }
  return null;
}

function main() {
  const { version, ossRepo } = parseArgs(process.argv.slice(2));
  let privateKeyPem = process.env.SIGNING_PRIVATE_KEY;
  let source = 'env';
  if (!privateKeyPem) {
    privateKeyPem = loadKeychainKey();
    source = 'keychain';
  }
  if (!privateKeyPem) {
    throw new Error(
      '签名私钥不可得。配置二选一:\n' +
      '  (推荐) macOS Keychain 一次性导入:\n' +
      '    # 先从 1Password 复制私钥(整段 PEM)\n' +
      '    security add-generic-password -U -a tidemind -s tidemind-signing-key -w "$(pbpaste)"\n' +
      '    pbcopy < /dev/null\n' +
      '    # 之后所有发版自动取,无需任何 env\n' +
      '  (或) export SIGNING_PRIVATE_KEY="$(pbpaste)" 一次性注入\n',
    );
  }
  console.log(`Using signing key from ${source}`);

  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(privateKeyPem);
  } catch (err) {
    throw new Error(`SIGNING_PRIVATE_KEY 解析失败(不是合法 PEM PKCS8 ed25519 私钥): ${err.message}`);
  }

  console.log(`\nFetching release v${version} assets...`);
  const release = captureJson(
    'gh',
    ['release', 'view', `v${version}`, '--repo', 'SawyerHan-AI/TideMind', '--json', 'assets'],
    ossRepo,
  );

  const targets = [
    { platform: 'darwin', arch: 'arm64', match: /arm64.*\.dmg$/ },
    { platform: 'darwin', arch: 'x64', match: /x64.*\.dmg$/ },
  ];

  for (const { platform, arch, match } of targets) {
    const asset = release.assets.find((a) => match.test(a.name));
    if (!asset) {
      console.log(`  skip ${platform}/${arch}: no matching asset`);
      continue;
    }
    // gh CLI 的 asset 字段命名跟 GitHub REST API 不一致:
    //   gh CLI:  asset.url = 下载 URL(browser-facing),asset.apiUrl = REST API URL
    //   REST API 原始: asset.url = REST API URL,asset.browser_download_url = 下载 URL
    // 这里走 `gh release view --json assets`,所以 asset.url 已经是下载 URL,与
    // cloud-server 端点 findAsset 返回值(REST API 上下文的 browser_download_url)
    // 一致,客户端验签的 message 才能对上。
    // 2026-05-20 误把这里改成 asset.browser_download_url,在 gh CLI 上下文该字段是
    // undefined,签出 "version\nundefined" 的错 .sig,导致 v0.2.66 全量客户端拒绝
    // 更新。本提交是该错误的 revert。
    const url = asset.url ?? asset.browser_download_url;
    const message = Buffer.from(`${version}\n${url}`, 'utf8');
    const sig = crypto.sign(null, message, privateKey).toString('base64');
    const sigPath = path.join(os.tmpdir(), `update-manifest-${platform}-${arch}.sig`);
    fs.writeFileSync(sigPath, sig);
    console.log(`\nSigned ${platform}/${arch}:`);
    console.log(`  asset: ${asset.name}`);
    console.log(`  signature: ${sig.slice(0, 32)}...`);
    run(
      'gh',
      ['release', 'upload', `v${version}`, sigPath, '--repo', 'SawyerHan-AI/TideMind', '--clobber'],
      ossRepo,
    );
    fs.unlinkSync(sigPath);
  }

  console.log(`\n✓ Release v${version} signatures uploaded`);
}

try {
  main();
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
}
