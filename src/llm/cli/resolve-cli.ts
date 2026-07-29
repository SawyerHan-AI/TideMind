import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  constants,
  createReadStream,
  existsSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { CliLLMError } from './errors.js';
import { sanitizeCliEnvironment } from './environment.js';
import type { CliKind, ResolvedCli } from './types.js';

const PROBE_TIMEOUT_MS = 5_000;
const MAX_PROBE_BYTES = 64 * 1024;

export interface ResolveCliOptions {
  kind: CliKind;
  allowLoginShell?: boolean;
  developmentOverride?: string;
  allowDevelopmentOverride?: boolean;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  uid?: number;
  signal?: AbortSignal;
  candidates?: readonly string[];
  exec?: (
    file: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; timeoutMs: number; maxBytes: number; signal?: AbortSignal },
  ) => Promise<{ stdout: string; stderr: string }>;
}

function knownCandidates(kind: CliKind, home: string): string[] {
  const names = kind === 'claude'
    ? [
        join(home, '.local', 'bin', 'claude'),
        join(home, '.claude', 'local', 'claude'),
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude',
        '/opt/local/bin/claude',
      ]
    : [
        join(home, '.local', 'bin', 'codex'),
        join(home, '.npm-global', 'bin', 'codex'),
        join(home, 'Library', 'pnpm', 'codex'),
        '/opt/homebrew/bin/codex',
        '/usr/local/bin/codex',
        '/opt/local/bin/codex',
        '/Applications/Codex.app/Contents/Resources/codex',
      ];
  return names;
}

const defaultExec: NonNullable<ResolveCliOptions['exec']> = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBytes,
        encoding: 'utf8',
        shell: false,
        signal: options.signal,
      },
      (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      },
    );
  });

export function parseCliVersion(kind: CliKind, output: string): string | null {
  const normalized = output.trim();
  const pattern = kind === 'claude'
    ? /(?:claude(?:\s+code)?\s+)?v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/i
    : /(?:codex(?:-cli)?\s+)?v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/i;
  return pattern.exec(normalized)?.[1] ?? null;
}

function validateParentChain(real: string, uid: number): void {
  let current = dirname(real);
  while (current !== dirname(current)) {
    const stat = statSync(current);
    if (!stat.isDirectory() || (stat.uid !== uid && stat.uid !== 0)) {
      throw new CliLLMError('permission_policy', 'CLI parent directory owner is not trusted');
    }
    const trustedStickyRoot = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (
      ((stat.mode & 0o002) !== 0 && !trustedStickyRoot) ||
      ((stat.mode & 0o020) !== 0 && stat.uid !== uid)
    ) {
      throw new CliLLMError('permission_policy', 'CLI parent directory is writable by an untrusted user');
    }
    current = dirname(current);
  }
}

function validateExecutable(candidate: string, uid: number): string {
  if (!isAbsolute(candidate)) throw new CliLLMError('not_installed', 'CLI path is not absolute');
  const real = realpathSync(candidate);
  if (!isAbsolute(real)) throw new CliLLMError('not_installed', 'CLI realpath is not absolute');
  const stat = statSync(real);
  if (!stat.isFile()) throw new CliLLMError('not_installed', 'CLI path is not a regular file');
  if (stat.uid !== uid && stat.uid !== 0) {
    throw new CliLLMError('permission_policy', 'CLI executable owner is not trusted');
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new CliLLMError('permission_policy', 'CLI executable is group/world writable');
  }
  if ((stat.mode & 0o111) === 0) {
    throw new CliLLMError('permission_policy', 'CLI path is not executable');
  }
  validateParentChain(real, uid);
  return real;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function captureCliIdentity(path: string): Promise<ResolvedCli['identity']> {
  const before = statSync(path);
  const sha256 = await hashFile(path);
  const after = statSync(path);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.ctimeMs !== after.ctimeMs
  ) {
    throw new CliLLMError('permission_policy', 'CLI executable changed during validation');
  }
  return {
    device: after.dev,
    inode: after.ino,
    size: after.size,
    ctimeMs: after.ctimeMs,
    sha256,
  };
}

export async function assertResolvedCliIdentity(resolved: ResolvedCli): Promise<void> {
  const real = realpathSync(resolved.path);
  if (real !== resolved.path) {
    throw new CliLLMError('permission_policy', 'CLI executable path changed after validation');
  }
  const actual = await captureCliIdentity(real);
  const expected = resolved.identity;
  if (
    actual.device !== expected.device ||
    actual.inode !== expected.inode ||
    actual.size !== expected.size ||
    actual.ctimeMs !== expected.ctimeMs ||
    actual.sha256 !== expected.sha256
  ) {
    throw new CliLLMError('permission_policy', 'CLI executable changed after validation');
  }
}

