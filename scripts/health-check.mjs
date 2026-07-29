#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
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
  { name: 'root audit', cwd: repoRoot, command: 'npm', args: ['audit', '--audit-level=moderate'] },
  { name: 'cloud typecheck', cwd: path.join(repoRoot, 'pro/cloud-server'), command: 'npx', args: ['tsc', '--noEmit'] },
  { name: 'cloud test', cwd: path.join(repoRoot, 'pro/cloud-server'), command: 'npm', args: ['test'] },
  { name: 'cloud audit', cwd: path.join(repoRoot, 'pro/cloud-server'), command: 'npm', args: ['audit', '--audit-level=moderate'] },
  { name: 'website typecheck', cwd: path.join(repoRoot, 'pro/website'), command: 'npx', args: ['tsc', '--noEmit'] },
  { name: 'website build', cwd: path.join(repoRoot, 'pro/website'), command: 'npm', args: ['run', 'build'] },
  { name: 'website audit', cwd: path.join(repoRoot, 'pro/website'), command: 'npm', args: ['audit', '--audit-level=moderate'] },
  { name: 'client build', cwd: path.join(repoRoot, 'client'), command: 'npm', args: ['run', 'build'] },
  { name: 'client typecheck', cwd: path.join(repoRoot, 'client'), command: 'npx', args: ['tsc', '--build', '--noEmit'] },
  {
    name: 'client audit',
    cwd: path.join(repoRoot, 'client'),
    command: 'node',
    args: ['../scripts/audit-client-dependencies.mjs'],
  },
  // 2026-05-21 v0.2.71 audit A-HIGH-1/2:helper entitlement 防回归。
  // 拦截 v0.2.70 那种"main plist inherit 给 helper → SIGKILL"事故,plist-parse
  // 而非 grep,避免被注释里的字符串误判。
  { name: 'mac packaging', cwd: repoRoot, command: 'node', args: ['scripts/check-mac-packaging.mjs'] },
];

/**
 * 在跑 check 之前确认 node_modules 存在且非空。
 * 缺失时直接给出可操作的错误（"跑 npm run setup"），而不是让用户淹没在
 * "Cannot find module 'postgres' / 'argon2' / astro: command not found" 这类
 * 看起来像代码 bug 实际是装机问题的输出里。
 *
 * 判定标准：node_modules 目录存在 && 至少有一个条目（npm install 失败半截会留空目录）。
 * 根 / client 的 node_modules 自带子目录，pro/* 的也是；可靠区分「装好」vs「半装」。
 */
function preflightDeps(check) {
  // 只对有 package.json 的子目录做检查
  if (!existsSync(path.join(check.cwd, 'package.json'))) return null;
  const nm = path.join(check.cwd, 'node_modules');
  if (!existsSync(nm)) {
    return `node_modules missing at ${path.relative(repoRoot, check.cwd) || '.'}`;
  }
  try {
    const entries = readdirSync(nm);
    if (entries.length === 0) {
      return `node_modules empty at ${path.relative(repoRoot, check.cwd) || '.'}`;
    }
  } catch (err) {
    return `node_modules unreadable at ${path.relative(repoRoot, check.cwd) || '.'}: ${err.message}`;
  }
  return null;
}

function runCheck(check) {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(check.command, check.args, {
      cwd: check.cwd,
      stdio: 'pipe',
      env: process.env,
    });

    let output = '';
    let settled = false;
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });

    // spawn 本身失败(ENOENT:命令不在 PATH / cwd 异常等)会 emit 'error' 且不会
    // emit 'close'。没有这个监听器时 Node 会以 "Unhandled 'error' event" 直接崩,
    // 包装的 Promise 永不 resolve —— 装机问题反而绕过 preflightDeps 的友好提示。
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      resolve({
        ...check,
        code: 1,
        signal: null,
        durationMs: Math.round(performance.now() - started),
        output: `spawn failed: ${err.message}`,
      });
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
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
  // Preflight：先确认 node_modules 在场。缺失时不去跑真命令——因为真命令一定会失败，
  // 而且失败信号是 "找不到 X 模块" 这类对装机问题不直观的输出。
  const depsIssue = preflightDeps(check);
  if (depsIssue) {
    const result = {
      ...check,
      code: 1,
      signal: null,
      durationMs: 0,
      output: `${depsIssue}\n→ Run \`npm run setup\` (installs all 4 packages) or \`npm install\` in that directory.`,
    };
    results.push(result);
    console.log(`SETUP_REQUIRED (${depsIssue})`);
    continue;
  }
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
