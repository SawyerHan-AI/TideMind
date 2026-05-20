#!/usr/bin/env node
/**
 * One-command TideMind release orchestrator.
 *
 * This intentionally composes existing local scripts instead of replacing them:
 * - scripts/check-version-sync.mjs guards the six version surfaces.
 * - scripts/health-check.mjs remains the full local quality gate.
 * - sync-oss.sh remains the OSS filtering, PII scan, and OSS build/test gate.
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const defaultOssRepo = process.env.TIDEMIND_OSS_REPO
  ?? path.resolve(repoRoot, '..', 'tidemind');

export function parseArgs(argv) {
  const opts = {
    version: null,
    previousVersion: null,
    ossRepo: defaultOssRepo,
    ossMessage: null,
    notesFile: null,
    yes: false,
    dryRun: false,
    forceTag: false,
    allowNonMain: false,
    skipHealth: false,
    skipWebsite: false,
    skipCloudVerify: false,
    skipUpdateVerify: false,
    timeoutMinutes: 20,
    allowUnsigned: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case '--version': opts.version = next(); break;
      case '--previous-version': opts.previousVersion = next(); break;
      case '--oss-repo': opts.ossRepo = path.resolve(next()); break;
      case '--oss-message': opts.ossMessage = next(); break;
      case '--notes-file': opts.notesFile = path.resolve(next()); break;
      case '--timeout-minutes': opts.timeoutMinutes = Number(next()); break;
      case '--yes':
      case '-y':
        opts.yes = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--force-tag':
        opts.forceTag = true;
        break;
      case '--allow-non-main':
        opts.allowNonMain = true;
        break;
      case '--skip-health':
        opts.skipHealth = true;
        break;
      case '--allow-unsigned':
        opts.allowUnsigned = true;
        break;
      case '--skip-website':
        opts.skipWebsite = true;
        break;
      case '--skip-cloud-verify':
        opts.skipCloudVerify = true;
        break;
      case '--skip-update-verify':
        opts.skipUpdateVerify = true;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(opts.timeoutMinutes) || opts.timeoutMinutes <= 0) {
    throw new Error('--timeout-minutes must be a positive number');
  }
  return opts;
}

function printHelp() {
  console.log(`Usage: npm run release -- --version X.Y.Z --previous-version A.B.C --yes

Options:
  --version X.Y.Z          Version to release. Defaults to root package.json.
  --previous-version X.Y.Z Version used to verify update API. Defaults to previous patch.
  --oss-repo PATH          OSS repo path. Defaults to ../tidemind or TIDEMIND_OSS_REPO.
  --oss-message TEXT       Public OSS commit message.
  --notes-file PATH        Release notes markdown. Defaults to /tmp/notes-vX.Y.Z.md.
  --timeout-minutes N      Release workflow wait timeout. Defaults to 20.
  --yes, -y                Pass --yes to sync-oss.sh.
  --force-tag              Move an existing OSS tag to HEAD after confirmation-by-flag.
  --allow-non-main         CI dry-run escape hatch for detached checkouts.
  --dry-run                Print commands without mutating repositories or deployments.
  --skip-health            Skip npm run health.
  --skip-website           Skip Cloudflare Pages deploy.
  --skip-cloud-verify      Skip https://cloud.tidemind.ai/health verification.
  --skip-update-verify     Skip client update endpoint verification.
  --allow-unsigned         Allow release without ed25519 signature.
                           Without this flag, release fails if SIGNING_PRIVATE_KEY
                           is unset, forcing explicit acknowledgment of the supply
                           chain risk (anyone with GitHub write access can push
                           malicious binaries to all clients).
`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function commandToString(cmd, args) {
  return [cmd, ...args].map(part => /\s/.test(part) ? JSON.stringify(part) : part).join(' ');
}

function run(cmd, args, opts = {}) {
  const cwd = opts.cwd ?? repoRoot;
  const label = opts.label ?? commandToString(cmd, args);
  console.log(`\n> ${label}`);
  console.log(`  cwd: ${cwd}`);
  if (opts.dryRun) return { stdout: '', stderr: '', status: 0 };

  const result = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: opts.capture ? 'pipe' : 'inherit',
    env: process.env,
    timeout: opts.timeoutMs,
  });
  if (opts.capture && result.stdout) process.stdout.write(result.stdout);
  if (opts.capture && result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      throw new Error(`${label} timed out after ${Math.round(opts.timeoutMs / 60_000)} minute(s)`);
    }
    throw result.error;
  }
  if (result.status !== 0 && !opts.allowFailure) {
    throw new Error(`${label} failed with exit ${result.status}`);
  }
  return result;
}

function capture(cmd, args, cwd = repoRoot, allowFailure = false) {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${commandToString(cmd, args)} failed in ${cwd}\n${result.stderr || result.stdout}`);
  }
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function assertCleanRepo(cwd, label, dryRun = false) {
  const status = capture('git', ['status', '--porcelain'], cwd).stdout;
  if (status) {
    if (dryRun) {
      console.log(`\n> ${label} has uncommitted changes; dry-run continues:\n${status}`);
      return;
    }
    throw new Error(`${label} has uncommitted changes:\n${status}`);
  }
}

function assertMainBranch(cwd, label) {
  const branch = capture('git', ['branch', '--show-current'], cwd).stdout;
  if (branch !== 'main') {
    throw new Error(`${label} must be on main, currently on ${branch || '(detached)'}`);
  }
}

export function previousPatch(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  const patch = Number(match[3]);
  if (patch <= 0) return null;
  return `${match[1]}.${match[2]}.${patch - 1}`;
}

function ensureNotesFile(version, explicitPath) {
  const file = explicitPath ?? path.join(os.tmpdir(), `notes-v${version}.md`);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, [
      `## TideMind v${version}`,
      '',
      'This release focuses on reliability and maintenance improvements.',
      '',
      '- Improved release validation and deployment safety.',
      '- Updated dependencies and verification coverage.',
      '',
    ].join('\n'));
    console.log(`Created default release notes: ${file}`);
  }
  return file;
}

function parseJsonOutput(cmd, args, cwd) {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${commandToString(cmd, args)} failed\n${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

function listReleaseRuns(ossRepo) {
  return parseJsonOutput('gh', [
    'run',
    'list',
    '--repo',
    'SawyerHan-AI/TideMind',
    '--workflow',
    'Release',
    '--limit',
    '20',
    '--json',
    'databaseId,headBranch,event,status,createdAt,displayTitle',
  ], ossRepo);
}

export function findReleaseRunId(runs, tag) {
  const tagName = tag.startsWith('v') ? tag : `v${tag}`;
  const match = runs.find(run => run.headBranch === tagName || run.headBranch === tag);
  return match ? String(match.databaseId) : null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getReleaseRunId(tag, ossRepo, timeoutMs) {
  const tagName = tag.startsWith('v') ? tag : `v${tag}`;
  const started = Date.now();
  const deadline = started + timeoutMs;
  const pollMs = 5_000;
  let attempts = 0;
  let lastRunSummary = '';

  while (Date.now() <= deadline) {
    attempts++;
    const runs = listReleaseRuns(ossRepo);
    const runId = findReleaseRunId(runs, tag);
    if (runId) {
      if (attempts > 1) console.log(`✓ release workflow run appeared after ${attempts} checks`);
      return runId;
    }

    lastRunSummary = runs
      .slice(0, 5)
      .map(run => `${run.workflowName ?? 'Release'}:${run.headBranch ?? '(no branch)'}:${run.status ?? 'unknown'}`)
      .join(', ');
    console.log(`> Waiting for Release workflow run for ${tagName} (${attempts}); recent runs: ${lastRunSummary || 'none'}`);
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }

  const waitedSeconds = Math.round((Date.now() - started) / 1000);
  throw new Error(`Could not find Release workflow run for ${tagName} after ${waitedSeconds}s; recent runs: ${lastRunSummary || 'none'}`);
}

function assertTagState(tag, ossRepo, forceTag) {
  const tagName = `v${tag}`;
  const existing = capture('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tagName}`], ossRepo, true);
  if (existing.status !== 0) return 'create';

  const tagSha = capture('git', ['rev-parse', tagName], ossRepo).stdout;
  const headSha = capture('git', ['rev-parse', 'HEAD'], ossRepo).stdout;
  if (tagSha === headSha) return 'already-at-head';
  if (!forceTag) {
    throw new Error(`${tagName} already exists at ${tagSha.slice(0, 12)}; pass --force-tag to move it to HEAD`);
  }
  return 'move';
}

async function fetchJson(url) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) throw new Error(`${url} returned ${resp.status}`);
  return await resp.json();
}

async function verifyCloud(version) {
  const health = await fetchJson('https://cloud.tidemind.ai/health');
  if (health.version !== version) {
    throw new Error(`cloud health version ${health.version} !== ${version}`);
  }
  console.log(`✓ cloud health reports ${version}`);
}

async function verifyUpdateApi(version, previousVersion) {
  const base = 'https://cloud.tidemind.ai/api/v1/update/latest';
  const prevArm = await fetchJson(`${base}?platform=darwin&arch=arm64&version=${previousVersion}`);
  if (prevArm.version !== version || !prevArm.url?.includes(`v${version}`)) {
    throw new Error(`update API did not offer ${version} to ${previousVersion}: ${JSON.stringify(prevArm)}`);
  }
  const current = await fetchJson(`${base}?platform=darwin&arch=arm64&version=${version}`);
  if (current.url !== null) {
    throw new Error(`update API should return url:null for current version: ${JSON.stringify(current)}`);
  }
  console.log(`✓ update API offers ${version} to ${previousVersion} and no update to ${version}`);
}

/**
 * 离线签名:对每个 (platform, arch) 的 DMG asset 签名 "${version}\n${dmgUrl}",
 * 把签名(base64)作为独立 asset 上传(命名 `update-manifest-{platform}-{arch}.sig`)。
 *
 * SIGNING_PRIVATE_KEY env 未设 → 跳过(默认行为,向后兼容)。设了 → 必须是
 * ed25519 PEM PKCS8 私钥(generateKeyPairSync 的 privateKey.export 输出)。
 *
 * 这是 release 签名机制的"发布侧"实现;客户端验签侧在 client/electron/ipc/app.ts。
 * 用户启用流程:1) 生成 keypair 2) 私钥放 1Password 3) 公钥贴 app.ts 内置常量
 * 4) 发版时 SIGNING_PRIVATE_KEY=... npm run release。
 */
