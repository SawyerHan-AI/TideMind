import { chmodSync, copyFileSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeCliAdapter } from '../../../src/llm/cli/claude.js';
import { CodexCliAdapter } from '../../../src/llm/cli/codex.js';
import {
  CliChildProcessRunner,
  CliProcessRegistry,
} from '../../../src/llm/cli/child-process-runner.js';
import { readFileSync } from 'node:fs';
import { CODEX_EXEC_CONFIG_OVERRIDES } from '../../../src/llm/cli/catalogs.js';
import {
  planCodexContract,
  verifyCodexContract,
  type CodexExecutionContract,
} from '../../../src/llm/cli/gate-codex.js';
import { captureCliIdentity } from '../../../src/llm/cli/resolve-cli.js';

const fixture = resolve(
  fileURLToPath(new URL('../../fixtures/llm-cli/fake-cli.mjs', import.meta.url)),
);

async function setup(kind: 'claude' | 'codex') {
  const dataDir = mkdtempSync(join(tmpdir(), `tidemind-${kind}-adapter-`));
  const executable = join(dataDir, kind);
  copyFileSync(fixture, executable);
  chmodSync(executable, 0o700);
  const realExecutable = realpathSync(executable);
  return {
    dataDir,
    resolved: {
      kind,
      path: realExecutable,
      version: kind === 'claude' ? '2.1.215' : '0.153.4',
      controlledPath: `${dirname(process.execPath)}:${dataDir}:/usr/bin:/bin`,
      source: 'known_path' as const,
      identity: await captureCliIdentity(realExecutable),
    },
    runner: new CliChildProcessRunner(new CliProcessRegistry()),
  };
}

const codex01534Features = readFileSync(fileURLToPath(new URL(
  '../../fixtures/llm-cli/codex-0.153.4-features.txt',
  import.meta.url,
)), 'utf8');

function codexContract(version = '0.153.4'): CodexExecutionContract {
  const evidence = {
    version,
    execHelp: '--ignore-user-config --ignore-rules --ephemeral --json --skip-git-repo-check --strict-config',
    promptInputHelp: 'codex debug prompt-input',
    featuresList: codex01534Features,
  };
  const { disableFeatures } = planCodexContract(evidence);
  const effective = codex01534Features
    .split('\n')
    .filter(Boolean)
    .map((line) => line.replace(/true\s*$/, 'false'))
    .join('\n');
  return verifyCodexContract(evidence, disableFeatures, effective);
}

function indexOfSequence(haystack: readonly string[], needle: readonly string[]): number {
  for (let index = 0; index + needle.length <= haystack.length; index += 1) {
    if (needle.every((value, offset) => haystack[index + offset] === value)) return index;
  }
  return -1;
}

const request = {
  connectionId: 'mc_fixture',
  modelAlias: 'default',
  system: 'system secret',
  prompt: 'prompt secret',
  maxOutputTokens: 100,
  timeoutMs: 10_000,
  purpose: 'connection_test' as const,
};

