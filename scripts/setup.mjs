#!/usr/bin/env node

/**
 * 一键安装项目所有 npm 包根的依赖。
 *
 * 项目实际有 4 套 package.json + node_modules：
 *   /                  根：MCP server / daemon / 后端核心
 *   /client            Electron 客户端
 *   /pro/cloud-server  云服务（闭源）
 *   /pro/website       官网（闭源）
 *
 * 本脚本顺序在每个目录跑 `npm install`。
 * 已经装好且依赖锁版本未变的目录，npm 会自己快速跳过，所以重复跑也安全。
 *
 * 用途：
 *   - fresh clone / 新 worktree 初始化
 *   - git pull 后补装新依赖
 *   - health check 报「Cannot find module ...」时第一时间执行
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

// 顺序很重要：根先装（client 的 postinstall electron-rebuild 依赖根的 better-sqlite3 ABI）。
// pro/* 互不依赖根或 client，可以并行，但顺序跑日志更可读，并行收益不大。
const packages = [
  { name: 'root', cwd: repoRoot },
  { name: 'client', cwd: path.join(repoRoot, 'client') },
  { name: 'pro/cloud-server', cwd: path.join(repoRoot, 'pro/cloud-server') },
  { name: 'pro/website', cwd: path.join(repoRoot, 'pro/website') },
];

function runInstall(pkg) {
  return new Promise((resolve) => {
    const child = spawn('npm', ['install', '--no-audit', '--no-fund'], {
      cwd: pkg.cwd,
      stdio: 'inherit',
      env: process.env,
    });
    child.on('close', (code, signal) => {
      resolve({ ...pkg, code, signal });
    });
  });
}

console.log('TideMind setup — installing 4 npm packages\n');

const skipped = [];
const installed = [];
const failed = [];

for (const pkg of packages) {
  if (!existsSync(path.join(pkg.cwd, 'package.json'))) {
    console.log(`[skip] ${pkg.name}: no package.json (path: ${pkg.cwd})`);
    skipped.push(pkg);
    continue;
  }
  console.log(`\n=== ${pkg.name} (${pkg.cwd}) ===`);
  const result = await runInstall(pkg);
  if (result.code === 0) {
    installed.push(pkg);
  } else {
    failed.push({ ...pkg, code: result.code, signal: result.signal });
  }
}

console.log('\n=== summary ===');
console.log(`installed: ${installed.map(p => p.name).join(', ') || '(none)'}`);
if (skipped.length) console.log(`skipped (no package.json): ${skipped.map(p => p.name).join(', ')}`);
if (failed.length) {
  console.log(`failed: ${failed.map(p => `${p.name} (exit ${p.code ?? p.signal})`).join(', ')}`);
  process.exitCode = 1;
}
