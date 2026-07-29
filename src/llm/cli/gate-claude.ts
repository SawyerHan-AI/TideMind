import { createHash } from 'node:crypto';
import { CliLLMError } from './errors.js';

const REQUIRED_CLAUDE_HELP_MARKERS = [
  '-p, --print',
  '--safe-mode',
  '--tools <tools...>',
  'Use "" to disable all tools',
  '--disable-slash-commands',
  '--no-session-persistence',
  '--strict-mcp-config',
  '--output-format <format>',
  '--system-prompt-file',
] as const;

export function gateClaudeCapabilities(evidence: {
  version: string;
  help: string;
  authStatusHelp: string;
}): { fingerprint: string } {
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(evidence.version)) {
    throw new CliLLMError('unsupported_version', 'Claude CLI version is malformed');
  }
  const normalizedHelp = evidence.help.replace(/\s+/g, ' ');
  for (const marker of REQUIRED_CLAUDE_HELP_MARKERS) {
    const present =
      normalizedHelp.includes(marker) ||
      (marker === '--system-prompt-file' && normalizedHelp.includes('--system-prompt[-file]'));
    if (!present) {
      throw new CliLLMError('unsupported_version', `Claude safety capability is missing: ${marker}`, {
        needsUserAction: true,
      });
    }
  }
  if (!evidence.authStatusHelp.includes('--json')) {
    throw new CliLLMError('unsupported_version', 'Claude JSON auth probe is unavailable', {
      needsUserAction: true,
    });
  }
  return {
    fingerprint: createHash('sha256')
      .update(JSON.stringify(evidence))
      .digest('hex'),
  };
}
