import {
  gateCodexCapabilities,
  parseCodexFeatureList,
} from '../../../src/llm/cli/gate-codex.js';
import type { CodexCapabilityManifest } from '../../../src/llm/cli/catalogs.js';

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
