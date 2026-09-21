import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  gateCodexCapabilities,
  parseCodexFeatureList,
} from '../../../src/llm/cli/gate-codex.js';
import {
  CODEX_CAPABILITY_MANIFESTS,
  type CodexCapabilityManifest,
} from '../../../src/llm/cli/catalogs.js';

const codex01534Features = readFileSync(fileURLToPath(new URL(
  '../../fixtures/llm-cli/codex-0.153.4-features.txt',
  import.meta.url,
)), 'utf8');

// Captured with an isolated HOME/CODEX_HOME from OpenAI's official arm64
// rust-v0.153.4 archive (SHA-256
// 8cf911ea676523bfb2121ec561848d2aba564890ad536db4d8a3353f2b9850b1).
// Keep the complete feature output above and the safety-bearing help rows below
// as the reviewed contract.
const codex01534ExecHelp = [
  'Usage: codex exec [OPTIONS] [PROMPT]',
  '--strict-config',
  '--skip-git-repo-check',
  '--ephemeral',
  '--ignore-user-config',
  '--ignore-rules',
  '--json',
].join('\n');
const codex01534PromptInputHelp = [
  'Render the model-visible prompt input list as JSON',
  'Usage: codex debug prompt-input [OPTIONS] [PROMPT]',
].join('\n');

const manifest: CodexCapabilityManifest = {
  version: '1.2.3',
  requiredExecHelp: ['--ignore-user-config', '--json'],
  requiredPromptInputHelp: ['prompt-input'],
  knownFeatures: {
    shell_tool: { stage: 'stable', enabled: true },
    apps: { stage: 'stable', enabled: false },
  },
  disableFeatures: ['shell_tool', 'apps'],
};

describe('Codex capability gate', () => {
  const evidence = {
    version: '1.2.3',
    execHelp: 'options --ignore-user-config --json',
    promptInputHelp: 'debug prompt-input',
    featuresList: 'shell_tool stable true\napps stable false\n',
  };

  it('accepts an exact reviewed snapshot', () => {
    expect(parseCodexFeatureList(evidence.featuresList)).toEqual(
      new Map([
        ['shell_tool', { stage: 'stable', enabled: true }],
        ['apps', { stage: 'stable', enabled: false }],
      ]),
    );
    expect(gateCodexCapabilities(evidence, [manifest]).fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('accepts the real official 0.153.4 capability contract', () => {
    const result = gateCodexCapabilities({
      version: '0.153.4',
      execHelp: codex01534ExecHelp,
      promptInputHelp: codex01534PromptInputHelp,
      featuresList: codex01534Features,
    });

    expect(result.manifest.version).toBe('0.153.4');
    expect([...result.manifest.disableFeatures].sort()).toEqual(
      [...parseCodexFeatureList(codex01534Features)]
        .filter(([, state]) => state.enabled)
        .map(([name]) => name)
        .sort(),
    );
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(CODEX_CAPABILITY_MANIFESTS.map(candidate => candidate.version))
      .toContain('0.153.4');
  });

  it('rejects versions, flags, and feature snapshot drift', () => {
    expect(() => gateCodexCapabilities({ ...evidence, version: '1.2.4' }, [manifest])).toThrow();
    expect(() => gateCodexCapabilities({ ...evidence, execHelp: '--json' }, [manifest])).toThrow();
    expect(() => gateCodexCapabilities({
      ...evidence,
      featuresList: `${evidence.featuresList}browser_use stable true\n`,
    }, [manifest])).toThrowError(expect.objectContaining({ kind: 'unsupported_version' }));
    expect(() => gateCodexCapabilities({
      ...evidence,
      featuresList: 'shell_tool experimental true\napps stable false\n',
    }, [manifest])).toThrowError(expect.objectContaining({ kind: 'unsupported_version' }));
    expect(() => gateCodexCapabilities({
      ...evidence,
      featuresList: 'shell_tool stable false\napps stable false\n',
    }, [manifest])).toThrowError(expect.objectContaining({ kind: 'unsupported_version' }));
    expect(() => gateCodexCapabilities({
      ...evidence,
      featuresList: `${evidence.featuresList}unparseable feature row\n`,
    }, [manifest])).toThrowError(expect.objectContaining({ kind: 'unsupported_version' }));
    expect(() => gateCodexCapabilities({
      ...evidence,
      featuresList: `${evidence.featuresList}shell_tool stable true\n`,
    }, [manifest])).toThrowError(expect.objectContaining({ kind: 'unsupported_version' }));
  });
});
