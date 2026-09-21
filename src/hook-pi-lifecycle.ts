#!/usr/bin/env node

import { loadConfig, ensureDataDirs } from './config.js';
import { getDb, closeDb } from './db/connection.js';
import { recordHookActivityEvidence } from './db/agent-host-activity.js';
import { getTideMindVersion } from './utils/app-version.js';
import { createLogger } from './utils/logger.js';
import { migrateDataDirIfNeeded } from './utils/migrate-data-dir.js';

const migrationLog = createLogger('migrate');

interface PiLifecycleArgs {
  agentId: string;
  signal: 'session_end';
  activityGenerationToken: string;
}

function parseArgs(): PiLifecycleArgs {
  const args = process.argv.slice(2);
  let agentId = '';
  let signal: PiLifecycleArgs['signal'] | null = null;
  let activityGenerationToken = '';
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--agent-id' && args[index + 1]) {
      agentId = args[index + 1];
      index += 1;
    } else if (args[index] === '--signal' && args[index + 1]) {
      if (args[index + 1] === 'session_end') signal = 'session_end';
      index += 1;
    } else if (args[index] === '--activity-generation-token' && args[index + 1]) {
      activityGenerationToken = args[index + 1];
      index += 1;
    }
  }
  if (!agentId.trim()) throw new Error('pi_lifecycle_agent_id_missing');
  if (!signal) throw new Error('pi_lifecycle_signal_invalid');
  if (!activityGenerationToken.trim()) throw new Error('pi_lifecycle_activity_generation_token_missing');
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
      tool: 'pi',
      signalName: args.signal,
      tideMindVersion: getTideMindVersion(),
      activityGenerationToken: args.activityGenerationToken,
    });
    if (result.status === 'rejected') {
      process.stderr.write(`[eb:hook-pi-lifecycle] activity evidence rejected — ${result.reason}\n`);
      process.exitCode = 2;
    }
  } finally {
    try { closeDb(); } catch { /* best effort */ }
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`[eb:hook-pi-lifecycle] fatal error — ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
