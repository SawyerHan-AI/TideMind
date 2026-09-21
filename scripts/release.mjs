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
    agentHostEvidence: null,
    agentHostCandidateApp: null,
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
      case '--agent-host-evidence': opts.agentHostEvidence = path.resolve(next()); break;
      case '--agent-host-candidate-app-arm64': opts.agentHostCandidateAppArm64 = path.resolve(next()); break;
      case '--agent-host-candidate-app-x64': opts.agentHostCandidateAppX64 = path.resolve(next()); break;
      case '--timeout-minutes': opts.timeoutMinutes = Number(next()); break;
      case '--yes':
      case '-y':
        opts.yes = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--prepare-candidate': opts.prepareCandidate = true; break;
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

export function assertRequestedVersion(requestedVersion, packageVersion) {
  if (requestedVersion !== null && requestedVersion !== packageVersion) {
    throw new Error(
      `--version ${requestedVersion} does not match package.json version ${packageVersion}`,
    );
  }
}

const V0_2_92_FORBIDDEN_BYPASSES = [
  ['forceTag', '--force-tag'],
  ['skipHealth', '--skip-health'],
  ['skipWebsite', '--skip-website'],
  ['skipCloudVerify', '--skip-cloud-verify'],
  ['skipUpdateVerify', '--skip-update-verify'],
];

export function assertReleaseBypassesAllowed(version, opts) {
  if (opts.allowNonMain && !opts.dryRun) {
    throw new Error('--allow-non-main requires --dry-run');
  }
  if (version !== '0.2.92') return;
  const requested = V0_2_92_FORBIDDEN_BYPASSES
    .filter(([key]) => opts[key])
    .map(([, flag]) => flag);
  if (requested.length > 0) {
    throw new Error(`0.2.92 cannot be released with ${requested.join(', ')}`);
  }
}

export function resolveUpdatePreviousVersions(version, requestedVersion = null) {
  if (version === '0.2.92') {
    const required = ['0.2.89', '0.2.91'];
    if (requestedVersion !== null && !required.includes(requestedVersion)) {
      throw new Error(
        '--previous-version for 0.2.92 must be 0.2.89 or 0.2.91; both are always verified',
      );
    }
    return required;
  }
  const previousVersion = requestedVersion ?? previousPatch(version);
  return previousVersion ? [previousVersion] : [];
}

