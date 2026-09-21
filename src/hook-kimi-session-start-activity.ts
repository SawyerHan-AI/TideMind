#!/usr/bin/env node

/**
 * Kimi Code SessionStart marker.
 *
 * Kimi 0.41.0 executes SessionStart hooks but discards their stdout. Keep this
 * entry point deliberately silent: it records only identity-bound host activity.
 * User-visible context injection remains on UserPromptSubmit.
 */
import { loadConfig, ensureDataDirs } from './config.js';
import { getDb, closeDb } from './db/connection.js';
import { recordHookActivityEvidence } from './db/agent-host-activity.js';
import { getTideMindVersion } from './utils/app-version.js';
import { createLogger } from './utils/logger.js';
import { migrateDataDirIfNeeded } from './utils/migrate-data-dir.js';

const migrationLog = createLogger('migrate');

function parseArgs(): { agentId: string; activityGenerationToken: string } {
  const args = process.argv.slice(2);
  const index = args.indexOf('--agent-id');
  const agentId = index >= 0 ? args[index + 1] ?? '' : '';
  const tokenIndex = args.indexOf('--activity-generation-token');
  const activityGenerationToken = tokenIndex >= 0 ? args[tokenIndex + 1] ?? '' : '';
  if (!agentId.trim()) throw new Error('kimi_session_start_agent_id_missing');
  if (!activityGenerationToken.trim()) throw new Error('kimi_session_start_activity_generation_token_missing');
  return { agentId, activityGenerationToken };
}

function main(): void {
  const { agentId, activityGenerationToken } = parseArgs();
  try {
    migrateDataDirIfNeeded(migrationLog);
    loadConfig();
    ensureDataDirs();
    const result = recordHookActivityEvidence(getDb(), {
      agentId,
      tool: 'kimi-code',
      signalName: 'session_start',
      tideMindVersion: getTideMindVersion(),
      activityGenerationToken,
    });
    if (result.status === 'rejected') {
      process.stderr.write(`[eb:hook-kimi-session-start-activity] activity evidence rejected — ${result.reason}\n`);
      process.exitCode = 2;
    }
  } finally {
    try { closeDb(); } catch { /* best effort */ }
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`[eb:hook-kimi-session-start-activity] fatal error — ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
