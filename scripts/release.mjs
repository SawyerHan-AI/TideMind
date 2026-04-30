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

function getReleaseRunId(tag, ossRepo) {
  const runs = parseJsonOutput('gh', [
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
  const match = runs.find(run => run.headBranch === `v${tag}` || run.headBranch === tag);
  if (!match) throw new Error(`Could not find Release workflow run for v${tag}`);
  return String(match.databaseId);
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
    run('npx', ['wrangler', 'pages', 'deploy', 'dist/', '--project-name', 'tidemind-website', '--branch=main'], {
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
    const runId = getReleaseRunId(version, opts.ossRepo);
    run('gh', ['run', 'watch', runId, '--repo', 'SawyerHan-AI/TideMind', '--exit-status'], {
      cwd: opts.ossRepo,
      label: `wait release workflow ${runId}`,
      timeoutMs: opts.timeoutMinutes * 60_000,
    });
    run('gh', ['release', 'edit', tagName, '--repo', 'SawyerHan-AI/TideMind', '--notes-file', notesFile, '--draft=false', '--latest'], {
      cwd: opts.ossRepo,
      label: 'publish GitHub release',
    });
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
