import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { prepareCodexToolCatalog } from './codex-tool-catalog.js';
import { CODEX_EXEC_CONFIG_OVERRIDES } from './catalogs.js';
import { codexIdentityFromAccount, probeCliAuth } from './auth-probe.js';
import { readCodexMetadata } from './codex-app-server.js';
import { CliLLMError } from './errors.js';
import { sanitizeCliEnvironment } from './environment.js';
import {
  codexDisableArgs,
  planCodexContract,
  verifyCodexContract,
  type CodexExecutionContract,
} from './gate-codex.js';
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
  /** Non-secret stat signal of the auth store; a re-probe trigger, never an identity. */
  authStoreSignal: string | null;
  /** Hash of method + scope key; changes only when the observed scope changes. */
  authFingerprint: string;
  /** CLI generation: path, version, binary identity and verified contract. */
  cliGeneration: string;
  /** Kept for the legacy column; equals cliGeneration. */
  validationFingerprint: string;
  capabilityFingerprint: string;
  capabilityStatus: 'verified';
  codexContract?: CodexExecutionContract;
  codexToolCatalogJson?: string;
  checkedAt: string;
}

export interface CheckCliEnvironmentOptions {
  providerType: CliProviderType;
  allowLoginShell?: boolean;
  sourceEnv?: NodeJS.ProcessEnv;
  homeDir?: string;
  /** Needed for the Codex account/read metadata session (private runtime dir). */
  dataDir?: string;
  resolveOptions?: Partial<ResolveCliOptions>;
  exec?: ProbeExec;
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
  /** Test seam for the Codex metadata session. */
  readCodexAccount?: typeof readCodexMetadata;
  /** Invocation boundaries must read the official account snapshot, never a TTL cache. */
  freshAuth?: boolean;
  prepareCodexCatalog?: typeof prepareCodexToolCatalog;
}

function kindForProvider(providerType: CliProviderType): CliKind {
  return providerType === 'claude-cli' ? 'claude' : 'codex';
}

export function authStoreSignal(providerType: CliProviderType, home: string): string | null {
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
  const storeSignal = authStoreSignal(options.providerType, home);
  let auth: CliAuthIdentity;
  try {
    auth = kind === 'codex'
      ? await probeCodexAuth(resolved, sourceEnv, storeSignal, options)
      : await probeCliAuth(resolved, sourceEnv, undefined, options.signal);
  } catch (error) {
    throwIfAborted();
    throw error;
  }
  throwIfAborted();
  const exec = options.exec ?? defaultExec;
  const env = sanitizeCliEnvironment(sourceEnv, resolved.path, resolved.controlledPath);
  let capabilityFingerprint: string;
  let codexContract: CodexExecutionContract | undefined;
  let codexToolCatalogJson: string | undefined;

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
    const evidence = {
      version: resolved.version,
      execHelp: `${execHelp.stdout}\n${execHelp.stderr}`,
      promptInputHelp: `${promptHelp.stdout}\n${promptHelp.stderr}`,
      featuresList: `${features.stdout}\n${features.stderr}`,
    };
    const { disableFeatures } = planCodexContract(evidence);
    // Read back the effective feature state with exactly the inference disables and
    // overrides; only this proves the disables took effect on this CLI generation.
    const effective = await exec(
      resolved.path,
      [...codexDisableArgs(disableFeatures), ...CODEX_EXEC_CONFIG_OVERRIDES, 'features', 'list'],
      env,
      options.signal,
    );
    throwIfAborted();
    if (effective.exitCode !== 0) {
      throw new CliLLMError('unsupported_version', 'Codex rejected the isolation overrides', {
        needsUserAction: true,
      });
    }
    codexContract = verifyCodexContract(
      evidence,
      disableFeatures,
      `${effective.stdout}\n${effective.stderr}`,
    );
    if (!options.dataDir) throw new CliLLMError('unsupported_version', 'Codex execution isolation requires a private runtime directory');
    codexToolCatalogJson = await (options.prepareCodexCatalog ?? prepareCodexToolCatalog)({
      resolved, contract: codexContract, dataDir: options.dataDir, sourceEnv, signal: options.signal,
    });
    capabilityFingerprint = codexContract.fingerprint;
  }

  const authFingerprint = digest([
    options.providerType,
    auth.method,
    auth.scopeKey,
  ]);
  const cliGeneration = digest([
    options.providerType,
    resolved.path,
    resolved.version,
    resolved.identity.sha256,
    capabilityFingerprint,
  ]);
  return {
    providerType: options.providerType,
    status: 'untested',
    resolved,
    auth,
    authStoreSignal: storeSignal,
    authFingerprint,
    cliGeneration,
    validationFingerprint: cliGeneration,
    capabilityFingerprint,
    capabilityStatus: 'verified',
    codexContract,
    codexToolCatalogJson,
    checkedAt: new Date().toISOString(),
  };
}

const CODEX_ACCOUNT_CACHE_MS = 5 * 60_000;
const codexAccountCache = new Map<string, { at: number; auth: CliAuthIdentity }>();

/** Test helper. */
export function clearCodexAccountCache(): void {
  codexAccountCache.clear();
}

/**
 * Codex identity from the official app-server account/read (no token refresh).
 * A known identity is cached briefly only while the file-based auth store signal and
 * the CLI binary are unchanged; Keychain-only stores (no signal) always re-read.
 * Older CLIs without account/read fall back to `login status` with an unknown scope.
 */
async function probeCodexAuth(
  resolved: ResolvedCli,
  sourceEnv: NodeJS.ProcessEnv,
  storeSignal: string | null,
  options: CheckCliEnvironmentOptions,
): Promise<CliAuthIdentity> {
  const cacheKey = storeSignal
    ? `${resolved.path}\0${resolved.identity.sha256}\0${storeSignal}`
    : null;
  const cached = cacheKey ? codexAccountCache.get(cacheKey) : undefined;
  if (!options.freshAuth && cached && Date.now() - cached.at < CODEX_ACCOUNT_CACHE_MS) return cached.auth;
  if (options.dataDir) {
    try {
      const metadata = await (options.readCodexAccount ?? readCodexMetadata)({
        resolved,
        dataDir: options.dataDir,
        includeModels: false,
        sourceEnv,
        signal: options.signal,
      });
      if (metadata.account) {
        const auth = codexIdentityFromAccount(metadata.account);
        if (cacheKey && auth.scopeState === 'known') {
          codexAccountCache.set(cacheKey, { at: Date.now(), auth });
        }
        return auth;
      }
    } catch (error) {
      if (
        error instanceof CliLLMError
        && (error.kind === 'not_authenticated' || error.kind === 'wrong_auth_method' || error.kind === 'aborted')
      ) {
        throw error;
      }
      // Metadata transport failed: fall through to the legacy status probe. The scope
      // is then unknown, which keeps unattended background inference closed.
    }
  }
  return probeCliAuth(resolved, sourceEnv, undefined, options.signal);
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
