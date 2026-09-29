import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { CliLLMError } from './errors.js';
import { sanitizeCliEnvironment } from './environment.js';
import type { CodexAccountSnapshot } from './codex-app-server.js';
import type { CliAuthIdentity, CliKind, ResolvedCli } from './types.js';

type ProbeExec = (
  executable: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number; maxBytes: number; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

const defaultProbeExec: ProbeExec = (executable, args, options) =>
  new Promise((resolve) => {
    execFile(
      executable,
      [...args],
      {
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBytes,
        encoding: 'utf8',
        shell: false,
        signal: options.signal,
      },
      (error, stdout, stderr) => {
        if (error) {
          const exitCode = typeof error.code === 'number' ? error.code : -1;
          resolve({ stdout, stderr, exitCode });
        } else {
          resolve({ stdout, stderr, exitCode: 0 });
        }
      },
    );
  });

export async function probeCliAuth(
  resolved: ResolvedCli,
  sourceEnv: NodeJS.ProcessEnv = process.env,
  exec: ProbeExec = defaultProbeExec,
  signal?: AbortSignal,
): Promise<CliAuthIdentity> {
  const env = sanitizeCliEnvironment(sourceEnv, resolved.path, resolved.controlledPath);
  const args = resolved.kind === 'claude'
    ? ['auth', 'status', '--json']
    : ['login', 'status'];
  const result = await exec(resolved.path, args, {
    env,
    timeoutMs: 5_000,
    maxBytes: 64 * 1024,
    signal,
  });
  if (result.exitCode !== 0) {
    throw new CliLLMError('not_authenticated', `${resolved.kind} CLI is not logged in`, {
      needsUserAction: true,
    });
  }
  if (resolved.kind === 'claude') return parseClaudeAuth(result.stdout);
  // Current Codex writes the human-readable login status to stderr even on
  // exit 0. Treat both streams as protocol output; neither contains a token.
  return parseCodexAuth(`${result.stdout}\n${result.stderr}`);
}

export function parseClaudeAuth(stdout: string): CliAuthIdentity {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch (cause) {
    throw new CliLLMError('protocol', 'Claude auth status returned malformed JSON', { cause });
  }
  if (!value || typeof value !== 'object') throw new CliLLMError('protocol', 'Invalid Claude auth status');
  const status = value as Record<string, unknown>;
  if (status.loggedIn !== true) {
    throw new CliLLMError('not_authenticated', 'Claude CLI is not logged in', { needsUserAction: true });
  }
  const method = typeof status.authMethod === 'string' ? status.authMethod.trim().toLowerCase() : '';
  const provider = typeof status.apiProvider === 'string' ? status.apiProvider.trim().toLowerCase() : '';
  // Claude Code 2.1.x reports subscription login as authMethod "claude.ai" (with
  // email/orgId/subscriptionType). "oauth"/"subscription" are kept for older
  // builds. "oauth_token" cannot distinguish a setup-token subscription from a
  // third-party gateway bearer token and stays rejected: this change does not
  // widen the accepted billing path.
  if (
    !new Set(['claude.ai', 'oauth', 'subscription']).has(method) ||
    !new Set(['firstparty', 'first-party', 'anthropic']).has(provider)
  ) {
    throw new CliLLMError('wrong_auth_method', 'Claude CLI is not using subscription OAuth', {
      needsUserAction: true,
    });
  }
  const email = typeof status.email === 'string' && status.email.trim()
    ? status.email.trim().toLowerCase()
    : null;
  const orgId = typeof status.orgId === 'string' && status.orgId.trim()
    ? status.orgId.trim()
    : typeof status.accountId === 'string' && status.accountId.trim()
      ? status.accountId.trim()
      : null;
  const label = typeof status.subscriptionType === 'string'
    ? status.subscriptionType.slice(0, 64)
    : typeof status.orgName === 'string'
      ? status.orgName.slice(0, 64)
      : null;
  // Only an organization/account id identifies the permission scope; an email
  // alone distinguishes users but not the organization's model entitlements.
  return identity('claude-cli', method, email, orgId ? `${orgId}|${email ?? ''}` : null, label);
}

export function parseCodexAuth(stdout: string): CliAuthIdentity {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
  if (lines.some((line) => line === 'not logged in' || line.startsWith('not logged in ') || line === 'login required')) {
    throw new CliLLMError('not_authenticated', 'Codex CLI is not logged in', {
      needsUserAction: true,
    });
  }
  if (!lines.some((line) => line === 'logged in using chatgpt' || line === 'chatgpt managed')) {
    throw new CliLLMError('wrong_auth_method', 'Codex CLI is not using ChatGPT-managed auth', {
      needsUserAction: true,
    });
  }
  // `login status` carries no account identity: the scope stays unknown.
  return identity('codex-cli', 'chatgpt', null, null, null);
}

/** Build a Codex identity from the app-server account/read snapshot (no tokens). */
export function codexIdentityFromAccount(account: CodexAccountSnapshot): CliAuthIdentity {
  if (account.kind === 'none') {
    throw new CliLLMError('not_authenticated', 'Codex CLI is not logged in', { needsUserAction: true });
  }
  if (account.kind !== 'chatgpt') {
    throw new CliLLMError('wrong_auth_method', 'Codex CLI is not using ChatGPT-managed auth', {
      needsUserAction: true,
    });
  }
  return identity(
    'codex-cli',
    'chatgpt',
    account.email,
    account.accountId ? `${account.accountId}|${account.email ?? ''}` : null,
    account.planType,
  );
}

function identity(
  providerType: 'claude-cli' | 'codex-cli',
  method: string,
  identifier: string | null,
  scopeMaterial: string | null,
  scopeLabel: string | null,
): CliAuthIdentity {
  const scopeKey = scopeMaterial
    ? `${providerType}:${createHash('sha256').update(scopeMaterial).digest('hex')}`
    : `${providerType}:unknown`;
  return {
    providerType,
    method,
    accountIdentifier: identifier,
    accountScope: scopeMaterial ? scopeKey : `${providerType}:local-login`,
    scopeState: scopeMaterial ? 'known' : 'unknown',
    scopeKey,
    scopeLabel,
  };
}

export const AUTH_PROBE_KINDS: readonly CliKind[] = ['claude', 'codex'];
