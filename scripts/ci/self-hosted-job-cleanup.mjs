#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const workspaceInput = process.env.GITHUB_WORKSPACE || '';
if (!workspaceInput || !fs.existsSync(workspaceInput)) process.exit(0);

const workspace = fs.realpathSync(workspaceInput);
const runnerWork = process.env.RUNNER_WORKSPACE ? fs.realpathSync(process.env.RUNNER_WORKSPACE) : path.dirname(workspace);
const forbidden = new Set(['/', os.homedir(), runnerWork]);

if (forbidden.has(workspace) || path.dirname(workspace) !== runnerWork) {
  throw new Error(`refusing cleanup outside one checkout: ${workspace}`);
}

const exactTargets = [
  path.join(workspace, '.tmp-ci'),
  path.join(workspace, 'data', 'test'),
];

for (const target of exactTargets) {
  const relative = path.relative(workspace, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`unsafe cleanup target: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

const jobTempInput = process.env.TIDEMIND_CI_JOB_TEMP || '';
const runnerTempInput = process.env.RUNNER_TEMP || '';
if (jobTempInput) {
  if (!runnerTempInput || !fs.existsSync(runnerTempInput) || !fs.existsSync(jobTempInput)) {
    throw new Error('job temp exists without a valid runner temp root');
  }
  const runnerTemp = fs.realpathSync(runnerTempInput);
  const jobTemp = fs.realpathSync(jobTempInput);
  const relative = path.relative(runnerTemp, jobTemp);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(jobTemp).startsWith('externabrain-')) {
    throw new Error(`refusing unsafe job temp cleanup: ${jobTemp}`);
  }
  fs.rmSync(jobTemp, { recursive: true, force: true });
}

console.log(`self-hosted cleanup completed for ${workspace}`);
