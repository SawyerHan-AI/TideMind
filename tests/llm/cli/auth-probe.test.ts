import {
  codexIdentityFromAccount,
  parseClaudeAuth,
  parseCodexAuth,
  probeCliAuth,
} from '../../../src/llm/cli/auth-probe.js';
import { CliLLMError } from '../../../src/llm/cli/errors.js';

describe('CLI auth probes', () => {
  it('treats Claude 2.1.x subscription login (claude.ai + orgId) as a known scope without plaintext', () => {
    const identity = parseClaudeAuth(JSON.stringify({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      email: 'Fixture@Xinghai.example',
      orgId: 'org-xinghai-0001',
      orgName: '星海科技',
      subscriptionType: 'max',
    }));
    expect(identity).toMatchObject({
      providerType: 'claude-cli',
      method: 'claude.ai',
      accountIdentifier: 'fixture@xinghai.example',
      scopeState: 'known',
      scopeLabel: 'max',
    });
    expect(identity.scopeKey).toMatch(/^claude-cli:[a-f0-9]{64}$/);
    expect(identity.accountScope).toBe(identity.scopeKey);
    for (const secret of ['xinghai', 'org-xinghai-0001', 'fixture']) {
      expect(identity.scopeKey).not.toContain(secret);
    }

    // Same org, different user email → different scope key (org + email hash).
    const other = parseClaudeAuth(JSON.stringify({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      email: 'another@xinghai.example',
      orgId: 'org-xinghai-0001',
    }));
    expect(other.scopeState).toBe('known');
    expect(other.scopeKey).not.toBe(identity.scopeKey);
    // Different org → different scope key.
    const otherOrg = parseClaudeAuth(JSON.stringify({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      email: 'Fixture@Xinghai.example',
      orgId: 'org-datapilot-0002',
    }));
    expect(otherOrg.scopeKey).not.toBe(identity.scopeKey);
  });

  it('keeps an email-only Claude login in the unknown scope (email is not an entitlement scope)', () => {
    const identity = parseClaudeAuth(JSON.stringify({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      email: 'fixture@datapilot.example',
    }));
    expect(identity).toMatchObject({
      scopeState: 'unknown',
      scopeKey: 'claude-cli:unknown',
      accountScope: 'claude-cli:local-login',
      accountIdentifier: 'fixture@datapilot.example',
    });
  });

  it('still accepts the legacy oauth / subscription method names (unknown scope without orgId)', () => {
    for (const authMethod of ['oauth', 'subscription', 'OAuth']) {
      const identity = parseClaudeAuth(JSON.stringify({
        loggedIn: true,
        authMethod,
        apiProvider: 'firstParty',
        email: 'fixture@example.com',
      }));
      expect(identity.scopeState, authMethod).toBe('unknown');
      expect(identity.method).toBe(authMethod.toLowerCase());
    }
    const withOrg = parseClaudeAuth(JSON.stringify({
      loggedIn: true,
      authMethod: 'oauth',
      apiProvider: 'firstParty',
      orgId: 'org-legacy',
    }));
    expect(withOrg.scopeState).toBe('known');
  });

  it('rejects Claude oauth_token / API key / non-first-party providers and logged-out status', () => {
    for (const status of [
      { loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty' },
      { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' },
      { loggedIn: true, authMethod: 'api_key_helper', apiProvider: 'firstParty' },
      { loggedIn: true, authMethod: 'third_party', apiProvider: 'gateway' },
      { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'bedrock', orgId: 'org-1' },
      { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'vertex', orgId: 'org-1' },
    ]) {
      expect(() => parseClaudeAuth(JSON.stringify(status)), JSON.stringify(status))
        .toThrowError(expect.objectContaining({ kind: 'wrong_auth_method' }) as CliLLMError);
    }
    expect(() => parseClaudeAuth(JSON.stringify({ loggedIn: false, authMethod: 'none' })))
      .toThrowError(expect.objectContaining({ kind: 'not_authenticated' }) as CliLLMError);
    expect(() => parseClaudeAuth('{not json'))
      .toThrowError(expect.objectContaining({ kind: 'protocol' }) as CliLLMError);
  });

  it('rejects Claude API key and third-party auth', () => {
    expect(() => parseClaudeAuth(JSON.stringify({
      loggedIn: true,
      authMethod: 'apiKey',
      apiProvider: 'bedrock',
    }))).toThrowError(expect.objectContaining({ kind: 'wrong_auth_method' }) as CliLLMError);
  });

  it('accepts only ChatGPT-managed Codex login', () => {
    expect(parseCodexAuth('Logged in using ChatGPT')).toMatchObject({
      accountScope: 'codex-cli:local-login',
      scopeState: 'unknown',
      scopeKey: 'codex-cli:unknown',
    });
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

  it('derives a Codex identity from account/read without keeping plaintext in the scope key', () => {
    const identity = codexIdentityFromAccount({
      kind: 'chatgpt',
      accountId: 'acct-datapilot-42',
      email: 'fixture@datapilot.example',
      planType: 'pro',
    });
    expect(identity).toMatchObject({
      providerType: 'codex-cli',
      method: 'chatgpt',
      scopeState: 'known',
      scopeLabel: 'pro',
    });
    expect(identity.scopeKey).toMatch(/^codex-cli:[a-f0-9]{64}$/);
    expect(identity.scopeKey).not.toContain('datapilot');
    expect(codexIdentityFromAccount({
      kind: 'chatgpt', accountId: 'acct-xinghai-7', email: 'fixture@datapilot.example', planType: 'pro',
    }).scopeKey).not.toBe(identity.scopeKey);
    // No workspace account id → unknown scope.
    expect(codexIdentityFromAccount({
      kind: 'chatgpt', accountId: null, email: 'fixture@datapilot.example', planType: 'plus',
    })).toMatchObject({ scopeState: 'unknown', scopeKey: 'codex-cli:unknown' });
    expect(() => codexIdentityFromAccount({ kind: 'none', requiresOpenaiAuth: true }))
      .toThrowError(expect.objectContaining({ kind: 'not_authenticated' }) as CliLLMError);
    expect(() => codexIdentityFromAccount({ kind: 'api_key' }))
      .toThrowError(expect.objectContaining({ kind: 'wrong_auth_method' }) as CliLLMError);
    expect(() => codexIdentityFromAccount({ kind: 'other', type: 'amazonBedrock' }))
      .toThrowError(expect.objectContaining({ kind: 'wrong_auth_method' }) as CliLLMError);
  });
});
