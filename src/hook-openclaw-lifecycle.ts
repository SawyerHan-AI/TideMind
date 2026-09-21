#!/usr/bin/env node

import { loadConfig, ensureDataDirs } from './config.js';
import { getDb, closeDb } from './db/connection.js';
import { recordHookActivityEvidence } from './db/agent-host-activity.js';
import { getTideMindVersion } from './utils/app-version.js';
import { createLogger } from './utils/logger.js';
import { migrateDataDirIfNeeded } from './utils/migrate-data-dir.js';

const migrationLog = createLogger('migrate');

type OpenClawLifecycleSignal = 'session_start' | 'pre_compact' | 'post_compact' | 'session_end';

function parseArgs(): { agentId: string; signal: OpenClawLifecycleSignal; activityGenerationToken: string } {
  const args = process.argv.slice(2);
  let agentId = '';
  let signal: OpenClawLifecycleSignal | null = null;
  let activityGenerationToken = '';
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--agent-id' && args[index + 1]) {
      agentId = args[index + 1];
      index += 1;
    } else if (args[index] === '--signal' && args[index + 1]) {
      if (['session_start', 'pre_compact', 'post_compact', 'session_end'].includes(args[index + 1])) {
        signal = args[index + 1] as OpenClawLifecycleSignal;
      }
      index += 1;
    } else if (args[index] === '--activity-generation-token' && args[index + 1]) {
      activityGenerationToken = args[index + 1];
      index += 1;
    }
  }
  if (!agentId.trim()) throw new Error('openclaw_lifecycle_agent_id_missing');
  if (!signal) throw new Error('openclaw_lifecycle_signal_invalid');
  if (!activityGenerationToken.trim()) throw new Error('openclaw_lifecycle_activity_generation_token_missing');
  return { agentId, signal, activityGenerationToken };
}

function main(): void {
  const args = parseArgs();
  try {
    migrateDataDirIfNeeded(migrationLog);
    loadConfig();
    ensureDataDirs();
    const result = recordHookActivityEvidence(getDb(), {
      agentId: args.agentId,
      tool: 'openclaw',
      signalName: args.signal,
      tideMindVersion: getTideMindVersion(),
      activityGenerationToken: args.activityGenerationToken,
    });
    if (result.status === 'rejected') {
      process.stderr.write(`[eb:hook-openclaw-lifecycle] activity evidence rejected — ${result.reason}\n`);
      process.exitCode = 2;
    }
  } finally {
    try { closeDb(); } catch { /* best effort */ }
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`[eb:hook-openclaw-lifecycle] fatal error — ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
