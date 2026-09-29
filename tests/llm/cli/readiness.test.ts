import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authStoreSignal,
  checkCliEnvironment,
  clearCodexAccountCache,
} from '../../../src/llm/cli/readiness.js';
import { prepareCodexToolCatalog } from '../../../src/llm/cli/codex-tool-catalog.js';
vi.mock('../../../src/llm/cli/codex-tool-catalog.js', () => ({ prepareCodexToolCatalog: vi.fn(async () => '{"models":[]}') }));
import { CODEX_EXEC_CONFIG_OVERRIDES } from '../../../src/llm/cli/catalogs.js';
import { CliLLMError } from '../../../src/llm/cli/errors.js';
import type { readCodexMetadata } from '../../../src/llm/cli/codex-app-server.js';

const fakeCli = resolve(fileURLToPath(new URL('../../fixtures/llm-cli/fake-cli.mjs', import.meta.url)));
const features01561 = readFileSync(fileURLToPath(new URL(
  '../../fixtures/llm-cli/codex-0.156.1-features.txt', import.meta.url,
)), 'utf8');
const features01561Disabled = readFileSync(fileURLToPath(new URL(
  '../../fixtures/llm-cli/codex-0.156.1-features-disabled.txt', import.meta.url,
)), 'utf8').replace(/^unified_exec\s+(.+?)\s+true$/m, 'unified_exec $1 false');
// Successful readiness fixtures model a CLI that really disables shell execution.

const EXEC_HELP = '--ignore-user-config --ignore-rules --ephemeral --json --skip-git-repo-check --strict-config';
const CLAUDE_HELP = [
  '-p, --print', '--safe-mode', '--tools <tools...>', 'Use "" to disable all tools',
  '--disable-slash-commands', '--no-session-persistence', '--strict-mcp-config',
  '--output-format <format>', '--system-prompt-file',
].join('\n');

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => clearCodexAccountCache());

function trustedHome(kind: 'codex' | 'claude'): { home: string; executable: string } {
  const home = mkdtempSync(join(homedir(), '.tidemind-readiness-'));
  tempDirs.push(home);
  const executable = join(home, kind);
  copyFileSync(fakeCli, executable);
  chmodSync(executable, 0o700);
  return { home, executable };
}

type ExecCall = { args: readonly string[] };

