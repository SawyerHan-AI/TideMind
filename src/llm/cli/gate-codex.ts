import { createHash } from 'node:crypto';
import {
  CODEX_EXECUTION_CONTRACT_VERSION,
  CODEX_FORCED_FEATURE_BOUNDARIES,
  CODEX_REQUIRED_EXEC_HELP,
  CODEX_REQUIRED_PROMPT_INPUT_HELP,
} from './catalogs.js';
import { CliLLMError } from './errors.js';

export interface CodexFeatureState {
  stage: string;
  enabled: boolean;
}

/** Verified Codex inference contract for one CLI generation. */
export interface CodexExecutionContract {
  contractVersion: number;
  cliVersion: string;
  /** Every feature the CLI lists; each is passed as `--disable` on inference. */
  disableFeatures: string[];
  /** Features still enabled after disabling, each with a reviewed external boundary. */
  residualFeatures: string[];
  fingerprint: string;
}

export interface CodexContractEvidence {
  version: string;
  execHelp: string;
  promptInputHelp: string;
  /** `codex features list` with the user's configuration. */
  featuresList: string;
}

export function parseCodexFeatureList(output: string): Map<string, CodexFeatureState> {
  const features = new Map<string, CodexFeatureState>();
  for (const line of output.split(/\r?\n/)) {
    const normalized = line.trim();
    if (!normalized) continue;
    const match = /^([a-z0-9_.]+)\s+(.+?)\s+(true|false)\s*$/.exec(normalized);
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
  if (features.size === 0) {
    throw new CliLLMError('unsupported_version', 'Codex feature list is empty', { needsUserAction: true });
  }
  return features;
}

/**
 * Step 1: static surface checks and the disable set. Version is informational only.
 */
export function planCodexContract(evidence: CodexContractEvidence): { disableFeatures: string[] } {
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(evidence.version)) {
    throw new CliLLMError('unsupported_version', 'Codex CLI version is malformed', { needsUserAction: true });
  }
  for (const flag of CODEX_REQUIRED_EXEC_HELP) {
    if (!evidence.execHelp.includes(flag)) {
      throw new CliLLMError('unsupported_version', `Codex exec capability is missing: ${flag}`, {
        needsUserAction: true,
      });
    }
  }
  for (const marker of CODEX_REQUIRED_PROMPT_INPUT_HELP) {
    if (!evidence.promptInputHelp.includes(marker)) {
      throw new CliLLMError('unsupported_version', `Codex prompt gate is missing: ${marker}`, {
        needsUserAction: true,
      });
    }
  }
  const listed = parseCodexFeatureList(evidence.featuresList);
  // Setting an already-off deprecated flag only makes Codex emit a deprecation error
  // item (P0 real smoke, 0.156.1). Deprecated flags are disabled only if enabled; the
  // effective read-back still catches any that stay on.
  return {
    disableFeatures: [...listed.entries()]
      .filter(([, state]) => state.stage !== 'deprecated' || state.enabled)
      .map(([name]) => name)
      .sort(),
  };
}

/** Build the `--disable` argv for a contract. */
export function codexDisableArgs(disableFeatures: readonly string[]): string[] {
  return disableFeatures.flatMap((feature) => ['--disable', feature]);
}

/**
 * Step 2: verify the effective feature state after applying every disable and the
 * inference overrides. Unreviewed residual features block the channel.
 */
export function verifyCodexContract(
  evidence: CodexContractEvidence,
  disableFeatures: readonly string[],
  effectiveFeaturesList: string,
): CodexExecutionContract {
  const effective = parseCodexFeatureList(effectiveFeaturesList);
  if (effective.get('shell_tool')?.enabled !== false) {
    throw new CliLLMError('unsupported_version', 'Codex shell_tool must be explicitly disabled', { needsUserAction: true });
  }
  const residual = [...effective.entries()]
    .filter(([, state]) => state.enabled)
    .map(([name]) => name)
    .sort();
  const unbounded = residual.filter((name) => !(name in CODEX_FORCED_FEATURE_BOUNDARIES));
  if (unbounded.length > 0) {
    throw new CliLLMError(
      'unsupported_version',
      `Codex has active features that cannot be disabled or constrained: ${unbounded.join(', ')}`,
      { needsUserAction: true },
    );
  }
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({
      contractVersion: CODEX_EXECUTION_CONTRACT_VERSION,
      version: evidence.version,
      disableFeatures,
      residual,
    }))
    .digest('hex');
  return {
    contractVersion: CODEX_EXECUTION_CONTRACT_VERSION,
    cliVersion: evidence.version,
    disableFeatures: [...disableFeatures],
    residualFeatures: residual,
    fingerprint,
  };
}
