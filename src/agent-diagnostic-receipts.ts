import type Database from 'better-sqlite3';
import path from 'node:path';
import { AgentDiagnosticError, assertDiagnosticBridge, diagnosticHash, type DiagnosticOperation, type ValidatedDiagnosticContext } from './agent-diagnostic-contract.js';
import type { DigestOutput, RecallOutput } from './types.js';

export const DIAGNOSTIC_TOOL_LIMIT = 4;
export const DIAGNOSTIC_RECEIPT_KEY = 'agent_diagnostic_receipt';
export const diagnosticContent = (context: Pick<ValidatedDiagnosticContext, 'nonce'>): string => `Tide Mind isolated connection check: ${context.nonce}`;
export const diagnosticToolMarker = (context: Pick<ValidatedDiagnosticContext, 'runId' | 'nonce'>): string => `[TIDEMIND_DIAGNOSTIC_V1:${context.runId}:${context.nonce}]`;
export const diagnosticServerName = (context: Pick<ValidatedDiagnosticContext, 'runId' | 'nonce'>): string => `tidemind-diagnostic-v1:${context.runId}:${context.nonce}`;
export const DIAGNOSTIC_TOOL_DESCRIPTIONS = {
  brain_prepare: 'Read minimal synthetic context for this isolated connection check.',
  brain_digest: 'Store exactly the diagnostic nonce text supplied by the controller. Returns a completed write and node ID.',
  brain_recall: 'Read the diagnostic node using the exact node_id returned by brain_digest.',
};
export type DiagnosticReceiptContext = Pick<ValidatedDiagnosticContext, 'runId' | 'nonce' | 'databasePath'>
  & { binding: Pick<ValidatedDiagnosticContext['binding'], 'configurationVersion'> };
