import { loadConfig, ensureDataDirs } from './config.js';
import { getDb, closeDb } from './db/connection.js';
import { evaluateBridgeAdmission, type BridgeRejectionReason } from './agent-bridge-guard.js';

/**
 * Hook-side bridge generation guard. Returns the rejection reason when this
 * generation-bound hook must not inject memory (the caller then outputs empty
 * context and records no activity evidence); null keeps the normal path.
 * A database that cannot be opened cannot establish admission for a bound hook.
 * Legacy hooks without a generation token retain their existing path.
 */
export function hookBridgeRejection(input: {
  scope: string;
  agentId: string | null | undefined;
  activityGenerationToken: string | null | undefined;
}): BridgeRejectionReason | null {
  if (!input.agentId?.trim() || !input.activityGenerationToken?.trim()) return null;
  try {
    loadConfig();
    ensureDataDirs();
    const admission = evaluateBridgeAdmission(getDb(), { ...input, componentKey: 'lifecycle' });
    if (admission.allowed) return null;
    process.stderr.write(`[eb:${input.scope}] Tide Mind bridge refused memory for this Agent — ${admission.reason}\n`);
    return admission.reason;
  } catch (error) {
    process.stderr.write(`[eb:${input.scope}] bridge guard unavailable — ${error instanceof Error ? error.message : String(error)}\n`);
    return 'guard_unavailable';
  } finally {
    try { closeDb(); } catch { /* ignore */ }
  }
}
