import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';

const INVOCATION_NAME = /^inv_[a-zA-Z0-9_-]{8,128}$/;

export interface CliRuntimeDirectory {
  root: string;
  invocationDir: string;
  createPrivateFile(name: 'system.txt' | 'schema.json' | 'mcp-empty.json', content: string): string;
  cleanup(): void;
}

function assertOwnedDirectory(path: string, uid: number): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('runtime path is not a directory');
  if (stat.uid !== uid || (stat.mode & 0o077) !== 0) {
    throw new Error('runtime directory owner/mode is unsafe');
  }
}

export function createCliRuntimeDirectory(
  dataDir: string,
  invocationId: string,
  uid = process.getuid?.() ?? 0,
): CliRuntimeDirectory {
  const safeName = `inv_${invocationId}`;
  if (!INVOCATION_NAME.test(safeName)) throw new Error('invalid CLI invocation id');
  const root = resolve(dataDir, 'runtime', 'llm-cli');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    // Correct a directory created under a permissive umask.
    const rootStat = statSync(root);
    if ((rootStat.mode & 0o077) !== 0) {
      throw new Error('CLI runtime root permissions are too broad');
    }
  } catch (error) {
    throw new Error('cannot validate CLI runtime root', { cause: error });
  }
  assertOwnedDirectory(root, uid);
  const invocationDir = join(root, safeName);
  mkdirSync(invocationDir, { mode: 0o700 });
  assertOwnedDirectory(invocationDir, uid);

  return {
    root,
    invocationDir,
    createPrivateFile(name, content) {
      if (!['system.txt', 'schema.json', 'mcp-empty.json'].includes(name)) {
        throw new Error('unsupported CLI runtime file');
      }
      const path = join(invocationDir, name);
      const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
      const fd = openSync(path, flags, 0o600);
      try {
        writeFileSync(fd, content, { encoding: 'utf8' });
      } finally {
        closeSync(fd);
      }
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
        throw new Error('CLI runtime file owner/mode is unsafe');
      }
      return path;
    },
    cleanup() {
      if (basename(invocationDir) === safeName && invocationDir.startsWith(`${root}/`)) {
        rmSync(invocationDir, { recursive: true, force: true });
      }
    },
  };
}

export function cleanupStaleCliRuntimeDirectories(
  dataDir: string,
  options: { olderThanMs: number; now?: number; uid?: number },
): number {
  const root = resolve(dataDir, 'runtime', 'llm-cli');
  if (!existsSync(root)) return 0;
  const uid = options.uid ?? process.getuid?.() ?? 0;
  assertOwnedDirectory(root, uid);
  let removed = 0;
  for (const name of readdirSync(root)) {
    if (!INVOCATION_NAME.test(name)) continue;
    const path = join(root, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
      throw new Error(`unsafe stale runtime entry: ${name}`);
    }
    if ((options.now ?? Date.now()) - stat.mtimeMs < options.olderThanMs) continue;
    rmSync(path, { recursive: true, force: true });
    removed++;
  }
  return removed;
}