export interface DiagnosticReceipt {
  protocolVersion: 1; runId: string; nonce: string; configurationVersion: string;
  toolCalls: number; prepared: boolean;
  writtenNodeId: string | null; writeTraceId: string | null; writtenContentHash: string | null; writeCompletedAt: string | null;
  readNodeId: string | null; readContentHash: string | null; readCompletedAt: string | null;
  hooks: string[]; failureCode: string | null;
}
export interface DiagnosticCaller { agentId: string; activityGenerationToken: string }
const fail = (code: string): never => { throw new AgentDiagnosticError(code); };
export function assertDiagnosticDatabase(db: Database.Database, context: DiagnosticReceiptContext): void {
  if (path.resolve(db.name) !== context.databasePath) fail('business_database_mismatch');
}
function empty(context: DiagnosticReceiptContext): DiagnosticReceipt {
  return { protocolVersion: 1, runId: context.runId, nonce: context.nonce, configurationVersion: context.binding.configurationVersion,
    toolCalls: 0, prepared: false, writtenNodeId: null, writeTraceId: null, writtenContentHash: null, writeCompletedAt: null,
    readNodeId: null, readContentHash: null, readCompletedAt: null, hooks: [], failureCode: null };
}
export function readDiagnosticReceipt(db: Database.Database, context: DiagnosticReceiptContext): DiagnosticReceipt {
  assertDiagnosticDatabase(db, context);
  const row = db.prepare('SELECT value FROM metadata WHERE key=?').get(DIAGNOSTIC_RECEIPT_KEY) as { value: string } | undefined;
  if (!row) return empty(context);
  let value: DiagnosticReceipt;
  try { value = JSON.parse(row.value) as DiagnosticReceipt; } catch { return fail('receipt_invalid'); }
  if (value.protocolVersion !== 1 || value.runId !== context.runId || value.nonce !== context.nonce
    || value.configurationVersion !== context.binding.configurationVersion || !Number.isSafeInteger(value.toolCalls)
    || value.toolCalls < 0 || !Array.isArray(value.hooks)) return fail('receipt_invalid');
  return value;
}
function update(db: Database.Database, context: ValidatedDiagnosticContext, change: (value: DiagnosticReceipt) => void): DiagnosticReceipt {
  return db.transaction(() => {
    const value = readDiagnosticReceipt(db, context); change(value);
    db.prepare('INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(DIAGNOSTIC_RECEIPT_KEY, JSON.stringify(value));
    return value;
  }).immediate();
}
function authorize(context: ValidatedDiagnosticContext, caller: DiagnosticCaller, operation: DiagnosticOperation): void {
  assertDiagnosticBridge(context, { ...caller, componentKey: operation.startsWith('brain_') ? 'memory_tools' : 'lifecycle', operation });
}
/** Called at tools/call transport admission, before SDK input validation or business handlers. */
export function countDiagnosticToolCall(db: Database.Database, context: ValidatedDiagnosticContext, caller: DiagnosticCaller, tool: unknown): void {
  assertDiagnosticBridge(context, { ...caller, componentKey: 'memory_tools' });
  const value = update(db, context, receipt => {
    receipt.toolCalls += 1;
    if (receipt.toolCalls > DIAGNOSTIC_TOOL_LIMIT) receipt.failureCode = 'tool_limit';
    if (!['brain_prepare','brain_digest','brain_recall'].includes(String(tool))) receipt.failureCode = 'unexpected_tool';
  });
  if (value.failureCode) fail(value.failureCode);
  authorize(context, caller, tool as DiagnosticOperation);
}
/** The diagnostic contract cannot ask normal recall/prepare to inspect an external file or mutate another node. */
export function validateDiagnosticInput(db: Database.Database, context: ValidatedDiagnosticContext, caller: DiagnosticCaller,
  tool: 'brain_prepare' | 'brain_recall' | 'brain_digest', params: unknown): void {
  authorize(context, caller, tool); assertDiagnosticDatabase(db, context);
  if (!params || typeof params !== 'object' || Array.isArray(params)) fail('diagnostic_input_invalid');
  const input = params as Record<string, unknown>;
  if (tool === 'brain_prepare') {
    if ((input.files !== undefined && (!Array.isArray(input.files) || input.files.length))
      || (input.hint !== undefined && input.hint !== '')) fail('diagnostic_input_invalid');
  } else if (tool === 'brain_digest') {
    if (readDiagnosticReceipt(db, context).writtenNodeId) fail('diagnostic_duplicate_write');
    if (input.content !== diagnosticContent(context) || (input.intent !== undefined && input.intent !== 'new')
      || input.target_node !== undefined || input.target_link !== undefined || input.source !== undefined) fail('diagnostic_input_invalid');
  } else {
    const receipt = readDiagnosticReceipt(db, context);
    if (!receipt.writtenNodeId || input.node_id !== receipt.writtenNodeId
      || Object.keys(input).some(key => !['node_id','mode','limit','match','depth'].includes(key))
      || (input.mode !== undefined && input.mode !== 'detail')) fail('diagnostic_readback_requires_node_id');
  }
}
export function completeDiagnosticPrepare(db: Database.Database, context: ValidatedDiagnosticContext, caller: DiagnosticCaller): void {
  authorize(context, caller, 'brain_prepare'); update(db, context, value => { value.prepared = true; });
}
export function completeDiagnosticDigest(db: Database.Database, context: ValidatedDiagnosticContext, caller: DiagnosticCaller, output: DigestOutput): void {
  authorize(context, caller, 'brain_digest');
  const node = output.created_nodes?.[0];
  if (output.status !== 'processed' || !output.trace_id || output.created_nodes?.length !== 1 || !node
    || node.content !== diagnosticContent(context)) return fail('diagnostic_write_incomplete');
  const stored = db.prepare('SELECT content FROM nodes WHERE id=? AND archived=0').get(node.id) as { content: string } | undefined;
  if (stored?.content !== diagnosticContent(context)) fail('diagnostic_write_not_stored');
  update(db, context, value => {
    if (value.writtenNodeId) fail('diagnostic_duplicate_write');
    value.writtenNodeId = node.id; value.writeTraceId = output.trace_id!;
    value.writtenContentHash = diagnosticHash(stored!.content); value.writeCompletedAt = new Date().toISOString();
  });
}
export function completeDiagnosticRecall(db: Database.Database, context: ValidatedDiagnosticContext, caller: DiagnosticCaller, output: RecallOutput): void {
  authorize(context, caller, 'brain_recall');
  const receipt = readDiagnosticReceipt(db, context);
  const node = output.nodes.find(node => node.id === receipt.writtenNodeId);
  if (!node || !('content' in node) || node.content !== diagnosticContent(context)) return fail('diagnostic_readback_mismatch');
  const nodeId = node.id, content = node.content;
  update(db, context, value => {
    value.readNodeId = nodeId; value.readContentHash = diagnosticHash(content); value.readCompletedAt = new Date().toISOString();
  });
}
export function recordDiagnosticHook(db: Database.Database, context: ValidatedDiagnosticContext, caller: DiagnosticCaller,
  operation: 'session_start' | 'pre_compact' | 'post_compact' | 'session_end'): void {
  authorize(context, caller, operation);
  update(db, context, value => { if (!value.hooks.includes(operation)) value.hooks.push(operation); });
}
/** Controller-side readback after the child has finished; this does not revive an expired capability. */
export function verifyDiagnosticReceipt(db: Database.Database, context: DiagnosticReceiptContext): DiagnosticReceipt {
  const receipt = readDiagnosticReceipt(db, context);
  if (receipt.failureCode || receipt.toolCalls > DIAGNOSTIC_TOOL_LIMIT || !receipt.writeTraceId || !receipt.writtenNodeId
    || receipt.readNodeId !== receipt.writtenNodeId || !receipt.writeCompletedAt || !receipt.readCompletedAt
    || Date.parse(receipt.readCompletedAt) < Date.parse(receipt.writeCompletedAt)
    || receipt.writtenContentHash !== diagnosticHash(diagnosticContent(context)) || receipt.readContentHash !== receipt.writtenContentHash) fail('diagnostic_receipt_incomplete');
  const node = db.prepare('SELECT content FROM nodes WHERE id=? AND archived=0').get(receipt.writtenNodeId) as { content: string } | undefined;
  if (node?.content !== diagnosticContent(context)) fail('diagnostic_receipt_node_missing');
  return receipt;
}
