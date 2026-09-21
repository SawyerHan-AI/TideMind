import { createHash } from 'node:crypto';
import type { DigestOutput } from './types.js';

/**
 * Stable, non-secret proof phrase emitted only by the managed OpenCode V2
 * instruction.  The MCP server records V2 brain_prepare activity only when
 * this exact phrase is returned by the host, so an unrelated/manual prepare
 * call cannot be promoted into instruction-recognition evidence.
 */
export const OPENCODE_V2_INSTRUCTION_PREPARE_PROBE =
  'tidemind:opencode-v2:managed-instruction-loaded:v1';

export function shouldRecordMcpActivity(input: {
  hostVariant: string | null;
  signalName: 'brain_prepare' | 'brain_recall' | 'brain_digest';
  instructionProbe?: string;
}): boolean {
  if (input.hostVariant !== 'opencode-v2-beta-cli' || input.signalName !== 'brain_prepare') {
    return true;
  }
  return input.instructionProbe === OPENCODE_V2_INSTRUCTION_PREPARE_PROBE;
}

/**
 * A completed MCP exchange is not proof that brain_digest changed durable
 * state.  Only the two success states returned after the digest pipeline has
 * accepted or synchronously applied work may mint memory-write activity.
 */
export function digestResultProducedActivity(
  result: DigestOutput,
): result is DigestOutput & { status: 'accepted' | 'processed' } {
  return result.status === 'accepted' || result.status === 'processed';
}

export function matchesExpectedInstructionSha256(
  content: string,
  expectedSha256: string | null,
): boolean {
  if (expectedSha256 === null) return true;
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) return false;
  return createHash('sha256').update(content).digest('hex') === expectedSha256;
}
