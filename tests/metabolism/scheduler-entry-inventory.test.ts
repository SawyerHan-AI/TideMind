/**
 * scheduler生产入口静态清单门禁。
 *
 * Production activation后固定为三个外部入口：Electron Worker、CLI daemon和MCP。
 * Electron main不得重新引入runSchedulerTick或ALL_TASKS执行路径。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

function typescriptFilesBelow(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const absolute = path.join(directory, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) files.push(...typescriptFilesBelow(absolute));
    else if (entry.endsWith('.ts')) files.push(absolute);
  }
  return files;
}

function externalSchedulerCallsites(): string[] {
  const roots = [path.join(repoRoot, 'src'), path.join(repoRoot, 'client', 'electron')];
  const schedulerImplementation = path.join(repoRoot, 'src', 'metabolism', 'scheduler.ts');
  const callsites: string[] = [];

  for (const file of roots.flatMap(typescriptFilesBelow)) {
    if (file === schedulerImplementation) continue;
    const relative = path.relative(repoRoot, file).split(path.sep).join('/');
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line) => {
      if (/\brunSchedulerTick\s*\(/.test(line) || /\bmaybeRunMaintenance\s*\(/.test(line)) {
        callsites.push(relative);
      }
    });
  }

  return callsites.sort();
}

describe('scheduler production entry inventory', () => {
  it('只有Electron Worker、CLI daemon和MCP三个production入口', () => {
    expect(externalSchedulerCallsites()).toEqual([
      'client/electron/workers/metabolism-worker-entry.ts',
      'src/daemon.ts',
      'src/tools/prepare.ts',
    ]);
  });
});