function extractMarker(stdout: string, marker: string): string | null {
  const start = `<<TIDEMIND_CLI_${marker}_S>>`;
  const end = `<<TIDEMIND_CLI_${marker}_E>>`;
  const startIndex = stdout.indexOf(start);
  if (startIndex < 0) return null;
  const endIndex = stdout.indexOf(end, startIndex + start.length);
  if (endIndex < 0) return null;
  const value = stdout.slice(startIndex + start.length, endIndex).trim();
  if (!value.startsWith('/') || value.includes('\n')) return null;
  return value;
}

async function probeVersion(
  kind: CliKind,
  real: string,
  env: NodeJS.ProcessEnv,
  exec: NonNullable<ResolveCliOptions['exec']>,
  signal?: AbortSignal,
): Promise<string> {
  const result = await exec(real, ['--version'], {
    env: sanitizeCliEnvironment(env, real),
    timeoutMs: PROBE_TIMEOUT_MS,
    maxBytes: MAX_PROBE_BYTES,
    signal,
  });
  const version = parseCliVersion(kind, `${result.stdout}\n${result.stderr}`);
  if (!version) throw new CliLLMError('unsupported_version', `Cannot parse ${kind} CLI version`);
  return version;
}

export async function resolveCli(options: ResolveCliOptions): Promise<ResolvedCli> {
  const throwIfAborted = (): void => {
    if (options.signal?.aborted) {
      throw new CliLLMError('aborted', 'CLI resolver was cancelled', {
        cause: options.signal.reason,
      });
    }
  };
  throwIfAborted();
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const uid = options.uid ?? process.getuid?.() ?? userInfo().uid;
  const exec = options.exec ?? defaultExec;
  const candidates: Array<{ path: string; source: ResolvedCli['source'] }> = [];
  let lastSecurityError: CliLLMError | null = null;
  if (options.developmentOverride && options.allowDevelopmentOverride) {
    candidates.push({ path: options.developmentOverride, source: 'development_override' });
  }
  for (const path of options.candidates ?? knownCandidates(options.kind, home)) {
    if (existsSync(path)) candidates.push({ path, source: 'known_path' });
  }

  for (const candidate of candidates) {
    try {
      const real = validateExecutable(candidate.path, uid);
      const version = await probeVersion(options.kind, real, env, exec, options.signal);
      return {
        kind: options.kind,
        path: real,
        version,
        controlledPath: `${dirname(real)}:/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
        source: candidate.source,
        identity: await captureCliIdentity(real),
      };
    } catch (error) {
      throwIfAborted();
      if (error instanceof CliLLMError && error.kind === 'permission_policy') {
        lastSecurityError = error;
      }
      // Try the next trusted candidate.
    }
  }

  if (options.allowLoginShell) {
    let shell: string;
    try {
      shell = userInfo().shell || '/bin/sh';
    } catch {
      shell = '/bin/sh';
    }
    if (!isAbsolute(shell)) shell = '/bin/sh';
    const marker = randomBytes(12).toString('hex');
    const command = options.kind;
    const script =
      `printf '<<TIDEMIND_CLI_${marker}_S>>\\n%s\\n<<TIDEMIND_CLI_${marker}_E>>\\n' ` +
      `"$(command -v ${command})"`;
    try {
      const probe = await exec(shell, ['-ilc', script], {
        env: sanitizeCliEnvironment(env),
        timeoutMs: PROBE_TIMEOUT_MS,
        maxBytes: MAX_PROBE_BYTES,
        signal: options.signal,
      });
      const path = extractMarker(probe.stdout, marker);
      if (path) {
        const real = validateExecutable(path, uid);
        const version = await probeVersion(options.kind, real, env, exec, options.signal);
        return {
          kind: options.kind,
          path: real,
          version,
          controlledPath: `${dirname(real)}:/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
          source: 'login_shell',
          identity: await captureCliIdentity(real),
        };
      }
    } catch {
      throwIfAborted();
      // Report one stable, redacted error below.
    }
  }
  if (lastSecurityError) throw lastSecurityError;
  throw new CliLLMError('not_installed', `${options.kind} CLI was not found`);
}

export const RESOLVER_FILE_FLAGS = {
  noFollow: constants.O_NOFOLLOW,
};
