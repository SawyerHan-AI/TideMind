import { gateClaudeCapabilities } from '../../../src/llm/cli/gate-claude.js';

const help = [
  '-p, --print',
  '--safe-mode',
  '--tools <tools...>',
  'Use "" to disable all tools',
  '--disable-slash-commands',
  '--no-session-persistence',
  '--strict-mcp-config',
  '--output-format <format>',
  '--system-prompt-file',
].join('\n');

describe('Claude capability gate', () => {
  it('accepts the complete safety surface', () => {
    expect(gateClaudeCapabilities({
      version: '2.1.215',
      help,
      authStatusHelp: 'Options: --json',
    }).fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('fails closed when a required flag or JSON auth probe disappears', () => {
    expect(() => gateClaudeCapabilities({
      version: '2.1.215',
      help: help.replace('--safe-mode', '--unsafe-mode'),
      authStatusHelp: '--json',
    })).toThrow();
    expect(() => gateClaudeCapabilities({
      version: '2.1.215',
      help,
      authStatusHelp: '--text',
    })).toThrow();
  });
});