function printHelp() {
  console.log(`Usage: npm run release -- --version X.Y.Z --previous-version A.B.C --yes

Options:
  --version X.Y.Z          Version to release. Defaults to root package.json.
  --previous-version X.Y.Z Version used to verify update API. Defaults to previous patch;
                           0.2.92 always verifies both 0.2.89 and 0.2.91.
  --oss-repo PATH          OSS repo path. Defaults to ../tidemind or TIDEMIND_OSS_REPO.
  --oss-message TEXT       Public OSS commit message.
  --notes-file PATH        Release notes markdown. Required for 0.2.92; older versions
                           default to /tmp/notes-vX.Y.Z.md.
  --agent-host-evidence PATH
                           Real-host Agent acceptance index. Required for a real release;
                           may also be set with TIDEMIND_AGENT_HOST_ACCEPTANCE_INDEX.
  --agent-host-candidate-app-arm64 PATH
  --agent-host-candidate-app-x64 PATH
                           Exact signed RC apps for each supported release architecture (0.2.92: arm64);
                           physical bytes, executable architecture and identity are re-verified.
  --timeout-minutes N      Release workflow wait timeout. Defaults to 20.
  --yes, -y                Pass --yes to sync-oss.sh.
  --force-tag              Move an existing OSS tag to HEAD after confirmation-by-flag.
  --allow-non-main         CI dry-run escape hatch for detached checkouts.
  --dry-run                Print commands without mutating repositories or deployments.
  --prepare-candidate      Sync verified main and build a signed candidate using existing
                           public-repository credentials; no tag or release is published.
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

export function releaseMacArchitectures(version) {
  const requirements = readJson(path.join(repoRoot, 'scripts/agent-integration-host-acceptance-requirements.json'));
  if (version !== requirements.appVersion) return ['arm64', 'x64'];
  const architectures = requirements.releaseMacArchitectures;
  if (!Array.isArray(architectures) || architectures.length === 0
    || new Set(architectures).size !== architectures.length
    || architectures.some(arch => !['arm64', 'x64'].includes(arch))) {
    throw new Error('invalid releaseMacArchitectures in acceptance requirements');
  }
  return architectures;
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

export function assertExactSnapshot(expectedHead, actualHead, status, label) {
  if (actualHead !== expectedHead) {
    throw new Error(`${label} HEAD changed during release: expected ${expectedHead}, got ${actualHead}`);
  }
  if (status) {
    throw new Error(`${label} became dirty during release:\n${status}`);
  }
}

function assertRepoSnapshot(cwd, label, expectedHead) {
  assertExactSnapshot(
    expectedHead,
    capture('git', ['rev-parse', 'HEAD'], cwd).stdout,
    capture('git', ['status', '--porcelain'], cwd).stdout,
    label,
  );
}

function assertRemoteMainAt(cwd, expectedHead) {
  const output = capture('git', ['ls-remote', '--heads', 'origin', 'refs/heads/main'], cwd).stdout;
  const actualHead = output.split(/\s+/)[0] ?? '';
  if (actualHead !== expectedHead) {
    throw new Error(`origin/main drifted during release: expected ${expectedHead}, got ${actualHead || '(missing)'}`);
  }
}

export function previousPatch(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  const patch = Number(match[3]);
  if (patch <= 0) return null;
  return `${match[1]}.${match[2]}.${patch - 1}`;
}

const RELEASE_0_2_92_AGENT_DISCLOSURES = Object.freeze([
  ['Claude Code', /Claude Code/iu],
  ['Claude Cowork', /Claude Cowork/iu],
  ['Codex', /\bCodex\b/iu],
  ['Cursor', /\bCursor\b/iu],
  ['Devin Desktop', /Devin Desktop/iu],
  ['Gemini CLI', /Gemini CLI/iu],
  ['Kimi Code', /Kimi Code/iu],
  ['OpenClaw', /OpenClaw/iu],
  ['Qwen Code', /Qwen Code/iu],
  ['ZCode', /\bZCode\b/iu],
  ['OpenCode', /\bOpenCode\b/iu],
  ['Pi', /(?:^|[^A-Za-z])Pi(?:[^A-Za-z]|$)/iu],
  ['Oh My Pi / OMP', /Oh My Pi|\bOMP\b/iu],
  ['QwenWork', /QwenWork/iu],
]);

export function validateReleaseNotesContent(version, content) {
  if (version !== '0.2.92') return;
  if (/supports? (?:all )?(?:major|mainstream) agents?|支持(?:全部|所有|主流)\s*Agent/iu.test(content)) {
    throw new Error('0.2.92 release notes use a vague Agent support claim');
  }
  if (!content.includes(version)) throw new Error(`0.2.92 release notes do not name version ${version}`);
  const level = /完整接入|基础接入|部分接入|未接入|complete integration|full integration|basic integration|partial integration|not integrated/iu;
  const lines = content.split(/\r?\n/u);
  for (const [name, matcher] of RELEASE_0_2_92_AGENT_DISCLOSURES) {
    const disclosed = lines.some(line => matcher.test(line)
      && level.test(line)
      && !(name === 'Pi' && /Oh My Pi|\bOMP\b/iu.test(line)));
    if (!disclosed) {
      throw new Error(`0.2.92 release notes must disclose the actual connection level for ${name}`);
    }
  }
  if (!/自定义本机\s*Agent|Custom local Agent/iu.test(content)) {
    throw new Error('0.2.92 release notes must disclose Custom local Agent support');
  }
  if (!/非标准配置根|non-?standard config(?:uration)? root/iu.test(content)
    || !/手动\s*MCP|manual MCP/iu.test(content)) {
    throw new Error('0.2.92 release notes must disclose both Custom local Agent boundaries');
  }
  if (!/限制|局限|能力边界|host limitations?|limitations?/iu.test(content)) {
    throw new Error('0.2.92 release notes must include host limitations or capability boundaries');
  }
}

export function ensureNotesFile(version, explicitPath, allowTemplate = false) {
  if (version === '0.2.92' && !explicitPath && !allowTemplate) {
    throw new Error('0.2.92 requires an explicit --notes-file with per-Agent connection levels and limitations');
  }
  const file = explicitPath ?? path.join(os.tmpdir(), `notes-v${version}.md`);
  if (!fs.existsSync(file)) {
    if (explicitPath) throw new Error(`release notes file does not exist: ${file}`);
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
  if (!(version === '0.2.92' && allowTemplate && !explicitPath)) {
    validateReleaseNotesContent(version, fs.readFileSync(file, 'utf8'));
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
    'databaseId,headBranch,headSha,event,status,createdAt,displayTitle',
  ], ossRepo);
}

function listPrivateCiRuns() {
  return parseJsonOutput('gh', [
    'run',
    'list',
    '--workflow',
    'CI',
    '--branch',
    'main',
    '--limit',
    '30',
    '--json',
    'databaseId,headBranch,headSha,event,status,conclusion,createdAt,displayTitle',
  ], repoRoot);
}

export function findPrivateCiRunId(runs, expectedHeadSha) {
  const match = runs.find(run => run.headBranch === 'main'
    && run.headSha === expectedHeadSha
    && run.event === 'push');
  return match ? String(match.databaseId) : null;
}

export function findReleaseRunId(runs, tag, expectedHeadSha, minCreatedAtMs = 0) {
  const tagName = tag.startsWith('v') ? tag : `v${tag}`;
  // 只接受 createdAt 晚于本次 push 的 run。否则 --force-tag(移动已有 tag 重发)
  // 场景下,`gh run list` 里仍有上一次该 tag 的已完成 run,headBranch 同名 → 第一次
  // 轮询(GitHub 尚未 materialize 新 run 的几秒窗口)就误命中旧 run → `gh run watch`
  // 立即返回 → 后续 publish/sign/verify 全部对着旧构建产物执行,新构建却无人监控。
  // minCreatedAtMs=0(默认/测试)时退化为只按 headBranch 匹配,保持向后兼容。
  const match = runs.find(run => {
    if (run.headBranch !== tagName && run.headBranch !== tag) return false;
    if (run.headSha !== expectedHeadSha || run.event !== 'push') return false;
    if (minCreatedAtMs > 0 && run.createdAt) {
      const created = Date.parse(run.createdAt);
      if (Number.isFinite(created) && created < minCreatedAtMs) return false;
    }
    return true;
  });
  return match ? String(match.databaseId) : null;
}

export function findPackagePreflightRunId(runs, expectedHeadSha, minCreatedAtMs, expectedTitle) {
  if (typeof expectedTitle !== 'string' || !/^(Candidate|Preflight) [0-9a-f-]{36}$/u.test(expectedTitle)) {
    throw new Error('package preflight requires a mode and unique request ID');
  }
  const match = runs.find(run => {
    if (run.headBranch !== 'main' || run.event !== 'workflow_dispatch') return false;
    if (run.headSha !== expectedHeadSha) return false;
    if (run.displayTitle !== expectedTitle) return false;
    if (minCreatedAtMs > 0 && run.createdAt) {
      const created = Date.parse(run.createdAt);
      if (Number.isFinite(created) && created < minCreatedAtMs) return false;
    }
    return true;
  });
  return match ? String(match.databaseId) : null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getReleaseRunId(tag, ossRepo, timeoutMs, expectedHeadSha, minCreatedAtMs = 0) {
  const tagName = tag.startsWith('v') ? tag : `v${tag}`;
  const started = Date.now();
  const deadline = started + timeoutMs;
  const pollMs = 5_000;
  let attempts = 0;
  let lastRunSummary = '';

  while (Date.now() <= deadline) {
    attempts++;
    const runs = listReleaseRuns(ossRepo);
    const runId = findReleaseRunId(runs, tag, expectedHeadSha, minCreatedAtMs);
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

async function getPackagePreflightRunId(ossRepo, timeoutMs, expectedHeadSha, minCreatedAtMs, expectedTitle) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const runId = findPackagePreflightRunId(listReleaseRuns(ossRepo), expectedHeadSha, minCreatedAtMs, expectedTitle);
    if (runId) return runId;
    console.log('> Waiting for the macOS package preflight run');
    await sleep(Math.min(5_000, Math.max(0, deadline - Date.now())));
  }
  throw new Error('Could not find the macOS package preflight run');
}

async function getPrivateCiRunId(expectedHeadSha, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const runId = findPrivateCiRunId(listPrivateCiRuns(), expectedHeadSha);
    if (runId) return runId;
    console.log(`> Waiting for private CI at ${expectedHeadSha}`);
    await sleep(Math.min(5_000, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`Could not find private CI for exact source commit ${expectedHeadSha}`);
}

function assertOssMainStillAt(expectedHead, ossRepo) {
  const localHead = capture('git', ['rev-parse', 'HEAD'], ossRepo).stdout;
  if (localHead !== expectedHead) {
    throw new Error(`OSS local HEAD drifted during release preflight: expected ${expectedHead}, got ${localHead}`);
  }
  const remoteLine = capture('git', ['ls-remote', '--heads', 'origin', 'main'], ossRepo).stdout;
  const remoteHead = remoteLine.split(/\s+/)[0] ?? '';
  if (remoteHead !== expectedHead) {
    throw new Error(`OSS origin/main drifted during release preflight: expected ${expectedHead}, got ${remoteHead || 'missing'}`);
  }
}

function assertOssSourceBinding(expectedSourceCommit, ossRepo) {
  const trailer = capture('git', [
    'log', '-1', '--format=%(trailers:key=TideMind-Source-Commit,valueonly)',
  ], ossRepo).stdout;
  if (trailer !== expectedSourceCommit) {
    throw new Error(`OSS release commit source binding mismatch: expected ${expectedSourceCommit}, got ${trailer || 'missing'}`);
  }
}

export function classifyReleaseTagPreflight({
  localTagHead,
  remoteTagHead,
  ossHead,
  sourceCommitTrailer,
  expectedSourceCommit,
  forceTag,
}) {
  if (forceTag) return 'move';
  const existingHeads = [localTagHead, remoteTagHead].filter(Boolean);
  if (existingHeads.length === 0) return 'create';
  if (existingHeads.some(head => head !== ossHead)) {
    throw new Error('release tag already exists at a different OSS commit');
  }
  if (sourceCommitTrailer !== expectedSourceCommit) {
    throw new Error('existing release tag is not bound to the exact TideMind source commit');
  }
  return 'already-at-head';
}

function assertReleaseTagPreflight(version, expectedSourceCommit, ossRepo, forceTag) {
  const tagName = `v${version}`;
  const local = capture('git', [
    'rev-parse', '--verify', '--quiet', `refs/tags/${tagName}`,
  ], ossRepo, true);
  const remoteOutput = capture('git', [
    'ls-remote', '--tags', 'origin', `refs/tags/${tagName}`,
  ], ossRepo).stdout;
  const ossHead = capture('git', ['rev-parse', 'HEAD'], ossRepo).stdout;
  const sourceCommitTrailer = capture('git', [
    'log', '-1', '--format=%(trailers:key=TideMind-Source-Commit,valueonly)',
  ], ossRepo).stdout;
  return classifyReleaseTagPreflight({
    localTagHead: local.status === 0 ? local.stdout : '',
    remoteTagHead: remoteOutput.split(/\s+/u)[0] ?? '',
    ossHead,
    sourceCommitTrailer,
    expectedSourceCommit,
    forceTag,
  });
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

async function fetchText(url) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) throw new Error(`${url} returned ${resp.status}`);
  return await resp.text();
}

async function verifyCloud(version) {
  const health = await fetchJson('https://cloud.tidemind.ai/health');
  if (health.version !== version) {
    throw new Error(`cloud health version ${health.version} !== ${version}`);
  }
  console.log(`✓ cloud health reports ${version}`);
}

function decodeEd25519Signature(value, label) {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(normalized) || normalized.length % 4 !== 0) {
    throw new Error(`${label} is not canonical base64`);
  }
  const signature = Buffer.from(normalized, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== normalized) {
    throw new Error(`${label} is not a 64-byte Ed25519 signature`);
  }
  return signature;
}

export async function verifyUpdateApi(
  version,
  previousVersions,
  allowUnsigned = false,
  embeddedKeys = readEmbeddedUpdatePublicKeys(),
  convergence = {},
) {
  const base = 'https://cloud.tidemind.ai/api/v1/update/latest';
  const versionsToVerify = Array.isArray(previousVersions) ? previousVersions : [previousVersions];
  // The cloud endpoint intentionally caches the previous GitHub release for
  // five minutes. Only a well-formed older release is a retryable state.
  const timeoutMs = convergence.timeoutMs ?? 360_000;
  const intervalMs = convergence.intervalMs ?? 10_000;
  const now = convergence.now ?? Date.now;
  const wait = convergence.wait ?? sleep;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error('invalid update convergence timeout or interval');
  }
  const deadline = now() + timeoutMs;
  async function offeredRelease(url, arch) {
    for (;;) {
      const body = await fetchJson(url);
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || !/^\d+\.\d+\.\d+$/u.test(body.version ?? '')
        || !(body.url === null || typeof body.url === 'string')) {
        throw new Error('update API returned a malformed release response');
      }
      const parts = body.version.split('.').map(Number);
      const expected = version.split('.').map(Number);
      const comparison = parts.reduce((result, part, index) => result || Math.sign(part - expected[index]), 0);
      if (comparison >= 0) return body;
      const oldDmg = `https://github.com/SawyerHan-AI/TideMind/releases/download/v${body.version}/Tide.Mind-${body.version}-${arch}.dmg`;
      const oldSig = `https://github.com/SawyerHan-AI/TideMind/releases/download/v${body.version}/update-manifest-darwin-${arch}.sig`;
      if ((body.url !== null && body.url !== oldDmg)
        || (!allowUnsigned && body.url !== null && body.signatureUrl !== oldSig)) {
        throw new Error('update API returned malformed cached release URLs');
      }
      if (!allowUnsigned && body.url !== null) {
        const signature = decodeEd25519Signature(await fetchText(oldSig), 'cached release signature');
        const keys = [embeddedKeys.primary, embeddedKeys.secondary].filter(Boolean);
        if (!keys.some(key => crypto.verify(null, Buffer.from(`${body.version}\n${oldDmg}`), crypto.createPublicKey(key), signature))) {
          throw new Error('cached release signature does not verify with a public key embedded in the client');
        }
      }
      if (now() >= deadline) throw new Error(`update API cache did not converge to ${version} within ${timeoutMs}ms`);
      console.log(`> Waiting for update API cache to advance from ${body.version} to ${version}`);
      await wait(Math.min(intervalMs, deadline - now()));
    }
  }
  // 每个发布支持的架构都验证。未发布架构另行验证保持旧版本的无更新契约。
  // 每个 arch 断言 version / url / signatureUrl 三项,signatureUrl 必须非空且指向
  // update-manifest-darwin-{arch}.sig —— 这正是 v0.2.66 同类"已 publish 但无签名 /
  // 命名漂移 → 客户端拒更"故障的最后一道自动防线(CLAUDE.md 防坑规则 9)。
  for (const arch of releaseMacArchitectures(version)) {
    const expectedDmgUrl = `https://github.com/SawyerHan-AI/TideMind/releases/download/v${version}/Tide.Mind-${version}-${arch}.dmg`;
    for (const previousVersion of versionsToVerify) {
      const prev = await offeredRelease(`${base}?platform=darwin&arch=${arch}&version=${previousVersion}`, arch);
      if (prev.version !== version || prev.url !== expectedDmgUrl) {
        throw new Error(`update API did not offer ${version}/${arch} to ${previousVersion}: ${JSON.stringify(prev)}`);
      }
      if (!allowUnsigned) {
        const expectedSig = `update-manifest-darwin-${arch}.sig`;
        const expectedSigUrl = `https://github.com/SawyerHan-AI/TideMind/releases/download/v${version}/${expectedSig}`;
        if (!prev.signatureUrl) {
          throw new Error(
            `update API returned no signatureUrl for ${version}/${arch} — clients with ` +
            `embedded public key will REJECT this release (sign-before-publish window or ` +
            `asset naming drift). Response: ${JSON.stringify(prev)}`,
          );
        }
        if (prev.signatureUrl !== expectedSigUrl) {
          throw new Error(
            `update API signatureUrl for ${version}/${arch} does not point at ${expectedSig}: ${prev.signatureUrl}`,
          );
        }
        const signature = decodeEd25519Signature(
          await fetchText(prev.signatureUrl),
          `${version}/${arch} downloaded signature`,
        );
        const message = Buffer.from(`${version}\n${expectedDmgUrl}`, 'utf8');
        const candidateKeys = [embeddedKeys.primary, embeddedKeys.secondary].filter(Boolean);
        if (!candidateKeys.some(publicKeyPem => crypto.verify(
          null,
          message,
          crypto.createPublicKey(publicKeyPem),
          signature,
        ))) {
          throw new Error(`${version}/${arch} downloaded signature does not verify with a public key embedded in the client`);
        }
      }
    }

    const current = await fetchJson(`${base}?platform=darwin&arch=${arch}&version=${version}`);
    if (current.url !== null) {
      throw new Error(`update API should return url:null for current version (${arch}): ${JSON.stringify(current)}`);
    }
  }
  for (const arch of ['arm64', 'x64'].filter(arch => !releaseMacArchitectures(version).includes(arch))) {
    for (const previousVersion of versionsToVerify) {
      const body = await fetchJson(`${base}?platform=darwin&arch=${arch}&version=${previousVersion}`);
      if (body.version !== previousVersion || body.url !== null) {
        throw new Error(`unsupported ${arch} must retain ${previousVersion} without an update: ${JSON.stringify(body)}`);
      }
    }
  }
  console.log(
    `✓ update API offers ${version} to ${versionsToVerify.join(' and ')} (${releaseMacArchitectures(version).join(' + ')}` +
    `${allowUnsigned ? '' : ', downloaded signatures verified'}) and no update to ${version}`,
  );
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
  // 2026-05-21 audit F7:Keychain 失败的三种情况要区分日志,旧实现全 silent 吞,
  // 让运维分不清"没装 security / Keychain 拒绝 / 项找到了但内容不是 PEM"。
  let r;
  try {
    r = spawnSync('security', [
      'find-generic-password',
      '-a', 'tidemind',
      '-s', 'tidemind-signing-key',
      '-w',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    // security 命令本身不可用(ENOENT 等)→ silent fall through,这是非 macOS
    // 但 platform 检测出错的极端场景,正常 macOS 不会触发。
    if (err && err.code === 'ENOENT') return { pem: null, source: null };
    console.warn(`keychain lookup spawn failed: ${err && err.message ? err.message : String(err)}`);
    return { pem: null, source: null };
  }
  if (r.status === 0 && r.stdout && r.stdout.includes('-----BEGIN')) {
    return { pem: normalizePEM(r.stdout), source: 'keychain' };
  }
  if (r.status !== 0) {
    const stderr = (r.stderr || '').trim();
    if (stderr) {
      // Keychain 拒绝 / item 找不到 / 用户取消 — 让运维看见原因。
      console.warn(`keychain rejected: ${stderr}`);
    }
  } else if (r.stdout && !r.stdout.includes('-----BEGIN')) {
    // status=0 但内容不是 PEM:item 找到了但写错了内容(比如塞了 fingerprint
    // 或 base64 而忘了 BEGIN/END 包络),容易让人以为"key 已配置"实际不能用。
    console.warn('keychain item found but value is not a PEM private key (missing BEGIN header)');
  }
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
  // 2026-05-21 audit F7:secondary key 通常不存在(只在轮换期配置),非 0 退出
  // 是常态。这里只在 stderr 显式说"找到了但不是 PEM"的异常路径才 warn,
  // "item 不存在"保持 silent。
  let r;
  try {
    r = spawnSync('security', [
      'find-generic-password',
      '-a', 'tidemind',
      '-s', 'tidemind-signing-key-secondary',
      '-w',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if (err && err.code === 'ENOENT') return { pem: null, source: null };
    console.warn(`keychain secondary lookup spawn failed: ${err && err.message ? err.message : String(err)}`);
    return { pem: null, source: null };
  }
  if (r.status === 0 && r.stdout && r.stdout.includes('-----BEGIN')) {
    return { pem: normalizePEM(r.stdout), source: 'keychain' };
  }
  if (r.status === 0 && r.stdout && !r.stdout.includes('-----BEGIN')) {
    console.warn('keychain secondary item found but value is not a PEM private key');
  }
  // status != 0 → secondary 通常未配置,不打扰 ops。
  return { pem: null, source: null };
}

function decodeSourceStringLiteral(value, label) {
  if (value.startsWith('`')) return value.slice(1, -1);
  if (value.startsWith("'")) {
    try {
      return JSON.parse(`"${value.slice(1, -1).replaceAll('"', '\\"')}"`);
    } catch (error) {
      throw new Error(`cannot decode ${label}: ${error.message}`);
    }
  }
  return JSON.parse(value);
}

/** Read the literal public keys shipped to clients, never environment overrides. */
export function extractEmbeddedUpdatePublicKeys(source) {
  const primaryMatch = source.match(
    /const UPDATE_PUBLIC_KEY_PEM\s*=\s*process\.env\.TIDEMIND_UPDATE_PUBLIC_KEY\s*\|\|\s*(`[^`]*`|"(?:\\.|[^"])*"|'(?:\\.|[^'])*')/u,
  );
  const secondaryMatch = source.match(
    /const UPDATE_PUBLIC_KEY_PEM_SECONDARY\s*=\s*process\.env\.TIDEMIND_UPDATE_PUBLIC_KEY_SECONDARY\s*\?\?\s*(`[^`]*`|"(?:\\.|[^"])*"|'(?:\\.|[^'])*')/u,
  );
  if (!primaryMatch) throw new Error('cannot find embedded primary update public key');
  if (!secondaryMatch) throw new Error('cannot find embedded secondary update public key');
  const primary = decodeSourceStringLiteral(primaryMatch[1], 'embedded primary update public key').trim();
  const secondary = decodeSourceStringLiteral(secondaryMatch[1], 'embedded secondary update public key').trim();
  if (!primary) throw new Error('embedded primary update public key is empty');
  return Object.freeze({ primary, secondary });
}

function readEmbeddedUpdatePublicKeys() {
  return extractEmbeddedUpdatePublicKeys(fs.readFileSync(
    path.join(repoRoot, 'client/electron/ipc/app.ts'),
    'utf8',
  ));
}

export function assertSigningKeyMatchesEmbeddedPublicKey(privateKeyInput, publicKeyPem, label = 'primary') {
  const privateKey = privateKeyInput?.type === 'private'
    ? privateKeyInput
    : crypto.createPrivateKey(privateKeyInput);
  const publicKey = crypto.createPublicKey(publicKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519' || publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(`${label} update signing key must be Ed25519`);
  }
  const derived = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const embedded = publicKey.export({ type: 'spki', format: 'der' });
  if (derived.length !== embedded.length || !crypto.timingSafeEqual(derived, embedded)) {
    throw new Error(`${label} release signing private key does not match the public key embedded in the client`);
  }
}

/**
 * 在第一次远端写入之前 fail-fast 解析并核对签名私钥。
 *
 * Why 提前:
 *   1. 私钥缺失/损坏要在 **push tag 之前** 报错,而不是等 GitHub release 已 publish
 *      之后才在 signReleaseAssets 里炸 —— 那时已经存在"已发布但无签名"的窗口。
 *   2. macOS Keychain 首次访问会弹 Touch ID / Master Password(见 loadSigningPrivateKey
 *      注释),把这个交互提前到运维一定在场的发版起点,而不是发版尾声(可能已离开)。
 *
 * 返回 { privateKey, secondaryKey, source } —— privateKey 为 null 表示无签名
 * (仅当 allowUnsigned 时允许走到这里;否则本函数已抛错)。createPrivateKey 在这里
 * 完成,因此 PEM 损坏也在 push tag 之前暴露。
 */
function loadSigningKeys(allowUnsigned = false) {
  const embeddedKeys = readEmbeddedUpdatePublicKeys();
  const { pem: privateKeyPem, source } = loadSigningPrivateKey();
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
    return { privateKey: null, secondaryKey: null, source: null };
  }

  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(privateKeyPem);
  } catch (err) {
    throw new Error(`SIGNING_PRIVATE_KEY parse failed: ${err.message}`);
  }
  assertSigningKeyMatchesEmbeddedPublicKey(privateKey, embeddedKeys.primary, 'primary');
  console.log(`\n> Signing key loaded (ed25519, key from ${source}) — matched to client before remote writes`);

  // Secondary key:轮换期间用第二个私钥同时签 .sig.secondary。不配置则跳过。
  const { pem: secondaryPem, source: secondarySource } = loadSecondarySigningPrivateKey();
  let secondaryKey = null;
  if (secondaryPem) {
    if (!embeddedKeys.secondary) {
      throw new Error('secondary release signing key is configured but the client embeds no secondary public key');
    }
    try {
      secondaryKey = crypto.createPrivateKey(secondaryPem);
      assertSigningKeyMatchesEmbeddedPublicKey(secondaryKey, embeddedKeys.secondary, 'secondary');
      console.log(`  Secondary key loaded from ${secondarySource} — will dual-sign for rotation`);
    } catch (err) {
      // secondary 解析失败 → fail-loud,因为如果运维主动给了备用 key,默默 skip 会让
      // 轮换过程的发版静默退化为单 key 签,达不到双 key 平滑切换的目的。
      throw new Error(`SIGNING_PRIVATE_KEY_SECONDARY parse failed: ${err.message}`);
    }
  }
  return { privateKey, secondaryKey, source };
}

