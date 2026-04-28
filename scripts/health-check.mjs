#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const checks = [
  { name: 'root lint', cwd: repoRoot, command: 'npm', args: ['run', 'lint'] },
  { name: 'root build', cwd: repoRoot, command: 'npm', args: ['run', 'build'] },
  { name: 'root test', cwd: repoRoot, command: 'npm', args: ['test'] },
  { name: 'cloud typecheck', cwd: path.join(repoRoot, 'pro/cloud-server'), command: 'npx', args: ['tsc', '--noEmit'] },
  { name: 'cloud test', cwd: path.join(repoRoot, 'pro/cloud-server'), command: 'npm', args: ['test'] },
  { name: 'website build', cwd: path.join(repoRoot, 'pro/website'), command: 'npm', args: ['run', 'build'] },
  { name: 'client build', cwd: path.join(repoRoot, 'client'), command: 'npm', args: ['run', 'build'] },
  { name: 'client typecheck', cwd: path.join(repoRoot, 'client'), command: 'npx', args: ['tsc', '--build', '--noEmit'] },
];

function runCheck(check) {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(check.command, check.args, {
      cwd: check.cwd,
      stdio: 'pipe',
      env: process.env,
    });

    let output = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });

    child.on('close', (code, signal) => {
      const durationMs = Math.round(performance.now() - started);
      resolve({
        ...check,
        code,
        signal,
        durationMs,
        output: output.trim(),
      });
    });
  });
}

function statusFor(result) {
  if (result.code === 0) return 'PASS';
  return result.soft ? 'SOFT_FAIL' : 'FAIL';
}

const results = [];

console.log('TideMind health check');
console.log(`repo: ${repoRoot}`);
console.log('');

for (const check of checks) {
  process.stdout.write(`> ${check.name} ... `);
  const result = await runCheck(check);
  results.push(result);
  console.log(`${statusFor(result)} (${(result.durationMs / 1000).toFixed(1)}s)`);
}

console.log('');
console.log('| Check | Status | Time |');
console.log('|---|---:|---:|');
for (const result of results) {
  console.log(`| ${result.name}${result.soft ? ' (report only)' : ''} | ${statusFor(result)} | ${(result.durationMs / 1000).toFixed(1)}s |`);
}

const failures = results.filter(result => result.code !== 0 && !result.soft);
const softFailures = results.filter(result => result.code !== 0 && result.soft);

if (failures.length > 0 || softFailures.length > 0) {
  console.log('');
  for (const result of [...failures, ...softFailures]) {
    console.log(`## ${result.name} ${statusFor(result)}`);
    console.log('```');
    console.log(result.output.slice(-6000) || `(exit ${result.code ?? result.signal})`);
    console.log('```');
  }
}

if (failures.length > 0) {
  process.exitCode = 1;
}
