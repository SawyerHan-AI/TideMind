import { describe, expect, it } from 'vitest';
import { compareCodexMcpSemantics } from '../src/utils/codex-mcp-semantic.js';

const selector = 'mcp_servers.tidemind-synthetic';
const expected = `[${selector}]
enabled = true
command = "/synthetic/shim"
args = ["/synthetic/mcp.cjs"]
env = { EB_AGENT_ID = "synthetic", EB_ACTIVITY_GENERATION_TOKEN = "fixture-generation" }
`;
const nested = `[${selector}]
args = ['/synthetic/mcp.cjs']
command = '/synthetic/shim'

[${selector}.env]
EB_ACTIVITY_GENERATION_TOKEN = 'fixture-generation'
EB_AGENT_ID = 'synthetic'
`;

describe('Codex managed MCP semantic comparison', () => {
  it('keeps raw hashes separate while accepting the native Codex rewrite', () => {
    const result = compareCodexMcpSemantics(expected, nested, selector);
    expect(result.kind).toBe('equivalent');
    if (result.kind !== 'equivalent') throw new Error('expected equivalent');
    expect(result.expected.rawHash).not.toBe(result.observed.rawHash);
    expect(result.expected.semanticHash).toBe(result.observed.semanticHash);
    expect(result.observed.raw).toBe(nested);
    expect(compareCodexMcpSemantics(expected, expected, selector).kind).toBe('exact');
  });

  it('reads exactly the selector without treating neighboring user configuration as owned', () => {
    const doc = `model = "synthetic-model"\n[mcp_servers.other]\ncommand="other"\n${nested}\n[features]\nexample=true\n`;
    const result = compareCodexMcpSemantics(expected, doc, selector);
    expect(result.kind).toBe('equivalent');
    if (result.kind !== 'equivalent') throw new Error('expected equivalent');
    expect(result.observed.raw).toBe(nested);
  });

  it.each([
    nested.replace('args =', 'enabled = false\nargs ='),
    nested.replace('args =', 'enabled = "true"\nargs ='),
    nested.replace('args =', 'startup_timeout_sec = 60\nargs ='),
    nested.replace('args =', 'enabled_tools = ["brain_prepare"]\nargs ='),
    nested + 'EXTRA = "x"\n',
    nested.replace('/synthetic/shim', '/synthetic/other'),
    nested.replace("['/synthetic/mcp.cjs']", "['/synthetic/mcp.cjs', '--other']"),
    nested.replace("EB_AGENT_ID = 'synthetic'", "EB_AGENT_ID = 'different'"),
    nested.replace('fixture-generation', 'different-generation'),
    nested.replace("EB_AGENT_ID = 'synthetic'", 'EB_AGENT_ID = 12'),
    nested + 'EB_HOST_VARIANT = "codex-cli"\n',
    nested.replace("EB_ACTIVITY_GENERATION_TOKEN = 'fixture-generation'\n", ''),
  ])('rejects actual settings, type, identity or generation changes', source => {
    expect(['different', 'unverifiable']).toContain(compareCodexMcpSemantics(expected, source, selector).kind);
  });

  it.each([
    nested.replace(`[${selector}.env]`, `[mcp_servers.other]\ncommand="other"\n[${selector}.env]`),
    nested.replace(`[${selector}]`, '[mcp_servers."tidemind-synthetic"]'),
    `${nested}[${selector}]\ncommand="duplicate"\n`,
    `[mcp_servers]\ntidemind-synthetic = {command="/synthetic/shim",args=["/synthetic/mcp.cjs"]}\n`,
    nested.replace(`[${selector}.env]`, `[${selector}.nested]`),
    '[invalid',
  ])('rejects malformed or unproven selector boundaries', source => {
    expect(['unverifiable', 'different']).toContain(compareCodexMcpSemantics(expected, source, selector).kind);
  });

  it('does not accept legacy missing host-variant or token as an equivalent bound entry', () => {
    const bound = expected.replace('EB_AGENT_ID =', 'EB_HOST_VARIANT = "codex-cli", EB_AGENT_ID =');
    expect(compareCodexMcpSemantics(bound, nested, selector).kind).toBe('different');
    expect(compareCodexMcpSemantics(expected, nested, 'mcp_servers.other').kind).toBe('unverifiable');
  });

  it('does not expose parser excerpts, environment values or private content in an error', () => {
    const result = compareCodexMcpSemantics(expected, `${nested}secret = "private-fixture`, selector);
    expect(result).toEqual({ kind: 'unverifiable', reason: 'invalid_document' });
  });

  it('ignores header-looking text inside strings and permits equivalent comments', () => {
    const doc = `note = """\n[${selector}]\nnot a table\n"""\n${nested.replace('args =', '# fixture comment\nargs =')}`;
    expect(compareCodexMcpSemantics(expected, doc, selector).kind).toBe('equivalent');
  });
});