function signReleaseAssets(version, ossRepo, keys) {
  const { privateKey, secondaryKey } = keys;
  if (!privateKey) {
    // allowUnsigned 路径:loadSigningKeys 已打印 warning,这里什么都不做。
    return;
  }
  console.log(`\n> Signing release manifests (ed25519)`);
  const release = parseJsonOutput('gh', [
    'release', 'view', `v${version}`, '--repo', 'SawyerHan-AI/TideMind',
    '--json', 'assets',
  ], ossRepo);
  // 客户端期望的 (platform, arch) 对应 DMG/zip 命名。
  const targets = releaseMacArchitectures(version).map(arch => ({
    platform: 'darwin', arch, assetName: `Tide.Mind-${version}-${arch}.dmg`,
  }));

  for (const { platform, arch, assetName } of targets) {
    const asset = release.assets.find(a => a.name === assetName);
    if (!asset) {
      // fail-loud:签名现在发生在 publish 之前,是供应链防线的一部分。如果某个
      // (platform, arch) 的 DMG 没找到,silent skip 会让该架构永远没有 .sig,
      // 客户端验签 invalid 拒绝更新 —— 正是 v0.2.66 事故类。verifyUpdateApi
      // 也会兜底,但这里提前在签名阶段炸,定位更直接。
      throw new Error(
        `signing: release is missing exact DMG asset ${assetName}; ` +
        `release assets: ${release.assets.map(a => a.name).join(', ') || '(none)'}`,
      );
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
    try {
      run('gh', [
        'release', 'upload', `v${version}`, sigPath,
        '--repo', 'SawyerHan-AI/TideMind', '--clobber',
      ], { cwd: ossRepo, label: `upload signature ${platform}/${arch}` });
    } finally {
      // 2026-05-21 audit F6:tmp 签名文件不要留在 /tmp。
      // 内容是 ed25519 签名(public information 一旦发布,但发布前在 tmp 仍可被
      // 同机器其他进程读到 → 攻击者可推断未来 release 时间表)。upload 成功
      // 与否都清。删除失败不影响发版流程(空磁盘 / 权限错都吞掉)。
      try { fs.unlinkSync(sigPath); } catch { /* ignore */ }
    }

    if (secondaryKey) {
      const sigSec = crypto.sign(null, message, secondaryKey).toString('base64');
      const sigSecPath = path.join(os.tmpdir(), `update-manifest-${platform}-${arch}.sig.secondary`);
      fs.writeFileSync(sigSecPath, sigSec);
      try {
        run('gh', [
          'release', 'upload', `v${version}`, sigSecPath,
          '--repo', 'SawyerHan-AI/TideMind', '--clobber',
        ], { cwd: ossRepo, label: `upload secondary signature ${platform}/${arch}` });
      } finally {
        try { fs.unlinkSync(sigSecPath); } catch { /* ignore */ }
      }
    }
  }
}

export function expectedReleaseAssetNames(version, includeSecondary = false) {
  const names = ['latest-mac.yml'];
  for (const arch of releaseMacArchitectures(version)) {
    const base = `Tide.Mind-${version}-${arch}`;
    names.push(`${base}.dmg`, `${base}.dmg.blockmap`, `${base}.zip`, `${base}.zip.blockmap`);
    names.push(`update-manifest-darwin-${arch}.sig`);
    if (includeSecondary) names.push(`update-manifest-darwin-${arch}.sig.secondary`);
  }
  return names.sort();
}

export function assertCompleteReleaseAssetList(version, assets, signed = true, includeSecondary = false) {
  const actual = assets.map(asset => asset.name).sort();
  const expected = expectedReleaseAssetNames(version, includeSecondary)
    .filter(name => signed || !name.includes('update-manifest-'));
  if (new Set(actual).size !== actual.length) throw new Error('release contains duplicate asset names');
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const missing = expected.filter(name => !actual.includes(name));
    const unexpected = actual.filter(name => !expected.includes(name));
    throw new Error(
      `release asset list mismatch; missing: ${missing.join(', ') || '(none)'}; ` +
      `unexpected: ${unexpected.join(', ') || '(none)'}`,
    );
  }
  const empty = assets.filter(asset => typeof asset.size === 'number' && asset.size <= 0).map(asset => asset.name);
  if (empty.length > 0) throw new Error(`release contains empty assets: ${empty.join(', ')}`);
}