function codexExec(options: { effective?: string; versionOutput?: string } = {}) {
  const calls: ExecCall[] = [];
  const exec = vi.fn(async (_file: string, args: readonly string[]) => {
    calls.push({ args });
    if (args[0] === 'exec' && args[1] === '--help') return { stdout: EXEC_HELP, stderr: '', exitCode: 0 };
    if (args[0] === 'debug') return { stdout: 'Usage: codex debug prompt-input', stderr: '', exitCode: 0 };
    if (args.length === 2 && args[0] === 'features') return { stdout: features01561, stderr: '', exitCode: 0 };
    if (args.at(-2) === 'features' && args.at(-1) === 'list') {
      return { stdout: options.effective ?? features01561Disabled, stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: 'unexpected', exitCode: 2 };
  });
  return { exec, calls };
}

function resolveOptions(executable: string, version: string) {
  return {
    candidates: [executable],
    exec: async () => ({ stdout: version, stderr: '' }),
  };
}

const CHATGPT = { kind: 'chatgpt' as const, accountId: 'acct-xinghai', email: 'fixture@xinghai.example', planType: 'pro' };

describe('checkCliEnvironment — Codex execution contract and identity', () => {
  it('reads back the effective features with every --disable plus the inference overrides', async () => {
    const { home, executable } = trustedHome('codex');
    const { exec, calls } = codexExec();
    const readCodexAccount = vi.fn(async () => ({ account: CHATGPT, accountAfter: null, models: null }));
    const environment = await checkCliEnvironment({
      providerType: 'codex-cli',
      homeDir: home,
      sourceEnv: { HOME: home },
      dataDir: home,
      platform: 'darwin',
      resolveOptions: resolveOptions(executable, 'codex-cli 0.156.1'),
      exec,
      readCodexAccount: readCodexAccount as unknown as typeof readCodexMetadata,
    });
    expect(readCodexAccount).toHaveBeenCalledWith(expect.objectContaining({ includeModels: false, dataDir: home }));
    expect(environment.auth).toMatchObject({ scopeState: 'known', method: 'chatgpt', scopeLabel: 'pro' });
    expect(environment.codexContract).toMatchObject({
      cliVersion: '0.156.1',
      residualFeatures: [
        'item_ids', 'resize_all_images', 'terminal_resize_reflow',
        'tool_search_always_defer_mcp_tools', 'tui_app_server',
      ],
    });
    // Every listed feature except already-off deprecated flags (4 in the 0.156.1 fixture).
    expect(environment.codexContract!.disableFeatures).toHaveLength(146);
    const readback = calls.find(call => call.args.at(-1) === 'list' && call.args.length > 2)!;
    const disables = environment.codexContract!.disableFeatures.flatMap(name => ['--disable', name]);
    expect(readback.args).toEqual([...disables, ...CODEX_EXEC_CONFIG_OVERRIDES, 'features', 'list']);
    expect(environment.cliGeneration).toMatch(/^[a-f0-9]{64}$/);
    expect(environment.validationFingerprint).toBe(environment.cliGeneration);
    expect(environment.authStoreSignal).toBeNull();
  }, 30_000);

  it('cli generation is stable for the same binary/contract and changes with the version', async () => {
    const { home, executable } = trustedHome('codex');
    const run = (version: string) => checkCliEnvironment({
      providerType: 'codex-cli',
      homeDir: home,
      sourceEnv: { HOME: home },
      dataDir: home,
      platform: 'darwin',
      resolveOptions: resolveOptions(executable, `codex-cli ${version}`),
      exec: codexExec().exec,
      readCodexAccount: (async () => ({ account: CHATGPT, accountAfter: null, models: null })) as never,
    });
    const a = await run('0.156.1');
    const b = await run('0.156.1');
    const c = await run('0.157.0');
    expect(a.cliGeneration).toBe(b.cliGeneration);
    expect(c.cliGeneration).not.toBe(a.cliGeneration);
    expect(a.authFingerprint).toBe(c.authFingerprint);
  }, 30_000);

  it('blocks when an unreviewed feature stays enabled after --disable', async () => {
    const { home, executable } = trustedHome('codex');
    const effective = `${features01561Disabled.replace(/^hooks_v2(\s+\S+\s+)false$/m, 'hooks_v2$1true')}`;
    expect(effective).toMatch(/^hooks_v2\s+stable\s+true$/m);
    await expect(checkCliEnvironment({
      providerType: 'codex-cli',
      homeDir: home,
      sourceEnv: { HOME: home },
      dataDir: home,
      platform: 'darwin',
      resolveOptions: resolveOptions(executable, 'codex-cli 0.156.1'),
      exec: codexExec({ effective }).exec,
      readCodexAccount: (async () => ({ account: CHATGPT, accountAfter: null, models: null })) as never,
    })).rejects.toMatchObject({ kind: 'unsupported_version', message: expect.stringContaining('hooks_v2') });
  }, 30_000);

  it('falls back to `login status` with an unknown scope when the metadata session fails', async () => {
    const { home, executable } = trustedHome('codex');
    const environment = await checkCliEnvironment({
      providerType: 'codex-cli',
      homeDir: home,
      sourceEnv: { HOME: home },
      dataDir: home,
      platform: 'darwin',
      resolveOptions: resolveOptions(executable, 'codex-cli 0.156.1'),
      exec: codexExec().exec,
      readCodexAccount: (async () => { throw new CliLLMError('timeout', 'metadata timed out'); }) as never,
    });
    expect(environment.auth).toMatchObject({
      scopeState: 'unknown',
      scopeKey: 'codex-cli:unknown',
      accountScope: 'codex-cli:local-login',
    });
  }, 30_000);

  it('propagates not_authenticated / wrong_auth_method from account/read without falling back', async () => {
    const { home, executable } = trustedHome('codex');
    const base = {
      providerType: 'codex-cli' as const,
      homeDir: home,
      sourceEnv: { HOME: home },
      dataDir: home,
      platform: 'darwin' as const,
      resolveOptions: resolveOptions(executable, 'codex-cli 0.156.1'),
      exec: codexExec().exec,
    };
    await expect(checkCliEnvironment({
      ...base,
      readCodexAccount: (async () => ({ account: { kind: 'none', requiresOpenaiAuth: true }, accountAfter: null, models: null })) as never,
    })).rejects.toMatchObject({ kind: 'not_authenticated' });
    await expect(checkCliEnvironment({
      ...base,
      readCodexAccount: (async () => ({ account: { kind: 'api_key' }, accountAfter: null, models: null })) as never,
    })).rejects.toMatchObject({ kind: 'wrong_auth_method' });
  }, 30_000);

  it('caches a known identity only while the auth-store signal is unchanged', async () => {
    const { home, executable } = trustedHome('codex');
    mkdirSync(join(home, '.codex'));
    const authFile = join(home, '.codex', 'auth.json');
    writeFileSync(authFile, '{"fixture":true}');
    const readCodexAccount = vi.fn(async () => ({ account: CHATGPT, accountAfter: null, models: null }));
    const run = (freshAuth = false) => checkCliEnvironment({
      providerType: 'codex-cli',
      homeDir: home,
      sourceEnv: { HOME: home },
      dataDir: home,
      platform: 'darwin',
      resolveOptions: resolveOptions(executable, 'codex-cli 0.156.1'),
      exec: codexExec().exec,
      readCodexAccount: readCodexAccount as never,
      freshAuth,
    });
    const first = await run();
    expect(first.authStoreSignal).toMatch(/^store-0:\d+:\d+:\d+$/);
    await run();
    expect(readCodexAccount).toHaveBeenCalledTimes(1);
    utimesSync(authFile, new Date(), new Date(Date.now() + 60_000));
    const third = await run();
    expect(third.authStoreSignal).not.toBe(first.authStoreSignal);
    expect(readCodexAccount).toHaveBeenCalledTimes(2);
    await run(true);
    expect(readCodexAccount).toHaveBeenCalledTimes(3);
  }, 30_000);

  it('only macOS is supported in this release', async () => {
    await expect(checkCliEnvironment({ providerType: 'codex-cli', platform: 'linux' }))
      .rejects.toMatchObject({ kind: 'unsupported_version' });
  });
});

describe('checkCliEnvironment — Claude Code', () => {
  it('uses auth status (legacy oauth fixture → unknown scope) and a help-stable generation', async () => {
    const { home, executable } = trustedHome('claude');
    const exec = vi.fn(async (_file: string, args: readonly string[]) => (
      args[0] === '--help'
        ? { stdout: `${CLAUDE_HELP}\nrandom banner ${Math.random()}`, stderr: '', exitCode: 0 }
        : { stdout: 'claude auth status [--json]', stderr: '', exitCode: 0 }
    ));
    const run = () => checkCliEnvironment({
      providerType: 'claude-cli',
      homeDir: home,
      sourceEnv: { HOME: home },
      platform: 'darwin',
      resolveOptions: resolveOptions(executable, '2.1.280 (Claude Code)'),
      exec,
    });
    const a = await run();
    const b = await run();
    expect(a.auth).toMatchObject({ providerType: 'claude-cli', method: 'oauth', scopeState: 'unknown' });
    expect(a.codexContract).toBeUndefined();
    // Unrelated help text changes do not change the generation (design §6).
    expect(a.cliGeneration).toBe(b.cliGeneration);
  }, 30_000);
});

describe('authStoreSignal', () => {
  it('is a non-secret stat signal and null for keychain-only stores', () => {
    const home = mkdtempSync(join(homedir(), '.tidemind-readiness-'));
    tempDirs.push(home);
    expect(authStoreSignal('claude-cli', home)).toBeNull();
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude', '.credentials.json'), '{"secret":"never-read"}');
    const signal = authStoreSignal('claude-cli', home)!;
    expect(signal).toMatch(/^store-0:\d+:\d+:\d+$/);
    expect(signal).not.toContain('never-read');
    expect(authStoreSignal('codex-cli', home)).toBeNull();
  });
});
