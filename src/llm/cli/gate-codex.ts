import { createHash } from 'node:crypto';
import { CODEX_CAPABILITY_MANIFESTS, type CodexCapabilityManifest } from './catalogs.js';
import { CliLLMError } from './errors.js';

export interface CodexCapabilityEvidence {
  version: string;
  execHelp: string;
  promptInputHelp: string;
  featuresList: string;
}

export interface CodexCapabilityGateResult {
  manifest: CodexCapabilityManifest;
  fingerprint: string;
}

export interface CodexFeatureState {
  stage: string;
  enabled: boolean;
}

export function parseCodexFeatureList(output: string): Map<string, CodexFeatureState> {
  const features = new Map<string, CodexFeatureState>();
  for (const line of output.split(/\r?\n/)) {
    const normalized = line.trim();
    if (!normalized) continue;
    const match = /^([a-z0-9_]+)\s+(.+?)\s+(true|false)\s*$/.exec(normalized);
    if (!match) {
      throw new CliLLMError('unsupported_version', 'Codex feature list contains an unrecognized row', {
        needsUserAction: true,
      });
    }
    if (features.has(match[1])) {
      throw new CliLLMError('unsupported_version', `Codex feature list contains a duplicate: ${match[1]}`, {
        needsUserAction: true,
      });
    }
    features.set(match[1], { stage: match[2].trim(), enabled: match[3] === 'true' });
  }
  return features;
}

export function gateCodexCapabilities(
  evidence: CodexCapabilityEvidence,
  manifests: readonly CodexCapabilityManifest[] = CODEX_CAPABILITY_MANIFESTS,
): CodexCapabilityGateResult {
  const manifest = manifests.find((candidate) => candidate.version === evidence.version);
  if (!manifest) {
    throw new CliLLMError('unsupported_version', `Unsupported Codex CLI version: ${evidence.version}`, {
      needsUserAction: true,
    });
  }
  for (const flag of manifest.requiredExecHelp) {
    if (!evidence.execHelp.includes(flag)) {
      throw new CliLLMError('unsupported_version', `Codex exec capability is missing: ${flag}`, {
        needsUserAction: true,
      });
    }
  }
  for (const marker of manifest.requiredPromptInputHelp) {
    if (!evidence.promptInputHelp.includes(marker)) {
      throw new CliLLMError('unsupported_version', `Codex prompt gate is missing: ${marker}`, {
        needsUserAction: true,
      });
    }
  }
  const actual = parseCodexFeatureList(evidence.featuresList);
  const expectedNames = Object.keys(manifest.knownFeatures).sort();
  const actualNames = [...actual.keys()].sort();
  if (
    expectedNames.length !== actualNames.length ||
    expectedNames.some((name, index) => name !== actualNames[index])
  ) {
    const unknownActive = actualNames.filter(
      (name) => !(name in manifest.knownFeatures) && actual.get(name)?.enabled === true,
    );
    throw new CliLLMError(
      'unsupported_version',
      unknownActive.length > 0
        ? `Codex has unclassified active features: ${unknownActive.join(', ')}`
        : 'Codex feature snapshot changed',
      { needsUserAction: true },
    );
  }
  for (const [name, expected] of Object.entries(manifest.knownFeatures)) {
    const state = actual.get(name);
    if (!state || state.stage !== expected.stage || state.enabled !== expected.enabled) {
      throw new CliLLMError(
        'unsupported_version',
        `Codex feature state changed: ${name}`,
        { needsUserAction: true },
      );
    }
  }
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({
      version: evidence.version,
      execHelp: evidence.execHelp,
      promptInputHelp: evidence.promptInputHelp,
      features: [...actual.entries()].map(([name, state]) => [name, state.stage, state.enabled]),
    }))
    .digest('hex');
  return { manifest, fingerprint };
}
