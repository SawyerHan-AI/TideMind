import { assertDiagnosticBridge, isDiagnosticRequested } from './agent-diagnostic-contract.js';
import { getRuntimeDiagnosticContext } from './config.js';
import { assertDiagnosticDatabase } from './agent-diagnostic-receipts.js';
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
  keepDatabaseOpen?: boolean;
}): BridgeRejectionReason | null {
  if (!isDiagnosticRequested() && (!input.agentId?.trim() || !input.activityGenerationToken?.trim())) return null;
  let retained = false;
  try {
    loadConfig();
    ensureDataDirs();
    if (isDiagnosticRequested()) {
      const context = getRuntimeDiagnosticContext();
      if (!context) throw new Error('agent_diagnostic:credential_required');
      assertDiagnosticBridge(context, { agentId: input.agentId ?? '', activityGenerationToken: input.activityGenerationToken ?? '', componentKey: 'lifecycle' });
      assertDiagnosticDatabase(getDb(), context);
      retained = input.keepDatabaseOpen === true;
      return null;
    }
    const admission = evaluateBridgeAdmission(getDb(), { ...input, componentKey: 'lifecycle' });
    if (admission.allowed) {
      retained = input.keepDatabaseOpen === true;
      return null;
    }
    process.stderr.write(`[eb:${input.scope}] Tide Mind bridge refused memory for this Agent — ${admission.reason}\n`);
    return admission.reason;
  } catch (error) {
    process.stderr.write(`[eb:${input.scope}] bridge guard unavailable — ${error instanceof Error ? error.message : String(error)}\n`);
    return 'guard_unavailable';
  } finally {
    if (!retained) { try { closeDb(); } catch { /* ignore */ } }
  }
}
