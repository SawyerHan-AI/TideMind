import { getRuntimeDiagnosticContext, loadConfig, ensureDataDirs } from './config.js';
import { getDb, closeDb } from './db/connection.js';
import { assertDiagnosticBridge, isDiagnosticRequested, type ValidatedDiagnosticContext } from './agent-diagnostic-contract.js';
import { diagnosticContent, recordDiagnosticHook } from './agent-diagnostic-receipts.js';
import { writeHookOutput, type HookEventName } from './hook-output.js';
export { isDiagnosticRequested };

/** Early hook path: never read a transcript, personal Skill, restore store, or normal profile. */
export async function handleDiagnosticHook(operation: 'session_start' | 'pre_compact' | 'post_compact' | 'session_end', args: {
  agentId: string | null | undefined; activityGenerationToken: string | null | undefined; tool: string;
}, eventName?: HookEventName): Promise<boolean> {
  if (!isDiagnosticRequested()) return false;
  const context = getRuntimeDiagnosticContext();
  if (!context) throw new Error('agent_diagnostic:credential_required');
  const caller = { agentId: args.agentId ?? '', activityGenerationToken: args.activityGenerationToken ?? '' };
  assertDiagnosticBridge(context, { ...caller, componentKey: 'lifecycle', operation });
  loadConfig(); ensureDataDirs();
  try {
    const content = operation === 'session_start' ? `Tide Mind isolated diagnostic. Use only the supplied synthetic nonce: ${context.nonce}. No personal memory is loaded.` : '';
    if (operation !== 'session_end') await writeHookOutput(content, args.tool, eventName);
    recordDiagnosticHook(getDb(), context, caller, operation);
  } finally { closeDb(); }
  return true;
}
export function diagnosticPrompt(context: Pick<ValidatedDiagnosticContext, 'nonce'>): string {
  return `Check this existing Tide Mind connection in its isolated diagnostic domain. Do not use any other tool. Call brain_digest with exactly {"content":${JSON.stringify(diagnosticContent(context))},"async":false}. After it returns status "processed", call brain_recall with only the returned node_id. Then stop. Do not store anything else. Do not call a tool more than four times.`;
}
