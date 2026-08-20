#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function fail(message) {
  console.error(`self-hosted preflight failed: ${message}`);
  process.exitCode = 1;
}

const expectedRole = process.argv[2];
if (!['externabrain-linux', 'externabrain-macos'].includes(expectedRole)) {
  throw new Error('usage: self-hosted-job-preflight.mjs <externabrain-linux|externabrain-macos>');
}

const expected = expectedRole === 'externabrain-linux'
  ? { platform: 'linux', arch: 'x64' }
  : { platform: 'darwin', arch: 'arm64' };

if (process.platform !== expected.platform) fail(`expected ${expected.platform}, got ${process.platform}`);
if (process.arch !== expected.arch) fail(`expected ${expected.arch}, got ${process.arch}`);
if (process.env.RUNNER_ENVIRONMENT !== 'self-hosted') fail('RUNNER_ENVIRONMENT is not self-hosted');

const workspace = process.env.GITHUB_WORKSPACE ? fs.realpathSync(process.env.GITHUB_WORKSPACE) : '';
if (!workspace || workspace === '/' || workspace === os.homedir()) fail('unsafe or missing GITHUB_WORKSPACE');
if (workspace && !fs.existsSync(path.join(workspace, '.git'))) fail('workspace is not a Git checkout');

const stat = fs.statfsSync(workspace || process.cwd());
const freeGiB = (stat.bavail * stat.bsize) / (1024 ** 3);
const minimumGiB = Number(process.env.TIDEMIND_CI_MIN_FREE_GIB || 40);
if (!Number.isFinite(minimumGiB) || minimumGiB < 1) fail('invalid TIDEMIND_CI_MIN_FREE_GIB');
if (freeGiB < minimumGiB) fail(`only ${freeGiB.toFixed(1)} GiB free; need ${minimumGiB} GiB`);

const workflowSha = process.env.GITHUB_SHA || '';
const sourceHead = process.env.TIDEMIND_CI_SOURCE_HEAD || '';
if (!/^[0-9a-f]{40}$/.test(workflowSha)) fail('GITHUB_SHA is not an exact workflow commit SHA');
if (!/^[0-9a-f]{40}$/.test(sourceHead)) fail('TIDEMIND_CI_SOURCE_HEAD is not an exact source commit SHA');

const runnerTemp = process.env.RUNNER_TEMP ? fs.realpathSync(process.env.RUNNER_TEMP) : '';
if (!runnerTemp || runnerTemp === '/' || runnerTemp === os.homedir()) fail('unsafe or missing RUNNER_TEMP');
let jobTemp = '';
if (runnerTemp && !process.exitCode) {
  const job = (process.env.GITHUB_JOB || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '-');
  const runId = (process.env.GITHUB_RUN_ID || '0').replace(/[^0-9]/g, '');
  const attempt = (process.env.GITHUB_RUN_ATTEMPT || '0').replace(/[^0-9]/g, '');
  jobTemp = fs.mkdtempSync(path.join(runnerTemp, `externabrain-${runId}-${attempt}-${job}-`));
  fs.chmodSync(jobTemp, 0o700);
  if (process.env.GITHUB_ENV) {
    fs.appendFileSync(process.env.GITHUB_ENV, `TIDEMIND_CI_JOB_TEMP=${jobTemp}\nTMPDIR=${jobTemp}\n`);
  }
}

console.log(JSON.stringify({
  role: expectedRole,
  runnerName: process.env.RUNNER_NAME,
  runnerArch: process.env.RUNNER_ARCH,
  runnerOs: process.env.RUNNER_OS,
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  freeGiB: Number(freeGiB.toFixed(1)),
  workflowSha,
  sourceHead,
  jobTemp,
}, null, 2));

if (process.exitCode) process.exit(process.exitCode);
