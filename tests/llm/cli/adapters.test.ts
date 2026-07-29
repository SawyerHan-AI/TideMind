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
import type { CodexCapabilityManifest } from '../../../src/llm/cli/catalogs.js';
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
      version: kind === 'claude' ? '2.1.215' : '0.145.0-alpha.18',
      controlledPath: `${dirname(process.execPath)}:${dataDir}:/usr/bin:/bin`,
      source: 'known_path' as const,
      identity: await captureCliIdentity(realExecutable),
    },
    runner: new CliChildProcessRunner(new CliProcessRegistry()),
  };
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

  it('Codex uses ignore-config/rules, disables reviewed features, and fails on tool events', async () => {
    const setupResult = await setup('codex');
    const manifest: CodexCapabilityManifest = {
      version: '0.145.0-alpha.18',
      requiredExecHelp: [],
      requiredPromptInputHelp: [],
      knownFeatures: {
        shell_tool: { stage: 'stable', enabled: true },
        apps: { stage: 'stable', enabled: true },
      },
      disableFeatures: ['shell_tool', 'apps'],
    };
    const adapter = new CodexCliAdapter({
      ...setupResult,
      manifest,
      preflight: () => undefined,
      sourceEnv: { HOME: setupResult.dataDir, USER: 'fixture', ANTHROPIC_API_KEY: 'no' },
      invocationId: () => 'codex12345',
    });
    const result = await adapter.run({ ...request, providerType: 'codex-cli' });
    const inspection = JSON.parse(result.text);
    expect(inspection.argv).toEqual(expect.arrayContaining([
      'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--json',
      '--skip-git-repo-check', '--strict-config', '-s', 'read-only',
      '--disable', 'shell_tool', '--disable', 'apps',
    ]));
    expect(inspection.argv.join(' ')).not.toContain('prompt secret');
    expect(inspection.stdin).toBe('prompt secret');
    expect(inspection.envKeys).not.toContain('ANTHROPIC_API_KEY');

    await expect(adapter.run({
      ...request,
      providerType: 'codex-cli',
      prompt: 'TOOL attempt',
    })).rejects.toMatchObject({ kind: 'permission_policy' });
  }, 20_000);

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
    'turns a post-commit %s quota failure into an ambiguous background outcome',
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
            ...common,
            manifest: {
              version: '0.145.0-alpha.18',
              requiredExecHelp: [],
              requiredPromptInputHelp: [],
              knownFeatures: {},
              disableFeatures: [],
            },
          });
      await expect(adapter.run({
        ...request,
        providerType: kind === 'claude' ? 'claude-cli' : 'codex-cli',
        prompt: 'QUOTA now',
        purpose: 'background',
      })).rejects.toMatchObject({ kind: 'ambiguous_outcome' });
    },
  );
});