describe('CLI adapters with fake executables', () => {
  it('Claude uses fixed safe argv, stdin, isolated cwd, and sanitized env', async () => {
    const setupResult = await setup('claude');
    const adapter = new ClaudeCliAdapter({
      ...setupResult,
      preflight: () => undefined,
      sourceEnv: {
        HOME: setupResult.dataDir,
        USER: 'fixture',
        OPENAI_API_KEY: 'must-not-leak',
        NODE_OPTIONS: '--require evil',
      },
      invocationId: () => 'claude1234',
    });
    const result = await adapter.run({ ...request, providerType: 'claude-cli' });
    const inspection = JSON.parse(result.text);
    expect(inspection.argv).toEqual(expect.arrayContaining([
      '-p', '--safe-mode', '--tools', '', '--disable-slash-commands',
      '--no-session-persistence', '--strict-mcp-config', '--output-format', 'json',
    ]));
    expect(inspection.argv.join(' ')).not.toContain('prompt secret');
    expect(inspection.argv.join(' ')).not.toContain('system secret');
    expect(inspection.stdin).toBe('prompt secret');
    expect(inspection.cwd).toContain('/runtime/llm-cli/inv_claude1234');
    expect(inspection.envKeys).not.toContain('OPENAI_API_KEY');
    expect(inspection.envKeys).not.toContain('NODE_OPTIONS');
  }, 20_000);

  it('Codex uses ignore-config/rules, disables every contract feature, applies overrides, and fails on tool events', async () => {
    const setupResult = await setup('codex');
    const contract = codexContract();
    expect(contract.disableFeatures.length).toBeGreaterThan(100);
    const adapter = new CodexCliAdapter({
      toolCatalogJson: JSON.stringify({ models: [{ slug: 'fixture', priority: 0, apply_patch_tool_type: null, experimental_supported_tools: [] }] }),
      ...setupResult,
      contract,
      preflight: () => undefined,
      sourceEnv: { HOME: setupResult.dataDir, USER: 'fixture', ANTHROPIC_API_KEY: 'no' },
      invocationId: () => 'codex12345',
    });
    const result = await adapter.run({ ...request, providerType: 'codex-cli' });
    const inspection = JSON.parse(result.text);
    const argv = inspection.argv as string[];
    expect(argv).toEqual(expect.arrayContaining([
      'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--json',
      '--skip-git-repo-check', '--strict-config', '-s', 'read-only',
      '--disable', 'shell_tool', '--disable', 'apps', '--disable', 'unified_exec',
    ]));
    // Every listed feature is disabled (not just the enabled subset), in contract order.
    expect(argv.flatMap((value, index) => (
      value === '--disable' ? [argv[index + 1]] : []
    ))).toEqual(contract.disableFeatures);
    // The shared static overrides are passed verbatim and contiguously.
    expect(indexOfSequence(argv, CODEX_EXEC_CONFIG_OVERRIDES)).toBeGreaterThan(-1);
    expect(argv.some((value) => value.startsWith('model_instructions_file='))).toBe(true);
    expect(argv.at(-1)).toBe('-');
    // follow_default passes no model argument.
    expect(argv).not.toContain('-m');
    expect(argv.join(' ')).not.toContain('prompt secret');
    expect(inspection.stdin).toBe('prompt secret');
    expect(inspection.envKeys).not.toContain('ANTHROPIC_API_KEY');

    await expect(adapter.run({
      ...request,
      providerType: 'codex-cli',
      prompt: 'TOOL attempt',
    })).rejects.toMatchObject({ kind: 'permission_policy' });
  }, 30_000);

  it('Codex passes a pinned model id as one independent argv element', async () => {
    const setupResult = await setup('codex');
    const adapter = new CodexCliAdapter({
      toolCatalogJson: JSON.stringify({ models: [{ slug: 'fixture', priority: 0, apply_patch_tool_type: null, experimental_supported_tools: [] }] }),
      ...setupResult,
      contract: codexContract(),
      preflight: () => undefined,
      invocationId: () => 'codexpin01',
    });
    const result = await adapter.run({
      ...request,
      providerType: 'codex-cli',
      modelAlias: 'gpt-5.3-codex; echo pwned',
    });
    const argv = JSON.parse(result.text).argv as string[];
    const index = argv.indexOf('-m');
    expect(index).toBeGreaterThan(-1);
    expect(argv[index + 1]).toBe('gpt-5.3-codex; echo pwned');
  }, 30_000);

  it('Codex refuses a contract verified for a different CLI version', async () => {
    const setupResult = await setup('codex');
    expect(() => new CodexCliAdapter({
      toolCatalogJson: JSON.stringify({ models: [{ slug: 'fixture', priority: 0, apply_patch_tool_type: null, experimental_supported_tools: [] }] }),
      ...setupResult,
      contract: codexContract('0.156.1'),
      preflight: () => undefined,
    })).toThrowError(expect.objectContaining({ kind: 'unsupported_version' }));
  });

  it('turns corrupted post-commit background output into ambiguous outcome', async () => {
    const setupResult = await setup('claude');
    const adapter = new ClaudeCliAdapter({
      ...setupResult,
      preflight: () => undefined,
      invocationId: () => 'corrupt123',
    });
    await expect(adapter.run({
      ...request,
      providerType: 'claude-cli',
      prompt: 'CORRUPT result',
      purpose: 'background',
    })).rejects.toMatchObject({ kind: 'ambiguous_outcome' });
  });

  it.each(['claude', 'codex'] as const)(
    // An explicit provider refusal (quota) after prompt submission is a definite
    // failure: no result exists and a later retry cannot double-bill, so it must stay
    // model/connection scoped instead of pausing the connection as ambiguous.
    'keeps a post-commit %s quota refusal definite (not ambiguous)',
    async (kind) => {
      const setupResult = await setup(kind);
      const common = {
        ...setupResult,
        preflight: () => undefined,
        invocationId: () => `quota-${kind}`,
      };
      const adapter = kind === 'claude'
        ? new ClaudeCliAdapter(common)
        : new CodexCliAdapter({
      toolCatalogJson: JSON.stringify({ models: [{ slug: 'fixture', priority: 0, apply_patch_tool_type: null, experimental_supported_tools: [] }] }),
            ...common,
            contract: codexContract(),
          });
      await expect(adapter.run({
        ...request,
        providerType: kind === 'claude' ? 'claude-cli' : 'codex-cli',
        prompt: 'QUOTA now',
        purpose: 'background',
      })).rejects.toMatchObject({ kind: 'quota' });
    },
  );
});
