import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  codexDisableArgs,
  parseCodexFeatureList,
  planCodexContract,
  verifyCodexContract,
  type CodexContractEvidence,
} from '../../../src/llm/cli/gate-codex.js';
import {
  CODEX_EXECUTION_CONTRACT_VERSION,
  CODEX_FORCED_FEATURE_BOUNDARIES,
  CODEX_REQUIRED_EXEC_HELP,
} from '../../../src/llm/cli/catalogs.js';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../fixtures/llm-cli/${name}`, import.meta.url)), 'utf8');
}

// Captured with an isolated HOME/CODEX_HOME from OpenAI's official arm64
// rust-v0.153.4 archive (SHA-256
// 8cf911ea676523bfb2121ec561848d2aba564890ad536db4d8a3353f2b9850b1).
const codex01534Features = fixture('codex-0.153.4-features.txt');
// 0.156.1-style reconstruction of the P0 evidence (docs/design/…-p0-cli-evidence-2026-09-25.md §3):
// 149 listed features; after passing --disable for every one of them only item_ids,
// resize_all_images, terminal_resize_reflow, tool_search_always_defer_mcp_tools,
// tui_app_server (removed) and unified_exec (stable, ignores --disable) remain true.
// Names absent from 0.153.4 are synthetic stand-ins for "new upstream features".
const codex01561Features = fixture('codex-0.156.1-features.txt');
const codex01561Disabled = fixture('codex-0.156.1-features-disabled.txt');

const execHelp = [
  'Usage: codex exec [OPTIONS] [PROMPT]',
  '--strict-config',
  '--skip-git-repo-check',
  '--ephemeral',
  '--ignore-user-config',
  '--ignore-rules',
  '--json',
].join('\n');
const promptInputHelp = [
  'Render the model-visible prompt input list as JSON',
  'Usage: codex debug prompt-input [OPTIONS] [PROMPT]',
].join('\n');

function evidence(overrides: Partial<CodexContractEvidence> = {}): CodexContractEvidence {
  return {
    version: '0.156.1',
    execHelp,
    promptInputHelp,
    featuresList: codex01561Features,
    ...overrides,
  };
}

function allDisabled(list: string, keepEnabled: readonly string[] = []): string {
  return [...parseCodexFeatureList(list)]
    .map(([name, state]) => `${name} ${state.stage} ${keepEnabled.includes(name) ? 'true' : 'false'}`)
    .join('\n');
}

describe('Codex feature list parser', () => {
  it('parses rows and rejects malformed, duplicate or empty lists', () => {
    expect(parseCodexFeatureList('shell_tool stable true\napps under development false\n')).toEqual(
      new Map([
        ['shell_tool', { stage: 'stable', enabled: true }],
        ['apps', { stage: 'under development', enabled: false }],
      ]),
    );
    expect(() => parseCodexFeatureList('shell_tool stable true\nunparseable feature row\n'))
      .toThrowError(expect.objectContaining({ kind: 'unsupported_version' }));
    expect(() => parseCodexFeatureList('shell_tool stable true\nshell_tool stable false\n'))
      .toThrowError(expect.objectContaining({ kind: 'unsupported_version' }));
    expect(() => parseCodexFeatureList('\n\n'))
      .toThrowError(expect.objectContaining({ kind: 'unsupported_version' }));
  });

  it('parses the captured fixtures completely', () => {
    expect(parseCodexFeatureList(codex01534Features).size).toBe(135);
    expect(parseCodexFeatureList(codex01561Features).size).toBe(149);
    expect(parseCodexFeatureList(codex01561Disabled).size).toBe(149);
  });
});

describe('planCodexContract (static surface + disable set)', () => {
  it('accepts any well-formed version; the version is informational only', () => {
    for (const version of ['0.153.4', '0.156.1', '0.155.0-alpha.16.4', '1.0.0+build.7', '9.99.999']) {
      expect(() => planCodexContract(evidence({ version })), version).not.toThrow();
    }
  });

  it('rejects malformed versions', () => {
    for (const version of ['', 'latest', '0.156', 'v0.156.1', '0.156.1 ; rm -rf /', '0.156.1\n']) {
      expect(() => planCodexContract(evidence({ version })), JSON.stringify(version))
        .toThrowError(expect.objectContaining({ kind: 'unsupported_version' }));
    }
  });

  it('disables every listed feature (sorted) except already-off deprecated flags', () => {
    const { disableFeatures } = planCodexContract(evidence());
    const listed = [...parseCodexFeatureList(codex01561Features).entries()]
      .filter(([, state]) => state.stage !== 'deprecated' || state.enabled)
      .map(([name]) => name)
      .sort();
    expect(disableFeatures).toEqual(listed);
    expect(disableFeatures.length).toBeGreaterThan(140);
    expect(codexDisableArgs(['a', 'b'])).toEqual(['--disable', 'a', '--disable', 'b']);
  });

  it.each([...CODEX_REQUIRED_EXEC_HELP])('rejects exec help missing %s', (flag) => {
    const help = execHelp.split('\n').filter((line) => line !== flag).join('\n');
    expect(() => planCodexContract(evidence({ execHelp: help })))
      .toThrowError(expect.objectContaining({ kind: 'unsupported_version' }));
  });

  it('rejects a missing prompt-input gate and a malformed feature list', () => {
    expect(() => planCodexContract(evidence({ promptInputHelp: 'Usage: codex debug' })))
      .toThrowError(expect.objectContaining({ kind: 'unsupported_version' }));
    expect(() => planCodexContract(evidence({ featuresList: `${codex01561Features}garbage\n` })))
      .toThrowError(expect.objectContaining({ kind: 'unsupported_version' }));
  });
});

describe('verifyCodexContract (effective state after --disable)', () => {
  it('allows the PTY implementation only behind an explicit disabled shell registration gate', () => {
    const ev = evidence();
    const { disableFeatures } = planCodexContract(ev);
    expect(verifyCodexContract(ev, disableFeatures, codex01561Disabled).residualFeatures).toContain('unified_exec');
    for (const effective of [
      allDisabled(codex01561Features, ['unified_exec', 'shell_tool']),
      codex01561Disabled.split('\n').filter(line => !line.startsWith('shell_tool ')).join('\n'),
    ]) {
      expect(() => verifyCodexContract(ev, disableFeatures, effective))
        .toThrowError(expect.objectContaining({ message: expect.stringContaining('shell_tool') }));
    }
  });

  it('blocks an unreviewed feature that stays enabled after --disable', () => {
    const ev = evidence();
    const { disableFeatures } = planCodexContract(ev);
    // shell_tool was listed and disabled but is still active: nothing constrains it.
    const effective = allDisabled(codex01561Features, ['unified_exec', 'shell_tool']);
    expect(() => verifyCodexContract(ev, disableFeatures, effective))
      .toThrowError(expect.objectContaining({
        kind: 'unsupported_version',
        message: expect.stringContaining('shell_tool'),
      }));
    // A brand-new name (not in the reviewed snapshot) that stays enabled also blocks.
    const withNew = `${allDisabled(codex01561Features)}\nbrand_new_agent_tool stable true\n`;
    expect(() => verifyCodexContract(ev, disableFeatures, withNew))
      .toThrowError(expect.objectContaining({ message: expect.stringContaining('brand_new_agent_tool') }));
  });

  it('ignores unreviewed names once they are effectively disabled', () => {
    const ev = evidence();
    const { disableFeatures } = planCodexContract(ev);
    // image_generation_tool / hooks_v2 are unreviewed (0.156.1-only) and enabled by default,
    // but the effective read-back shows them disabled: no block, no residual.
    expect(parseCodexFeatureList(codex01561Features).get('hooks_v2')?.enabled).toBe(true);
    const contract = verifyCodexContract(ev, disableFeatures, allDisabled(codex01561Features, ['item_ids']));
    expect(contract.residualFeatures).not.toContain('hooks_v2');
    expect(contract.residualFeatures).not.toContain('image_generation_tool');
  });

  it('rejects a malformed effective list and changes the fingerprint with the residual set', () => {
    const ev = evidence();
    const { disableFeatures } = planCodexContract(ev);
    expect(() => verifyCodexContract(ev, disableFeatures, 'not a feature row'))
      .toThrowError(expect.objectContaining({ kind: 'unsupported_version' }));
    const a = verifyCodexContract(ev, disableFeatures, allDisabled(codex01561Features, ['item_ids']));
    const b = verifyCodexContract(ev, disableFeatures, allDisabled(codex01561Features, []));
    const c = verifyCodexContract({ ...ev, version: '0.156.2' }, disableFeatures, allDisabled(codex01561Features, ['item_ids']));
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(c.fingerprint);
    expect(verifyCodexContract(ev, disableFeatures, allDisabled(codex01561Features, ['item_ids'])).fingerprint).toBe(a.fingerprint);
  });
});

describe('Codex contract: deprecated flags', () => {
  it('does not disable already-off deprecated flags (they only emit deprecation errors), but disables enabled ones', async () => {
    const { planCodexContract } = await import('../../../src/llm/cli/gate-codex.js');
    const plan = planCodexContract({
      version: '0.156.1',
      execHelp: '--ignore-user-config --ignore-rules --ephemeral --json --skip-git-repo-check --strict-config',
      promptInputHelp: 'prompt-input',
      featuresList: [
        'hooks                stable        true',
        'web_search_cached    deprecated    false',
        'legacy_on            deprecated    true',
        'item_ids             removed       true',
      ].join('\n'),
    });
    expect(plan.disableFeatures).toEqual(['hooks', 'item_ids', 'legacy_on']);
  });
});