/**
 * Fallback 链取签名私钥:
 *   1. process.env.SIGNING_PRIVATE_KEY(CI / 一次性发版)
 *   2. macOS Keychain (`security find-generic-password -a tidemind -s tidemind-signing-key`)
 *      首次访问会弹 Touch ID / Master Password 解锁,可勾选"始终允许"减少摩擦。
 *   3. 都没 → 返回 null,调用方决定 fail-loud 还是 --allow-unsigned。
 */
/**
 * PEM 规范化(同 sign-existing-release.mjs):Keychain 在某些 shell 配置下
 * 会把多行 PEM 折叠成一行,OpenSSL 解析失败,这里恢复换行。
 */
function normalizePEM(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  if (/-----BEGIN [^\n-]+-----\n/.test(raw)) return raw;
  const m = raw.match(/^[\s]*(-----BEGIN [^-]+-----)\s*(.+?)\s*(-----END [^-]+-----)\s*$/s);
  if (!m) return raw;
  const [, begin, body, end] = m;
  const clean = body.replace(/\s+/g, '');
  const lines = clean.match(/.{1,64}/g) || [];
  return `${begin}\n${lines.join('\n')}\n${end}\n`;
}

function loadSigningPrivateKey() {
  const fromEnv = process.env.SIGNING_PRIVATE_KEY;
  if (fromEnv) return { pem: normalizePEM(fromEnv), source: 'env' };
  // macOS only:Linux 上 `security` 命令不存在,spawn 会失败,silent fall through。
  if (process.platform !== 'darwin') return { pem: null, source: null };
  try {
    const r = spawnSync('security', [
      'find-generic-password',
      '-a', 'tidemind',
      '-s', 'tidemind-signing-key',
      '-w',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.status === 0 && r.stdout && r.stdout.includes('-----BEGIN')) {
      return { pem: normalizePEM(r.stdout), source: 'keychain' };
    }
  } catch { /* security 不可用 → fall through */ }
  return { pem: null, source: null };
}

/**
 * 加载备用签名私钥(双 key 轮换支持)。
 *
 * Why: 紧急轮换主私钥时,本次发版需要用新的(主) + 旧的(secondary) 同时签,让
 * 老客户端用旧公钥验证 secondary .sig 通过,新客户端用新公钥验主 .sig 通过。
 * 详细流程见 client/electron/ipc/app.ts:UPDATE_PUBLIC_KEY_PEM_SECONDARY 注释。
 *
 * 顺序:env > Keychain(service=tidemind-signing-key-secondary)> null(不签)。
 */
function loadSecondarySigningPrivateKey() {
  const fromEnv = process.env.SIGNING_PRIVATE_KEY_SECONDARY;
  if (fromEnv) return { pem: normalizePEM(fromEnv), source: 'env' };
  if (process.platform !== 'darwin') return { pem: null, source: null };
  try {
    const r = spawnSync('security', [
      'find-generic-password',
      '-a', 'tidemind',
      '-s', 'tidemind-signing-key-secondary',
      '-w',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.status === 0 && r.stdout && r.stdout.includes('-----BEGIN')) {
      return { pem: normalizePEM(r.stdout), source: 'keychain' };
    }
  } catch { /* secondary 不存在 → silent,不签即可,不算错 */ }
  return { pem: null, source: null };
}

function signReleaseAssets(version, ossRepo, allowUnsigned = false) {
  const { pem: privateKeyPem, source } = loadSigningPrivateKey();
  if (privateKeyPem) {
    console.log(`\n> Signing release manifests (ed25519, key from ${source})`);
  }
  if (!privateKeyPem) {
    if (!allowUnsigned) {
      // 强制 opt-out:把"无签名发版"从 silent 默认变成必须主动放弃的决定。
      // 任何能写 SawyerHan-AI/TideMind GitHub release 的人(GH_TOKEN 泄漏 / 账号被盗)
      // 可以推恶意 DMG 给全量用户。签名机制(client/electron/ipc/app.ts +
      // pro/cloud-server/src/update/routes.ts)已就位,密钥未生成时这条防线不工作。
      // 启用流程见 client/electron/ipc/app.ts:UPDATE_PUBLIC_KEY_PEM 上方注释。
      throw new Error(
        '\n!!! Release signing is REQUIRED but no private key is available.\n' +
        '    Without signing, anyone with write access to the GitHub release\n' +
        '    can push malicious binaries to all clients (supply chain attack).\n' +
        '\n    Key sources checked (in order):\n' +
        '      1. process.env.SIGNING_PRIVATE_KEY            (not set)\n' +
        '      2. macOS Keychain (account=tidemind,\n' +
        '         service=tidemind-signing-key)              (not found)\n' +
        '\n    To enable:\n' +
        '      (a) One-time:  security add-generic-password -U \\\n' +
        '                       -a tidemind -s tidemind-signing-key -w "$(pbpaste)"\n' +
        '          (first copy private key from 1Password)\n' +
        '      (b) Or pass:   SIGNING_PRIVATE_KEY="$(...)" npm run release ...\n' +
        '      (c) Or skip:   add --allow-unsigned (clients with embedded\n' +
        '                     public key will REJECT this release)\n',
      );
    }
    console.log('\n> WARNING: Releasing unsigned binaries (--allow-unsigned).');
    console.log('  Clients with embedded public key will REJECT this release.');
    console.log('  Clients without embedded public key will accept it (current default).');
    return;
  }
  const release = parseJsonOutput('gh', [
    'release', 'view', `v${version}`, '--repo', 'SawyerHan-AI/TideMind',
    '--json', 'assets',
  ], ossRepo);
  // 客户端期望的 (platform, arch) 对应 DMG/zip 命名。
  const targets = [
    { platform: 'darwin', arch: 'arm64', match: /arm64.*\.dmg$/ },
    { platform: 'darwin', arch: 'x64', match: /x64.*\.dmg$/ },
  ];
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(privateKeyPem);
  } catch (err) {
    throw new Error(`SIGNING_PRIVATE_KEY parse failed: ${err.message}`);
  }

  // Secondary key:轮换期间用第二个私钥同时签 .sig.secondary。不配置则跳过。
  const { pem: secondaryPem, source: secondarySource } = loadSecondarySigningPrivateKey();
  let secondaryKey = null;
  if (secondaryPem) {
    try {
      secondaryKey = crypto.createPrivateKey(secondaryPem);
      console.log(`  Secondary key loaded from ${secondarySource} — will dual-sign for rotation`);
    } catch (err) {
      // secondary 解析失败 → fail-loud,因为如果运维主动给了备用 key,默默 skip 会让
      // 轮换过程的发版静默退化为单 key 签,达不到双 key 平滑切换的目的。
      throw new Error(`SIGNING_PRIVATE_KEY_SECONDARY parse failed: ${err.message}`);
    }
  }

  for (const { platform, arch, match } of targets) {
    const asset = release.assets.find(a => match.test(a.name));
    if (!asset) {
      console.log(`  skip ${platform}/${arch}: no matching asset`);
      continue;
    }
    // 用 hardcoded 稳定下载 URL,不依赖 gh CLI 返回的 asset.url。
    // 历史踩坑(v0.2.66 / v0.2.67):
    //   - asset.url 在 draft release 是 `releases/download/untagged-<hash>/...`,
    //     publish 后才变成 `releases/download/v<version>/...`。
    //   - 端点 findAsset 用的是 publish 后的稳定 URL,客户端验签的 message 也是。
    //   - 如果在 publish 前签 .sig(本脚本被这样用过),签的是 untagged URL,
    //     publish 后客户端拉的 .sig 跟端点给的 url 对不上 → 验签 invalid → 拒绝更新。
    // 修复:hardcoded 拼接稳定 URL,无论 release state,签名内容永远一致。
    // 注意 sign-existing-release.mjs 同步修复。
    const url = `https://github.com/SawyerHan-AI/TideMind/releases/download/v${version}/${asset.name}`;
    const message = Buffer.from(`${version}\n${url}`, 'utf8');
    const sig = crypto.sign(null, message, privateKey).toString('base64');
    const sigPath = path.join(os.tmpdir(), `update-manifest-${platform}-${arch}.sig`);
    fs.writeFileSync(sigPath, sig);
    run('gh', [
      'release', 'upload', `v${version}`, sigPath,
      '--repo', 'SawyerHan-AI/TideMind', '--clobber',
    ], { cwd: ossRepo, label: `upload signature ${platform}/${arch}` });

    if (secondaryKey) {
      const sigSec = crypto.sign(null, message, secondaryKey).toString('base64');
      const sigSecPath = path.join(os.tmpdir(), `update-manifest-${platform}-${arch}.sig.secondary`);
      fs.writeFileSync(sigSecPath, sigSec);
      run('gh', [
        'release', 'upload', `v${version}`, sigSecPath,
        '--repo', 'SawyerHan-AI/TideMind', '--clobber',
      ], { cwd: ossRepo, label: `upload secondary signature ${platform}/${arch}` });
    }
  }
}

function verifyRelease(version, ossRepo) {
  const release = parseJsonOutput('gh', [
    'release',
    'view',
    `v${version}`,
    '--repo',
    'SawyerHan-AI/TideMind',
    '--json',
    'tagName,isDraft,isPrerelease,url,assets',
  ], ossRepo);
  const assetNames = release.assets.map(asset => asset.name);
  for (const name of [
    `Tide.Mind-${version}-arm64.dmg`,
    `Tide.Mind-${version}-x64.dmg`,
    'latest-mac.yml',
  ]) {
    if (!assetNames.includes(name)) throw new Error(`release missing asset ${name}`);
  }
  if (release.isDraft) throw new Error(`release v${version} is still draft`);
  console.log(`✓ release published: ${release.url}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }
  const rootPkg = readJson(path.join(repoRoot, 'package.json'));
  const version = opts.version ?? rootPkg.version;
  const previousVersion = opts.previousVersion ?? previousPatch(version);
  if (!previousVersion && !opts.skipUpdateVerify) {
    throw new Error('Could not infer --previous-version from --version; pass it explicitly');
  }
  const tagName = `v${version}`;
  const notesFile = ensureNotesFile(version, opts.notesFile);
  const ossMessage = opts.ossMessage ?? `sync ${version}: release maintenance updates`;

  console.log(`TideMind release ${tagName}`);
  console.log(`OSS repo: ${opts.ossRepo}`);
  console.log(`Notes: ${notesFile}`);
  if (opts.dryRun) console.log('DRY RUN: no mutating command will be executed.');

  if (!fs.existsSync(path.join(opts.ossRepo, '.git'))) {
    throw new Error(`OSS repo not found or not a git repo: ${opts.ossRepo}`);
  }
  if (opts.allowNonMain) {
    console.log('\n> Skipping main-branch checks (--allow-non-main)');
  } else {
    assertMainBranch(repoRoot, 'ExternaBrain');
    assertMainBranch(opts.ossRepo, 'TideMind OSS');
  }
  assertCleanRepo(repoRoot, 'ExternaBrain', opts.dryRun);
  assertCleanRepo(opts.ossRepo, 'TideMind OSS', opts.dryRun);

  run('node', ['scripts/check-version-sync.mjs'], { label: 'check version sync', dryRun: opts.dryRun });
  // 2026-05-21 v0.2.71 audit A-HIGH-1/2:helper entitlement 防回归。
  // 在 push 之前拦截"main plist inherit 给 helper → SIGKILL"事故。
  // health-check 也会再跑一次,这里 fail-fast 早于 push。
  run('node', ['scripts/check-mac-packaging.mjs'], { label: 'check mac packaging', dryRun: opts.dryRun });
  run('git', ['diff', '--check'], { label: 'git diff --check', dryRun: opts.dryRun });
  if (!opts.skipHealth) {
    run('npm', ['run', 'health'], { label: 'npm run health', dryRun: opts.dryRun });
  }

  run('git', ['push', 'origin', 'main'], { label: 'push ExternaBrain main', dryRun: opts.dryRun });

  if (!opts.skipWebsite) {
    run('npx', ['astro', 'build'], {
      cwd: path.join(repoRoot, 'pro/website'),
      label: 'website build',
      dryRun: opts.dryRun,
    });
    // 显式传 --commit-message / --commit-hash,绕开 wrangler 默认从 git
    // 自动取 commit message 的路径。CF Pages deployment API 的 commit_message
    // 字段有长度上限(实测 ~1KB),超长会返回误导性的
    // "Invalid commit message, it must be a valid UTF-8 string [code: 8000111]",
    // 实际是长度问题不是编码问题。我们的发版 commit 走中文 + 多段正文很
    // 容易超限,直接固定成短文本最稳。SHA 还是真实的 HEAD,溯源不丢。
    const sha = opts.dryRun
      ? 'DRY-RUN-SHA'
      : capture('git', ['rev-parse', 'HEAD'], repoRoot).stdout;
    run('npx', [
      'wrangler', 'pages', 'deploy', 'dist/',
      '--project-name', 'tidemind-website',
      '--branch=main',
      '--commit-message', `release v${version}`,
      '--commit-hash', sha,
    ], {
      cwd: path.join(repoRoot, 'pro/website'),
      label: 'deploy website',
      dryRun: opts.dryRun,
    });
  }

  run('./sync-oss.sh', [opts.ossRepo, ...(opts.yes ? ['--yes'] : [])], {
    label: 'sync OSS repo',
    dryRun: opts.dryRun,
  });
  const ossDirty = !opts.dryRun && capture('git', ['status', '--porcelain'], opts.ossRepo).stdout;
  if (ossDirty) {
    run('git', ['add', '-A'], { cwd: opts.ossRepo, label: 'stage OSS changes', dryRun: opts.dryRun });
    run('git', ['commit', '-m', ossMessage], { cwd: opts.ossRepo, label: 'commit OSS changes', dryRun: opts.dryRun });
  } else {
    console.log('\n> OSS repo has no changes to commit');
  }
  run('git', ['push', 'origin', 'main'], { cwd: opts.ossRepo, label: 'push OSS main', dryRun: opts.dryRun });

  const tagAction = opts.dryRun ? 'create' : assertTagState(version, opts.ossRepo, opts.forceTag);
  if (tagAction === 'move') {
    run('git', ['tag', '-f', tagName], { cwd: opts.ossRepo, label: `move ${tagName}`, dryRun: opts.dryRun });
    run('git', ['push', 'origin', `:refs/tags/${tagName}`], { cwd: opts.ossRepo, label: `delete remote ${tagName}`, dryRun: opts.dryRun });
  } else if (tagAction === 'create') {
    run('git', ['tag', tagName], { cwd: opts.ossRepo, label: `create ${tagName}`, dryRun: opts.dryRun });
  } else {
    console.log(`\n> ${tagName} already points at OSS HEAD`);
  }
  run('git', ['push', 'origin', tagName], { cwd: opts.ossRepo, label: `push ${tagName}`, dryRun: opts.dryRun });

  if (!opts.dryRun) {
    const runId = await getReleaseRunId(version, opts.ossRepo, opts.timeoutMinutes * 60_000);
    run('gh', ['run', 'watch', runId, '--repo', 'SawyerHan-AI/TideMind', '--exit-status'], {
      cwd: opts.ossRepo,
      label: `wait release workflow ${runId}`,
      timeoutMs: opts.timeoutMinutes * 60_000,
    });
    run('gh', ['release', 'edit', tagName, '--repo', 'SawyerHan-AI/TideMind', '--notes-file', notesFile, '--draft=false', '--latest'], {
      cwd: opts.ossRepo,
      label: 'publish GitHub release',
    });
    // 离线签名:对每个 (platform, arch) 的 DMG 算 sha512,签名 "${version}\n${dmgUrl}",
    // 把签名作为额外 asset 上传到 release。SIGNING_PRIVATE_KEY env 未设时跳过(向后兼容)。
    signReleaseAssets(version, opts.ossRepo, opts.allowUnsigned);
    verifyRelease(version, opts.ossRepo);
    if (!opts.skipCloudVerify) await verifyCloud(version);
    if (!opts.skipUpdateVerify) await verifyUpdateApi(version, previousVersion);
  }

  console.log(`\nRelease ${tagName} completed.`);
}

const isCli = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isCli) {
  main().catch(err => {
    console.error(`\nRelease failed: ${err.message}`);
    process.exit(1);
  });
}
