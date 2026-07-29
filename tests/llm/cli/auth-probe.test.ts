import {
  parseClaudeAuth,
  parseCodexAuth,
  probeCliAuth,
} from '../../../src/llm/cli/auth-probe.js';
import { CliLLMError } from '../../../src/llm/cli/errors.js';

describe('CLI auth probes', () => {
  it('accepts Claude first-party OAuth without retaining account plaintext in scope', () => {
    const identity = parseClaudeAuth(JSON.stringify({
      loggedIn: true,
      authMethod: 'oauth',
      apiProvider: 'firstParty',
      email: 'User@Example.com',
    }));
    expect(identity.accountIdentifier).toBe('user@example.com');
    expect(identity.accountScope).toMatch(/^claude-cli:[a-f0-9]{64}$/);
    expect(identity.accountScope).not.toContain('example.com');
  });

  it('rejects Claude API key and third-party auth', () => {
    expect(() => parseClaudeAuth(JSON.stringify({
      loggedIn: true,
      authMethod: 'apiKey',
      apiProvider: 'bedrock',
    }))).toThrowError(expect.objectContaining({ kind: 'wrong_auth_method' }) as CliLLMError);
  });

  it('accepts only ChatGPT-managed Codex login', () => {
    expect(parseCodexAuth('Logged in using ChatGPT').accountScope).toBe('codex-cli:local-login');
    expect(() => parseCodexAuth('Not logged in using ChatGPT')).toThrowError(
      expect.objectContaining({ kind: 'not_authenticated' }) as CliLLMError,
    );
    expect(() => parseCodexAuth('Logged in using an API key')).toThrowError(
      expect.objectContaining({ kind: 'wrong_auth_method' }) as CliLLMError,
    );
  });

  it('accepts Codex login status emitted on stderr', async () => {
    const identity = await probeCliAuth(
      {
        kind: 'codex',
        path: '/usr/local/bin/codex',
        version: '1.0.0',
        controlledPath: '/usr/bin:/bin',
        source: 'known_path',
        identity: { device: 1, inode: 1, size: 1, ctimeMs: 1, sha256: 'fixture' },
      },
      {},
      async () => ({
        stdout: '',
        stderr: 'Logged in using ChatGPT\n',
        exitCode: 0,
      }),
    );
    expect(identity.method).toBe('chatgpt');
  });
});
