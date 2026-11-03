#!/usr/bin/env node
import { SqliteRepository } from './db/sqlite-repository.js';
import { prepare } from './tools/prepare.js';
import { formatCodexRestoredContext } from './hook-brief-context.js';
import { writeHookOutput, writeSerializedHookOutput } from './hook-output.js';
import { codexRestoreInput, openCodexRestoreRuntime, readCodexHookPayload } from './hook-codex-restore-runtime.js';
import type { ContextRestoreClaim } from './hook-codex-context-restore.js';

let outputStarted = false;
async function empty(): Promise<void> {
  outputStarted = true;
  await writeSerializedHookOutput('{}');
}
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? '' : args[index + 1] ?? ''; };
  if (value('--tool') !== 'codex') throw new Error('codex_restore_tool_invalid');
  const input = codexRestoreInput(await readCodexHookPayload(), 'UserPromptSubmit');
  if (!input) { process.stderr.write('[eb:codex-restore] input_invalid\n'); await empty(); return; }
  const runtime = openCodexRestoreRuntime(value('--agent-id'), value('--activity-generation-token'), input.sessionId);
  let claim: ContextRestoreClaim | null = null;
  try {
    if (!runtime.admitted()) { await empty(); return; }
    claim = runtime.store.claimPending(runtime.scope, input.turnId);
    if (!claim) { await empty(); return; }
    const result = await prepare(new SqliteRepository(runtime.db), {
      tool: 'codex', agent_id: runtime.scope.agentId, detail_level: 'brief',
    }, { readOnly: true });
    const content = formatCodexRestoredContext(result);
    if (!runtime.admitted() || !runtime.store.canEmit(runtime.scope, claim)) { await empty(); return; }
    outputStarted = true;
    await writeHookOutput(content, 'codex', 'UserPromptSubmit');
    if (runtime.admitted()) runtime.store.markEmitted(runtime.scope, claim);
  } finally {
    try { if (claim) runtime.store.releaseClaim(runtime.scope, claim); }
    finally { runtime.close(); }
  }
}
void main().catch(async () => {
  // Do not include input, memory, paths or credentials in diagnostics.
  process.stderr.write('[eb:codex-restore] restore_unavailable\n');
  if (!outputStarted) {
    try { await empty(); } catch { process.stderr.write('[eb:codex-restore] output_failed\n'); }
  }
});
