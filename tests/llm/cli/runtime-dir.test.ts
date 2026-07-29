import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cleanupStaleCliRuntimeDirectories,
  createCliRuntimeDirectory,
} from '../../../src/llm/cli/runtime-dir.js';

describe('CLI runtime directory', () => {
  it('creates private directories/files and cleans one invocation', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'tidemind-cli-runtime-'));
    const runtime = createCliRuntimeDirectory(dataDir, '12345678');
    const file = runtime.createPrivateFile('system.txt', 'private');
    expect(lstatSync(runtime.root).mode & 0o777).toBe(0o700);
    expect(lstatSync(runtime.invocationDir).mode & 0o777).toBe(0o700);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(() => runtime.createPrivateFile('system.txt', 'overwrite')).toThrow();
    runtime.cleanup();
    expect(() => lstatSync(runtime.invocationDir)).toThrow();
  });

  it('only removes old, strictly named direct children and rejects symlinks', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'tidemind-cli-clean-'));
    const old = createCliRuntimeDirectory(dataDir, 'old_12345678');
    utimesSync(old.invocationDir, new Date(0), new Date(0));
    mkdirSync(join(old.root, 'keep-me'), { mode: 0o700 });
    const sentinel = join(dataDir, 'sentinel');
    writeFileSync(sentinel, 'keep');
    expect(cleanupStaleCliRuntimeDirectories(dataDir, {
      olderThanMs: 1_000,
      now: Date.now(),
    })).toBe(1);
    expect(() => lstatSync(sentinel)).not.toThrow();

    const target = join(dataDir, 'target');
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, join(old.root, 'inv_symlink123'));
    expect(() => cleanupStaleCliRuntimeDirectories(dataDir, {
      olderThanMs: 0,
      now: Date.now(),
    })).toThrow(/unsafe stale runtime entry/);
    chmodSync(target, 0o700);
  });
});