function verifyRelease(version, ossRepo, signed = true, includeSecondary = false) {
  const release = parseJsonOutput('gh', [
    'release',
    'view',
    `v${version}`,
    '--repo',
    'SawyerHan-AI/TideMind',
    '--json',
    'tagName,isDraft,isPrerelease,url,assets',
  ], ossRepo);
  assertCompleteReleaseAssetList(version, release.assets, signed, includeSecondary);
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
  assertRequestedVersion(opts.version, rootPkg.version);
  const version = opts.version ?? rootPkg.version;
  assertReleaseBypassesAllowed(version, opts);
  const previousVersions = resolveUpdatePreviousVersions(version, opts.previousVersion);
  if (previousVersions.length === 0 && !opts.skipUpdateVerify) {
    throw new Error('Could not infer --previous-version from --version; pass it explicitly');
  }
  const tagName = `v${version}`;
  if (version === '0.2.92' && opts.allowUnsigned) {
    throw new Error('0.2.92 cannot be released with --allow-unsigned');
  }
  const notesFile = opts.prepareCandidate ? null : ensureNotesFile(version, opts.notesFile, opts.dryRun);
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
  const expectedRootHead = capture('git', ['rev-parse', 'HEAD'], repoRoot).stdout;
  const agentHostEvidence = opts.agentHostEvidence
    ?? (process.env.TIDEMIND_AGENT_HOST_ACCEPTANCE_INDEX
      ? path.resolve(process.env.TIDEMIND_AGENT_HOST_ACCEPTANCE_INDEX)
      : null);
  const agentHostCandidateApps = {
    arm64: opts.agentHostCandidateAppArm64 ?? (process.env.TIDEMIND_AGENT_HOST_CANDIDATE_APP_ARM64
      ? path.resolve(process.env.TIDEMIND_AGENT_HOST_CANDIDATE_APP_ARM64) : null),
    x64: opts.agentHostCandidateAppX64 ?? (process.env.TIDEMIND_AGENT_HOST_CANDIDATE_APP_X64
      ? path.resolve(process.env.TIDEMIND_AGENT_HOST_CANDIDATE_APP_X64) : null),
  };
  const architectures = releaseMacArchitectures(version);
  if ((!agentHostEvidence || architectures.some(arch => !agentHostCandidateApps[arch])) && !opts.dryRun && !opts.prepareCandidate) {
    throw new Error(`A real release requires real-host evidence and exact signed ${architectures.join('/')} candidate apps`);
  }
  const acceptanceIndex = agentHostEvidence
    ?? path.join(repoRoot, 'release-evidence', 'agent-integration-host-acceptance', version, 'index.json');
  const acceptanceVerifierArgs = [
    'scripts/verify-agent-integration-host-acceptance.mjs',
    '--index', acceptanceIndex,
    '--app-version', version,
    '--source-commit', expectedRootHead,
    ...architectures.flatMap(arch => [
      `--candidate-app-${arch}`, agentHostCandidateApps[arch] ?? path.join(repoRoot, `.dry-run-${arch}-candidate.app`),
    ]),
  ];
  // This is an external release acceptance gate, not a unit/health check. It
  // remains mandatory when --skip-health is used and rejects fixture evidence.
  if (!opts.prepareCandidate) run('node', acceptanceVerifierArgs, {
    label: 'verify real-host Agent Integration acceptance',
    dryRun: opts.dryRun,
  });

  // Release website assets must be built from the exact lockfile, not whatever
  // happens to remain in a long-lived local node_modules directory.
  if (!opts.prepareCandidate) run('npm', ['ci'], {
    cwd: path.join(repoRoot, 'pro/website'),
    label: 'install exact website dependencies',
    dryRun: opts.dryRun,
  });

  run('node', ['scripts/check-version-sync.mjs'], { label: 'check version sync', dryRun: opts.dryRun });
  // Agent Adapter enablement is a release contract, not a general health
  // convenience. Keep this outside --skip-health so no release path can ship
  // an empty, inconsistent, or falsely advertised signed manifest.
  run('npm', ['run', 'verify:agent-integration-release'], {
    label: 'verify Agent Integration release manifest',
    dryRun: opts.dryRun,
  });
  // 2026-05-21 v0.2.71 audit A-HIGH-1/2:helper entitlement 防回归。
  // 在 push 之前拦截"main plist inherit 给 helper → SIGKILL"事故。
  // health-check 也会再跑一次,这里 fail-fast 早于 push。
  run('node', ['scripts/check-mac-packaging.mjs'], { label: 'check mac packaging', dryRun: opts.dryRun });
  run('git', ['diff', '--check'], { label: 'git diff --check', dryRun: opts.dryRun });
  if (!opts.skipHealth) {
    run('npm', ['run', 'health'], { label: 'npm run health', dryRun: opts.dryRun });
  }

  if (!opts.dryRun) assertRepoSnapshot(repoRoot, 'ExternaBrain', expectedRootHead);

  // Keychain/private-key validation belongs before the first external mutation,
  // not merely before the public tag. A bad key must not leave private main,
  // the website, or OSS main advanced by an otherwise doomed release attempt.
  let signingKeys = { privateKey: null, secondaryKey: null, source: null };
  if (!opts.dryRun && !opts.prepareCandidate) {
    signingKeys = loadSigningKeys(opts.allowUnsigned);
    assertRepoSnapshot(repoRoot, 'ExternaBrain', expectedRootHead);
    assertReleaseTagPreflight(version, expectedRootHead, opts.ossRepo, opts.forceTag);
  }

  run('git', ['push', 'origin', 'main'], { label: 'push ExternaBrain main', dryRun: opts.dryRun });
  if (!opts.dryRun) {
    assertRemoteMainAt(repoRoot, expectedRootHead);
    const privateCiRunId = await getPrivateCiRunId(expectedRootHead, opts.timeoutMinutes * 60_000);
    run('gh', ['run', 'watch', privateCiRunId, '--exit-status'], {
      cwd: repoRoot,
      label: `wait private exact-SHA CI ${privateCiRunId}`,
      timeoutMs: opts.timeoutMinutes * 60_000,
    });
    const privateCi = parseJsonOutput('gh', [
      'run', 'view', privateCiRunId,
      '--json', 'headBranch,headSha,event,status,conclusion',
    ], repoRoot);
    if (privateCi.headBranch !== 'main'
      || privateCi.headSha !== expectedRootHead
      || privateCi.event !== 'push'
      || privateCi.status !== 'completed'
      || privateCi.conclusion !== 'success') {
      throw new Error(`private CI ${privateCiRunId} is not successful at exact source commit ${expectedRootHead}`);
    }
    assertRemoteMainAt(repoRoot, expectedRootHead);
  }

  if (!opts.skipWebsite && !opts.prepareCandidate) {
    if (!opts.dryRun) {
      assertRepoSnapshot(repoRoot, 'ExternaBrain', expectedRootHead);
      assertRemoteMainAt(repoRoot, expectedRootHead);
    }
    run('npx', ['astro', 'build'], {
      cwd: path.join(repoRoot, 'pro/website'),
      label: 'website build',
      dryRun: opts.dryRun,
    });
    if (!opts.dryRun) {
      assertRepoSnapshot(repoRoot, 'ExternaBrain', expectedRootHead);
      assertRemoteMainAt(repoRoot, expectedRootHead);
    }
    // 显式传 --commit-message / --commit-hash,绕开 wrangler 默认从 git
    // 自动取 commit message 的路径。CF Pages deployment API 的 commit_message
    // 字段有长度上限(实测 ~1KB),超长会返回误导性的
    // "Invalid commit message, it must be a valid UTF-8 string [code: 8000111]",
    // 实际是长度问题不是编码问题。我们的发版 commit 走中文 + 多段正文很
    // 容易超限,直接固定成短文本最稳。SHA 还是真实的 HEAD,溯源不丢。
    const sha = opts.dryRun ? 'DRY-RUN-SHA' : expectedRootHead;
    run('npm', [
      'exec', '--offline', '--', 'wrangler', 'pages', 'deploy', 'dist/',
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

  if (!opts.dryRun) {
    assertRepoSnapshot(repoRoot, 'ExternaBrain', expectedRootHead);
    assertRemoteMainAt(repoRoot, expectedRootHead);
  }
  run('./sync-oss.sh', [opts.ossRepo, ...(opts.yes ? ['--yes'] : [])], {
    label: 'sync OSS repo',
    dryRun: opts.dryRun,
  });
  if (!opts.dryRun) {
    assertRepoSnapshot(repoRoot, 'ExternaBrain', expectedRootHead);
    assertRemoteMainAt(repoRoot, expectedRootHead);
  }
  const ossAcceptanceDirectory = path.join(
    opts.ossRepo,
    'release-evidence',
    'agent-integration-host-acceptance',
    version,
  );
  if (!opts.prepareCandidate) run('node', [...acceptanceVerifierArgs, '--copy-to', ossAcceptanceDirectory], {
    label: 'stage verified real-host Agent acceptance for release CI',
    dryRun: opts.dryRun,
  });
  const candidateTransferTemp = opts.dryRun || opts.prepareCandidate
    ? path.join(os.tmpdir(), 'tidemind-agent-host-candidate-dry-run')
    : fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-agent-host-candidate-'));
  const candidateTransfers = Object.fromEntries((opts.prepareCandidate ? [] : architectures).map(architecture => {
    const archive = path.join(candidateTransferTemp, `Tide.Mind-${version}-${architecture}-${expectedRootHead.slice(0, 12)}.zip`);
    const receipt = path.join(
      opts.ossRepo,
      'release-evidence',
      'agent-integration-host-candidate-transfer',
      `${version}-${architecture}.json`,
    );
    run('node', [
      'scripts/agent-host-candidate-transfer.mjs', 'prepare',
      '--architecture', architecture,
      '--candidate-app', agentHostCandidateApps[architecture] ?? path.join(repoRoot, `.dry-run-${architecture}-candidate.app`),
      '--index', acceptanceIndex,
      '--source-commit', expectedRootHead,
      '--app-version', version,
      '--archive', archive,
      '--receipt', receipt,
    ], {
      label: `seal physical ${architecture} candidate transfer artifact`,
      dryRun: opts.dryRun,
    });
    return [architecture, { archive, receipt }];
  }));
  const ossDirty = !opts.dryRun && capture('git', ['status', '--porcelain'], opts.ossRepo).stdout;
  if (ossDirty) {
    run('git', ['add', '-A'], { cwd: opts.ossRepo, label: 'stage OSS changes', dryRun: opts.dryRun });
    const boundOssMessage = `${ossMessage}\n\nTideMind-Source-Commit: ${expectedRootHead}`;
    run('git', ['commit', '-m', boundOssMessage], { cwd: opts.ossRepo, label: 'commit OSS changes', dryRun: opts.dryRun });
  } else {
    console.log('\n> OSS repo has no changes to commit');
  }
  if (!opts.dryRun) assertOssSourceBinding(expectedRootHead, opts.ossRepo);
  run('git', ['push', 'origin', 'main'], { cwd: opts.ossRepo, label: 'push OSS main', dryRun: opts.dryRun });
  const expectedOssHead = opts.dryRun
    ? 'DRY-RUN-OSS-HEAD'
    : capture('git', ['rev-parse', 'HEAD'], opts.ossRepo).stdout;
  if (!opts.dryRun) assertOssMainStillAt(expectedOssHead, opts.ossRepo);
  if (!opts.dryRun) assertOssSourceBinding(expectedRootHead, opts.ossRepo);

  if (opts.prepareCandidate) {
    const startedAt = Date.now() - 60_000;
    const requestId = crypto.randomUUID();
    run('gh', ['workflow', 'run', 'release.yml', '--repo', 'SawyerHan-AI/TideMind', '--ref', 'main',
      '-f', 'candidate_only=true', '-f', `source_sha=${expectedRootHead}`, '-f', `request_id=${requestId}`], {
      cwd: opts.ossRepo, label: 'build signed Apple Silicon candidate', dryRun: opts.dryRun,
    });
    if (!opts.dryRun) {
      const runId = await getPackagePreflightRunId(opts.ossRepo, opts.timeoutMinutes * 60_000, expectedOssHead, startedAt, `Candidate ${requestId}`);
      run('gh', ['run', 'watch', runId, '--repo', 'SawyerHan-AI/TideMind', '--exit-status'], {
        cwd: opts.ossRepo, label: `wait signed candidate ${runId}`, timeoutMs: opts.timeoutMinutes * 60_000,
      });
      assertOssMainStillAt(expectedOssHead, opts.ossRepo);
      console.log(`Signed candidate ready: https://github.com/SawyerHan-AI/TideMind/actions/runs/${runId}`);
    }
    return;
  }

  // GitHub-hosted runners cannot see a path on the release Mac. Transfer the
  // exact signed candidate through a private draft release asset; the committed
  // receipt binds archive bytes to source, version and accepted app bundle hash.
  if (!opts.dryRun) {
    const transfers = Object.values(candidateTransfers).map(({ archive, receipt }) => ({
      archive,
      receipt: readJson(receipt),
    }));
    const transfer = transfers[0].receipt;
    const existing = capture('gh', [
      'release', 'view', transfer.transferTag, '--repo', 'SawyerHan-AI/TideMind',
      '--json', 'isDraft,tagName',
    ], opts.ossRepo, true);
    if (existing.status === 0) {
      const metadata = JSON.parse(existing.stdout);
      if (!metadata.isDraft || metadata.tagName !== transfer.transferTag) {
        throw new Error(`candidate transfer ${transfer.transferTag} exists but is not the expected draft release`);
      }
      const remoteTag = capture('git', [
        'ls-remote', '--tags', 'origin', `refs/tags/${transfer.transferTag}`,
      ], opts.ossRepo).stdout.split(/\s+/u)[0] ?? '';
      if (remoteTag !== expectedOssHead) {
        throw new Error(`candidate transfer tag points at ${remoteTag || '(missing)'}, expected ${expectedOssHead}`);
      }
      run('gh', [
        'release', 'upload', transfer.transferTag,
        ...transfers.map(item => item.archive),
        '--repo', 'SawyerHan-AI/TideMind', '--clobber',
      ], { cwd: opts.ossRepo, label: 'replace sealed candidate transfer asset' });
    } else {
      run('gh', [
        'release', 'create', transfer.transferTag,
        ...transfers.map(item => item.archive),
        '--repo', 'SawyerHan-AI/TideMind', '--target', expectedOssHead,
        '--title', `Private Agent host candidate ${version} ${expectedRootHead.slice(0, 12)}`,
        '--notes', 'Private draft transfer used only by the release verification workflow.',
        '--draft',
      ], { cwd: opts.ossRepo, label: 'upload sealed candidate to private draft release' });
    }
  }

  // 在创建公开tag之前先用与正式发布完全相同的runner、Apple签名、
  // 公证、native架构与包内Worker smoke跑一次。workflow_dispatch不会创建Release；
  // 任何一架构失败都会在不可逆的tag push之前停止。
  const packagePreflightStartedAt = Date.now() - 60_000;
  const packagePreflightRequestId = crypto.randomUUID();
  run('gh', ['workflow', 'run', 'release.yml', '--repo', 'SawyerHan-AI/TideMind', '--ref', 'main',
    '-f', 'candidate_only=false', '-f', `request_id=${packagePreflightRequestId}`], {
    cwd: opts.ossRepo,
    label: 'start macOS package preflight',
    dryRun: opts.dryRun,
  });
  if (!opts.dryRun) {
    const packagePreflightRunId = await getPackagePreflightRunId(
      opts.ossRepo,
      opts.timeoutMinutes * 60_000,
      expectedOssHead,
      packagePreflightStartedAt,
      `Preflight ${packagePreflightRequestId}`,
    );
    run('gh', ['run', 'watch', packagePreflightRunId, '--repo', 'SawyerHan-AI/TideMind', '--exit-status'], {
      cwd: opts.ossRepo,
      label: `wait macOS package preflight ${packagePreflightRunId}`,
      timeoutMs: opts.timeoutMinutes * 60_000,
    });
    const verifiedRunHead = capture('gh', [
      'run', 'view', packagePreflightRunId,
      '--repo', 'SawyerHan-AI/TideMind',
      '--json', 'headSha',
      '--jq', '.headSha',
    ], opts.ossRepo).stdout;
    if (verifiedRunHead !== expectedOssHead) {
      throw new Error(`macOS preflight ran at ${verifiedRunHead}, expected ${expectedOssHead}`);
    }
    assertOssMainStillAt(expectedOssHead, opts.ossRepo);
  }

  if (!opts.dryRun) assertOssMainStillAt(expectedOssHead, opts.ossRepo);
  const tagAction = opts.dryRun ? 'create' : assertTagState(version, opts.ossRepo, opts.forceTag);
  if (tagAction === 'move') {
    run('git', ['tag', '-f', tagName], { cwd: opts.ossRepo, label: `move ${tagName}`, dryRun: opts.dryRun });
    run('git', ['push', 'origin', `:refs/tags/${tagName}`], { cwd: opts.ossRepo, label: `delete remote ${tagName}`, dryRun: opts.dryRun });
  } else if (tagAction === 'create') {
    run('git', ['tag', tagName], { cwd: opts.ossRepo, label: `create ${tagName}`, dryRun: opts.dryRun });
  } else {
    console.log(`\n> ${tagName} already points at OSS HEAD`);
  }
  // 记录 push tag 的时刻,用于过滤掉 --force-tag 场景下同名旧 run。
  // 减去 60s buffer 容忍本地/GitHub 服务器时钟偏差,确保不会误排除本次刚触发的新 run;
  // 旧 run 在 force-tag 重发场景通常早数分钟以上,buffer 不影响其被排除。
  // 仅 'move'/'create' 会真正触发新 run(故按 push 时刻过滤旧 run);'already-at-head'
  // 是崩溃后收尾重跑:tag 已指向 HEAD、remote ref 已存在,下面的 push 是 no-op 不触发新
  // run,唯一的已完成 run createdAt 早于本次 push,必须 minCreatedAtMs=0 退化为按
  // headBranch 匹配,否则收尾重跑永远找不到那个 run → getReleaseRunId 超时。
  const minRunCreatedAtMs = tagAction === 'already-at-head' ? 0 : Date.now() - 60_000;
  run('git', ['push', 'origin', tagName], { cwd: opts.ossRepo, label: `push ${tagName}`, dryRun: opts.dryRun });

  if (!opts.dryRun) {
    const runId = await getReleaseRunId(
      version,
      opts.ossRepo,
      opts.timeoutMinutes * 60_000,
      expectedOssHead,
      minRunCreatedAtMs,
    );
    run('gh', ['run', 'watch', runId, '--repo', 'SawyerHan-AI/TideMind', '--exit-status'], {
      cwd: opts.ossRepo,
      label: `wait release workflow ${runId}`,
      timeoutMs: opts.timeoutMinutes * 60_000,
    });
    const verifiedReleaseRun = parseJsonOutput('gh', [
      'run', 'view', runId,
      '--repo', 'SawyerHan-AI/TideMind',
      '--json', 'headSha,event,status,conclusion',
    ], opts.ossRepo);
    if (verifiedReleaseRun.headSha !== expectedOssHead
      || verifiedReleaseRun.event !== 'push'
      || verifiedReleaseRun.status !== 'completed'
      || verifiedReleaseRun.conclusion !== 'success') {
      throw new Error(
        `release workflow ${runId} is not the successful tag push for OSS ${expectedOssHead}`,
      );
    }
    // 离线签名:对每个 (platform, arch) 的 DMG 签名 "${version}\n${dmgUrl}",把签名作为
    // 额外 asset 上传。**先签名后 publish**:消除"已 publish 但无 .sig"的窗口
    // (该窗口叠加云端 5min release 缓存 → 落在窗口内的客户端拿到 signatureUrl=null
    // 快照 → 全量拒更,正是 v0.2.66 事故)。对 draft release 上传 asset 是允许的,
    // 且签名内容用 hardcoded 稳定 URL(见 signReleaseAssets 注释),与 release state
    // 无关,所以先签完全安全。私钥已在 push tag 之前 fail-fast 解析(signingKeys)。
    signReleaseAssets(version, opts.ossRepo, signingKeys);
    run('gh', ['release', 'edit', tagName, '--repo', 'SawyerHan-AI/TideMind', '--notes-file', notesFile, '--draft=false', '--latest'], {
      cwd: opts.ossRepo,
      label: 'publish GitHub release',
    });
    verifyRelease(version, opts.ossRepo, !opts.allowUnsigned, Boolean(signingKeys.secondaryKey));
    if (!opts.skipCloudVerify) await verifyCloud(version);
    if (!opts.skipUpdateVerify) await verifyUpdateApi(
      version,
      previousVersions,
      opts.allowUnsigned,
      readEmbeddedUpdatePublicKeys(),
    );
    const transfer = readJson(candidateTransfers.arm64.receipt);
    run('gh', [
      'release', 'delete', transfer.transferTag,
      '--repo', 'SawyerHan-AI/TideMind', '--cleanup-tag', '--yes',
    ], { cwd: opts.ossRepo, label: 'remove completed private candidate transfer' });
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
