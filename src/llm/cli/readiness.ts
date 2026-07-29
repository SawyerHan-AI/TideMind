import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { CLI_MODEL_CATALOGS } from './catalogs.js';
import { probeCliAuth } from './auth-probe.js';
import { CliLLMError } from './errors.js';
import { sanitizeCliEnvironment } from './environment.js';
import { gateCodexCapabilities, type CodexCapabilityGateResult } from './gate-codex.js';
import { gateClaudeCapabilities } from './gate-claude.js';
import { resolveCli, type ResolveCliOptions } from './resolve-cli.js';
import type {
  CliAuthIdentity,
  CliKind,
  CliProviderType,
  ResolvedCli,
} from './types.js';

type ProbeExec = (
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

const defaultExec: ProbeExec = (executable, args, env, signal) =>
  new Promise(resolve => {
    execFile(
      executable,
      [...args],
      {
        env,
        timeout: 8_000,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
        shell: false,
        signal,
      },
      (error, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          exitCode: error && typeof error.code === 'number' ? error.code : error ? -1 : 0,
        });
      },
    );
  });

export interface CliEnvironmentCheck {
  providerType: CliProviderType;
  status: 'untested';
  resolved: ResolvedCli;
  auth: CliAuthIdentity;
  authFingerprint: string;
  validationFingerprint: string;
  capabilityFingerprint: string;
  capabilityStatus: 'verified';
  candidateModels: string[];
  codexGate?: CodexCapabilityGateResult;
  checkedAt: string;
}

export interface CheckCliEnvironmentOptions {
  providerType: CliProviderType;
  allowLoginShell?: boolean;
  sourceEnv?: NodeJS.ProcessEnv;
  homeDir?: string;
  resolveOptions?: Partial<ResolveCliOptions>;
  exec?: ProbeExec;
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
}

function kindForProvider(providerType: CliProviderType): CliKind {
  return providerType === 'claude-cli' ? 'claude' : 'codex';
}

function authStoreStat(providerType: CliProviderType, home: string): string | null {
  const candidates = providerType === 'codex-cli'
    ? [join(home, '.codex', 'auth.json')]
    : [
        join(home, '.claude', '.credentials.json'),
        join(home, '.config', 'claude', 'credentials.json'),
      ];
  for (const [index, candidate] of candidates.entries()) {
    try {
      const stat = lstatSync(candidate);
      if (!stat.isFile()) continue;
      return [
        `store-${index}`,
        stat.ino,
        stat.size,
        Math.trunc(stat.mtimeMs),
      ].join(':');
    } catch {
      // Keychain-only auth or absent file is expected.
    }
  }
  return null;
}

function digest(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export async function checkCliEnvironment(
  options: CheckCliEnvironmentOptions,
): Promise<CliEnvironmentCheck> {
  const throwIfAborted = (): void => {
    if (options.signal?.aborted) {
      throw new CliLLMError('aborted', 'CLI 环境检查已取消', {
        cause: options.signal.reason,
      });
    }
  };
  throwIfAborted();
  const actualPlatform = options.platform ?? platform();
  if (actualPlatform !== 'darwin') {
    throw new CliLLMError('unsupported_version', '本机订阅连接首版仅支持 macOS', {
      needsUserAction: true,
    });
  }
  const kind = kindForProvider(options.providerType);
  const sourceEnv = options.sourceEnv ?? process.env;
  const home = options.homeDir ?? sourceEnv.HOME ?? homedir();
  const resolved = await resolveCli({
    kind,
    allowLoginShell: options.allowLoginShell,
    homeDir: home,
    env: sourceEnv,
    signal: options.signal,
    ...options.resolveOptions,
  });
  throwIfAborted();
  let auth: CliAuthIdentity;
  try {
    auth = await probeCliAuth(resolved, sourceEnv, undefined, options.signal);
  } catch (error) {
    throwIfAborted();
    throw error;
  }
  throwIfAborted();
  const exec = options.exec ?? defaultExec;
  const env = sanitizeCliEnvironment(sourceEnv, resolved.path, resolved.controlledPath);
  let capabilityFingerprint: string;
  let codexGate: CodexCapabilityGateResult | undefined;

  if (kind === 'claude') {
    const [help, authStatusHelp] = await Promise.all([
      exec(resolved.path, ['--help'], env, options.signal),
      exec(resolved.path, ['auth', 'status', '--help'], env, options.signal),
    ]);
    throwIfAborted();
    if (help.exitCode !== 0 || authStatusHelp.exitCode !== 0) {
      throw new CliLLMError('unsupported_version', 'Claude CLI capability probe failed', {
        needsUserAction: true,
      });
    }
    capabilityFingerprint = gateClaudeCapabilities({
      version: resolved.version,
      help: `${help.stdout}\n${help.stderr}`,
      authStatusHelp: `${authStatusHelp.stdout}\n${authStatusHelp.stderr}`,
    }).fingerprint;
  } else {
    const [execHelp, promptHelp, features] = await Promise.all([
      exec(resolved.path, ['exec', '--help'], env, options.signal),
      exec(resolved.path, ['debug', 'prompt-input', '--help'], env, options.signal),
      exec(resolved.path, ['features', 'list'], env, options.signal),
    ]);
    throwIfAborted();
    if (execHelp.exitCode !== 0 || promptHelp.exitCode !== 0 || features.exitCode !== 0) {
      throw new CliLLMError('unsupported_version', 'Codex CLI capability probe failed', {
        needsUserAction: true,
      });
    }
    codexGate = gateCodexCapabilities({
      version: resolved.version,
      execHelp: `${execHelp.stdout}\n${execHelp.stderr}`,
      promptInputHelp: `${promptHelp.stdout}\n${promptHelp.stderr}`,
      featuresList: `${features.stdout}\n${features.stderr}`,
    });
    capabilityFingerprint = codexGate.fingerprint;
  }

  const storeStat = authStoreStat(options.providerType, home);
  const authFingerprint = digest([
    options.providerType,
    resolved.path,
    resolved.version,
    resolved.identity,
    auth.method,
    auth.accountIdentifier,
    storeStat,
  ]);
  const validationFingerprint = digest([
    options.providerType,
    resolved.path,
    resolved.version,
    resolved.identity,
    authFingerprint,
    capabilityFingerprint,
  ]);
  return {
    providerType: options.providerType,
    status: 'untested',
    resolved,
    auth,
    authFingerprint,
    validationFingerprint,
    capabilityFingerprint,
    capabilityStatus: 'verified',
    candidateModels: [...CLI_MODEL_CATALOGS[options.providerType]],
    codexGate,
    checkedAt: new Date().toISOString(),
  };
}

export function cliUserActionCommand(
  providerType: CliProviderType,
  kind: string,
): string | undefined {
  if (kind === 'not_installed') {
    return providerType === 'claude-cli'
      ? 'claude --version'
      : 'codex --version';
  }
  if (kind === 'not_authenticated' || kind === 'wrong_auth_method') {
    return providerType === 'claude-cli'
      ? 'claude auth status --json'
      : 'codex login status';
  }
  return undefined;
}
